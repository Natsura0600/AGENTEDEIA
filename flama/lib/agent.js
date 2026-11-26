import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { redis } from "./redis.js";
import { systemPrompt } from "./prompt.js";
import { LOCAL, ZONAS, BEBIDAS, abierto, calcular, getMenu } from "./menu.js";
import { sincronizarStock } from "./stock.js";
import { nextId, saveOrder, activeOrder, claimOperation, jornada, ESTADOS } from "./orders.js";

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
    order.comprobante = { datos: v.datos, motivos: v.motivos, imagen: image.length < 900000 ? `data:${mediaType || "image/jpeg"};base64,${image}` : null };
    if (v.ok) {
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
  } else if (image) {
    nota = "[SISTEMA: el cliente mandó una imagen, pero no hay un pedido esperando pago.]";
  }

  const userContent = [
    historial.length === 0 && name ? `[Nombre de perfil: ${name}]` : "",
    text || (image ? "(envió una imagen)" : ""),
    nota,
  ].filter(Boolean).join("\n");
  const messages = [...historial, { role: "user", content: userContent }];

  const result = await generateText({
    model: MODEL,
    providerOptions: fast,
    instructions: systemPrompt(isOpen, menu),
    messages,
    stopWhen: stepCountIs(4),
    prepareStep: ({ stepNumber }) => (esPedidoWeb && stepNumber === 0 ? { toolChoice: { type: "tool", toolName: "crear_pedido" } } : {}),
    tools: {
      crear_pedido: tool({
        description: "Crea o actualiza el pedido del cliente con todos los ítems y calcula el total real. Usar cuando ya están los productos, el tipo de entrega (y zona/dirección si es envío) y el nombre.",
        inputSchema: z.object({
          items: z.array(z.object({
            id: z.enum(["cheese-burger", "cheese-2", "all-american", "cuarto-de-kilo", "big-magia", "oklahoma", "rocket", "anderson", "sliders", ...BEBIDAS.map((b) => b.id)]),
            tamano: z.enum(["simple", "doble"]).optional(),
            cantidad: z.number().int().min(1).default(1),
            extras: z.array(z.enum(["extra-carne", "extra-bacon"])).optional().describe("Un elemento por unidad: 2 extra carne = ['extra-carne','extra-carne']"),
            veggie: z.boolean().optional(),
            nota: z.string().optional(),
          })),
          entrega: z.enum(["retiro", "envio"]),
          zona: z.enum(ZONAS.map((z) => z.id)).optional(),
          direccion: z.string().optional(),
          nombre: z.string(),
          comentarios: z.string().optional(),
        }),
        execute: async (i) => {
          let calc;
          try { calc = calcular(i.items, i.entrega, i.zona, menu); } catch (e) { return { error: e.message }; }
          const prev = await activeOrder(chat);
          const reuse = prev && prev.estado === "pago_pendiente" && Date.now() - (prev.updatedAt || prev.createdAt) < VIEJO && prev.jornada === jornada();
          const o = {
            id: reuse ? prev.id : await nextId(),
            chat, createdAt: reuse ? prev.createdAt : Date.now(), updatedAt: Date.now(), jornada: reuse ? prev.jornada : jornada(),
            ...(reuse ? { _saved: true } : {}),
            nombre: i.nombre, telefono: chat.startsWith("wa:") ? chat.slice(3) : null,
            entrega: i.entrega, zona: i.zona || null, direccion: i.direccion || null,
            lineas: calc.lineas, envio: calc.envio, total: calc.total, items: i.items, canal: chat.startsWith("wa:") ? "whatsapp" : "web",
            comentarios: i.comentarios || "", estado: "pago_pendiente", paraMasTarde: !isOpen,
          };
          await saveOrder(o);
          return { pedido: o.id, detalle: calc.lineas.map((l) => `${l.texto}: ${money(l.subtotal)}`), envio: money(calc.envio), total: money(calc.total), alias: LOCAL.alias, titular: LOCAL.titular };
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

  const answer = result.text.trim() || "Perdón, no te entendí. ¿Me lo repetís?";
  await saveHistory(chat, [...messages, { role: "assistant", content: answer }]);
  return answer;
}
