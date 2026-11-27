import { URL_PUBLICA } from "./notify.js";
import { randomBytes } from "node:crypto";
import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { redis } from "./redis.js";
import { systemPrompt } from "./prompt.js";
import { LOCAL, abierto, calcular, getMenu } from "./menu.js";
import { sincronizarStock } from "./stock.js";
import { detectarZona } from "./geo.js";
import { nextId, saveOrder, activeOrder, getOrder, claimOperation, jornada, ESTADOS, conCandado, guardarComprobante } from "./orders.js";

const MODEL = process.env.AI_MODEL || "openai/gpt-5-mini";
const fast = { openai: { reasoningEffort: "minimal" } };
const money = (n) => "$" + Number(n).toLocaleString("es-AR");

async function getHistory(chat) {
  try { return JSON.parse((await redis.get(`flama:hist:${chat}`)) || "[]"); } catch { return []; }
}
async function saveHistory(chat, msgs) {
  await redis.set(`flama:hist:${chat}`, JSON.stringify(msgs.slice(-24)), { ex: 60 * 60 * 24 * 3 });
}

// ---------- Verificación del comprobante con IA ----------
export async function leerComprobante(imageBase64, mediaType = "image/jpeg") {
  const r = await generateText({
    model: MODEL,
    providerOptions: fast,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: `Analizá esta imagen. Respondé SOLO un JSON con estas claves:
{"es_comprobante": boolean (true si es un comprobante de transferencia o pago de un banco o billetera),
 "monto": number (monto transferido en pesos, sin separadores; null si no se ve),
 "destinatario": string (nombre del destinatario o titular de la cuenta destino; null si no se ve),
 "alias_o_cvu": string (alias, CVU o CBU destino si aparece; null si no),
 "fecha": "YYYY-MM-DD" (fecha de la operación; null si no se ve),
 "numero_operacion": string (número de operación, transacción o comprobante; null si no se ve)}` },
        { type: "file", data: imageBase64, mediaType: mediaType || "image/jpeg" },
      ],
    }],
  });
  const m = r.text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : { es_comprobante: false };
}

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

export async function verificarComprobante(order, imageBase64, mediaType) {
  const c = await leerComprobante(imageBase64, mediaType).catch((e) => ({ error: e.message }));
  const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
  const motivos = [];
  if (!c.es_comprobante) motivos.push("la imagen no parece un comprobante");
  if (c.es_comprobante && !(Number(c.monto) >= order.total)) motivos.push(`el monto (${c.monto ? money(c.monto) : "no se ve"}) no cubre el total ${money(order.total)}`);
  const dest = norm(c.destinatario) + norm(c.alias_o_cvu);
  const titulares = [LOCAL.titular, ...(process.env.TITULARES_EXTRA || "").split("|")].filter(Boolean);
  const okTitular = titulares.some((t) => t.split(/\s+/).every((w) => dest.includes(norm(w))));
  if (c.es_comprobante && !(okTitular || dest.includes(norm(LOCAL.alias)))) motivos.push("el destinatario no coincide con el alias o titular de Flama");
  if (c.es_comprobante && c.fecha && c.fecha !== hoy) motivos.push(`la fecha (${c.fecha}) no es de hoy`);
  if (c.es_comprobante && !c.numero_operacion) motivos.push("no se ve el número de operación");
  if (!motivos.length && !(await claimOperation(c.numero_operacion, order.id))) motivos.push("ese comprobante ya se usó en otro pedido");
  return { ok: motivos.length === 0, motivos, datos: c };
}

// ---------- Conversación ----------
export const botApagado = async () => (await redis.get("flama:bot_off")) === "1";

export async function reply({ chat, text, image, mediaType, name }) {
  let aprobado = false;
  const history = await getHistory(chat);
  const isOpen = process.env.RESPETAR_HORARIO === "1" ? abierto() : true; // demo: siempre abierto
  const VIEJO = 3 * 3600e3;
  const menu = await getMenu();
  const esPedidoWeb = /quiero hacer este pedido:/i.test(text || "");
  let order = await activeOrder(chat);
  // Un pedido que quedó esperando pago hace horas no se mezcla con uno nuevo
  if (order && order.estado === "pago_pendiente" && Date.now() - (order.updatedAt || order.createdAt) > VIEJO) order = null;
  // Pedido nuevo armado en la web: arranca una conversación limpia
  let historial = history;
  if (esPedidoWeb) historial = [];
  const detalle = (o) => `Pedido #${o.id}: ${o.lineas.map((l) => l.texto).join(", ")}. ${o.entrega === "envio" ? "Delivery" : "Retiro en el local"}. Total ${money(o.total)}.`;
  let nota = "";

  // Si manda una imagen y hay un pedido esperando pago → verificar comprobante
  if (image && order && order.estado === "pago_pendiente") {
    const v = await verificarComprobante(order, image, mediaType);
    // La imagen se guarda aparte: el panel la baja solo cuando alguien la abre
    const conImg = image.length < 900000;
    if (conImg) await guardarComprobante(order.id, `data:${mediaType || "image/jpeg"};base64,${image}`);
    await conCandado(order.id, async () => {
      const actual = await getOrder(order.id);
      if (actual && actual.estado !== "pago_pendiente") { order = actual; v.ok = false; v.yaCambio = true; return; } // el local ya lo movió a mano
      order = actual || order;
      order.comprobante = { datos: v.datos, motivos: v.motivos, imagen: conImg };
    if (v.ok) {
      aprobado = true;
      order.estado = isOpen ? "en_preparacion" : "programado";
      order.pagoVerificadoPor = "bot";
      nota = isOpen
        ? `[SISTEMA: comprobante APROBADO por el bot. ${detalle(order)} Pasó a cocina. Confirmalo al cliente nombrando EXACTAMENTE estos productos (no otros de mensajes anteriores) y la demora (${order.entrega === "envio" ? LOCAL.demoras.envio : LOCAL.demoras.retiro}).]`
        : `[SISTEMA: comprobante APROBADO. ${detalle(order)} El local está cerrado: queda confirmado para cuando abra (${LOCAL.horarioTexto}). Avisale al cliente nombrando exactamente estos productos.]`;
    } else {
      order.estado = "pago_a_verificar";
      nota = `[SISTEMA: ${detalle(order)} El comprobante quedó para revisión manual del local (${v.motivos.join("; ")}). Decile al cliente, amablemente, que el local lo revisa y le confirma en unos minutos. Si el problema es claro (por ejemplo el monto), explicáselo.]`;
    }
      await sincronizarStock(order);
      await saveOrder(order);
    });
    if (v.yaCambio) nota = `[SISTEMA: ${detalle(order)} El local ya actualizó este pedido (${ESTADOS[order.estado]}). Agradecele el comprobante.]`;
  } else if (image) {
    nota = "[SISTEMA: el cliente mandó una imagen, pero no hay un pedido esperando pago.]";
  }
  // Estado real del pedido en cada mensaje: si el local lo cambió desde el panel, el bot lo sabe
  if (!nota && order && !esPedidoWeb) {
    nota = `[SISTEMA: estado ACTUAL de ${detalle(order)} → ${ESTADOS[order.estado] || order.estado}.${["pago_pendiente", "pago_a_verificar"].includes(order.estado) ? "" : " El pago ya está confirmado: no pidas comprobante ni digas que falta confirmar."}${order.seg && !["pago_pendiente", "pago_a_verificar"].includes(order.estado) ? ` Link de seguimiento: ${URL_PUBLICA}/pedido/${order.seg}` : ""} Si esto contradice lo que dijiste antes, vale esto.]`;
  }

  const limpio = String(text || "").slice(0, 1500).replace(/\[\s*(SISTEMA|SYSTEM)[^\]]*\]?/gi, "(texto quitado)");
  const userContent = [
    historial.length === 0 && name ? `[Nombre de perfil: ${String(name).slice(0, 40).replace(/[\[\]]/g, "")}]` : "",
    limpio || (image ? "(envió una imagen)" : ""),
    nota,
  ].filter(Boolean).join("\n");
  const messages = [...historial, { role: "user", content: userContent }];

  const result = await generateText({
    model: MODEL,
    providerOptions: fast,
    instructions: systemPrompt(isOpen, menu),
    messages,
    stopWhen: stepCountIs(4),
    maxOutputTokens: 700,
    abortSignal: AbortSignal.timeout(45000),
    prepareStep: ({ stepNumber }) => (esPedidoWeb && stepNumber === 0 ? { toolChoice: { type: "tool", toolName: "crear_pedido" } } : {}),
    tools: {
      crear_pedido: tool({
        description: "Crea o actualiza el pedido del cliente con todos los ítems y calcula el total real. Usar cuando ya están los productos, el tipo de entrega (y zona/dirección si es envío) y el nombre.",
        inputSchema: z.object({
          items: z.array(z.object({
            id: z.string().describe("El [id: ...] del producto, tal cual figura en el menú"),
            tamano: z.enum(["simple", "doble"]).optional(),
            cantidad: z.number().int().min(1).default(1),
            extras: z.array(z.string()).optional().describe("ids de extras, uno por unidad: 2 extra carne = ['extra-carne','extra-carne']"),
            veggie: z.boolean().optional(),
            nota: z.string().optional(),
          })),
          entrega: z.enum(["retiro", "envio"]),
          zona: z.string().optional().describe("Solo si crear_pedido no encontró la dirección: [id: ...] de la zona según el barrio que dijo el cliente"),
          direccion: z.string().optional().describe("Calle y número como lo escribió el cliente (y entre qué calles o barrio si lo dijo)"),
          nombre: z.string(),
          comentarios: z.string().optional(),
        }),
        execute: async (i) => {
          // Envío: la zona sale de la dirección (km al local), no de lo que elija el modelo
          let geo = null, zonaAConfirmar = false;
          if (i.entrega === "envio") {
            if (!i.direccion?.trim()) return { error: "Falta la dirección: pedile al cliente calle y número." };
            try { geo = await detectarZona(i.direccion, menu); } catch (e) { console.warn("geo", e.message); }
            if (geo?.encontrada && geo.fuera) return { error: `Esa dirección queda a ${String(geo.km).replace(".", ",")} km del local y el delivery llega hasta ${String(geo.maxKm).replace(".", ",")} km. Avisale al cliente y ofrecé retiro en el local (${LOCAL.direccion}).` };
            if (geo?.encontrada && geo.zona) { i.zona = geo.zona.id; zonaAConfirmar = !geo.exacta; }
            else if (i.zona && menu.zonas.some((z) => z.id === i.zona)) zonaAConfirmar = true;
            else return { error: "No encontré esa dirección en Luján. Pedile al cliente que revise calle y número, o que te diga el barrio, y volvé a llamar a crear_pedido (con la zona según el barrio si sigue sin aparecer)." };
          }
          let calc;
          try { calc = calcular(i.items, i.entrega, i.zona, menu); } catch (e) { return { error: e.message }; }
          const prev = await activeOrder(chat);
          const reuse = prev && prev.estado === "pago_pendiente" && Date.now() - (prev.updatedAt || prev.createdAt) < VIEJO && prev.jornada === jornada();
          const o = {
            id: reuse ? prev.id : await nextId(),
            chat, createdAt: reuse ? prev.createdAt : Date.now(), updatedAt: Date.now(), jornada: reuse ? prev.jornada : jornada(),
            ...(reuse ? { _saved: true } : {}),
            nombre: String(i.nombre || "").slice(0, 40), telefono: chat.startsWith("wa:") ? chat.slice(3) : null,
            entrega: i.entrega, zona: i.entrega === "envio" ? i.zona : null, direccion: i.direccion ? String(i.direccion).slice(0, 160) : null,
            zonaNombre: i.entrega === "envio" ? menu.zonas.find((z) => z.id === i.zona)?.nombre || null : null,
            geo: geo?.encontrada ? { km: geo.km, lat: geo.lat, lng: geo.lng, texto: geo.texto, exacta: geo.exacta, fuente: geo.fuente } : null,
            zonaAConfirmar,
            lineas: calc.lineas, envio: calc.envio, total: calc.total, items: calc.items, canal: chat.startsWith("wa:") ? "whatsapp" : "web",
            comentarios: String(i.comentarios || "").slice(0, 300), estado: "pago_pendiente", paraMasTarde: !isOpen,
            seg: (reuse && prev.seg) || randomBytes(12).toString("base64url"), hist: reuse ? prev.hist : [], // link privado de seguimiento
          };
          await saveOrder(o);
          return {
            pedido: o.id, detalle: calc.lineas.map((l) => `${l.texto}: ${money(l.subtotal)}`), envio: money(calc.envio), total: money(calc.total), alias: LOCAL.alias, titular: LOCAL.titular,
            ...(o.zonaNombre ? { zona: o.zonaNombre, distancia: geo?.encontrada ? `${String(geo.km).replace(".", ",")} km` : "sin verificar (la confirma el local)" } : {}),
          };
        },
      }),
      estado_pedido: tool({
        description: "Consulta el estado del último pedido del cliente.",
        inputSchema: z.object({}),
        execute: async () => {
          const o = await activeOrder(chat);
          return o ? { pedido: o.id, estado: ESTADOS[o.estado] || o.estado, total: money(o.total) } : { pedido: null };
        },
      }),
    },
  });

  let answer = result.text.trim() || "Perdón, no te entendí. ¿Me lo repetís?";
  // Pago aprobado: va el link de seguimiento en este mismo mensaje (así no hacen falta más avisos)
  if (aprobado && order?.seg) answer += `\n\n📍 Seguí tu pedido en vivo acá: ${URL_PUBLICA}/pedido/${order.seg}`;
  await saveHistory(chat, [...messages, { role: "assistant", content: answer }]);
  return answer;
}
