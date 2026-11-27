// Panel de empleados (y del dueño): pedidos del día, cambios de estado, venta de mostrador.
// Consumo: si nada cambió, 1 comando por consulta. Si cambió, baja solo los pedidos que cambiaron.
import { listOrders, cambiosDesde, getOrder, saveOrder, sumarCaja, contarCancelado, nextId, jornada, ESTADOS, conCandado, avisos, leerComprobanteImg } from "../lib/orders.js";
import { sendToClient, STATUS_MSG, PAGO_CONFIRMADO } from "../lib/notify.js";
import { sincronizarStock, bajos } from "../lib/stock.js";
import { getMenu, calcular } from "../lib/menu.js";
import { redis } from "../lib/redis.js";
import { autorizar, ipDe, BLOQUEO } from "../lib/auth.js";

const parse = (v) => { try { return JSON.parse(v); } catch { return null; } };

export default async function handler(req, res) {
  const body = (req.method === "POST" && req.body && typeof req.body === "object") ? req.body : {};

  if (req.method === "GET") {
    const [v, off, bl, stock] = await redis.mget("flama:ver", "flama:bot_off", BLOQUEO(ipDe(req)), "flama:stock");
    const quien = await autorizar(req, res, "local", { bloqueo: bl });
    if (!quien) return;
    // Imagen de un comprobante (se pide solo al abrirla)
    if (req.query.comp) return res.json({ img: await leerComprobanteImg(String(req.query.comp).replace(/\D/g, "").slice(0, 12)) });
    const ver = String(v || 0), j = jornada(), botOn = off !== "1";
    const stockBajo = bajos(parse(stock) || {});
    const cv = req.query.v, cj = req.query.j, desde = Number(req.query.desde) || 0;
    if (cv === ver && cj === j) return res.json({ same: true, ver, botOn, stockBajo });
    const ahora = Date.now();
    // Incremental solo si el panel ya tenía la jornada y la versión no volvió atrás (después de un borrado)
    const incremental = cv && cj === j && desde > 0 && Number(cv) <= Number(ver) && !req.query.full;
    const orders = incremental ? await cambiosDesde(j, desde) : await listOrders(j);
    return res.json({ ver, botOn, stockBajo, jornada: j, desde: ahora, full: !incremental, rol: quien, ...(incremental ? {} : { estados: ESTADOS }), orders });
  }
  if (req.method !== "POST") return res.status(405).end();
  const quien = await autorizar(req, res, "local");
  if (!quien) return;

  if (body.bot) {
    await redis.set("flama:bot_off", body.bot === "off" ? "1" : "0");
    return res.json({ ok: true, botOn: body.bot !== "off" });
  }

  // Venta de mostrador: ya está cobrada, entra directo a cocina y descuenta stock.
  if (body.mostrador) {
    const { items, pago, nombre } = body.mostrador;
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Agregá al menos un producto" });
    let calc;
    try { calc = calcular(items, "retiro", null, await getMenu()); } catch (e) { return res.status(400).json({ error: e.message }); }
    const o = {
      id: await nextId(), chat: "local:mostrador", canal: "mostrador", createdAt: Date.now(), jornada: jornada(),
      nombre: String(nombre || "").trim().slice(0, 40) || "Mostrador", entrega: "local", lineas: calc.lineas, envio: 0, total: calc.total, items: calc.items,
      pago: ["efectivo", "transferencia", "tarjeta"].includes(pago) ? pago : "efectivo", estado: "en_preparacion", pagoVerificadoPor: "local",
    };
    await sincronizarStock(o);
    await saveOrder(o);
    return res.json({ ok: true, id: o.id, total: o.total });
  }

  const id = String(body.id || "").replace(/\D/g, "").slice(0, 12), estado = String(body.estado || "");
  if (!id || !ESTADOS[estado]) return res.status(400).json({ error: "Pedido o estado inválido" });
  try {
    const r = await conCandado(id, async () => {
      const o = await getOrder(id);
      if (!o) return { error: "Ese pedido ya no existe", status: 404 };
      const antes = o.estado;
      if (antes === estado) return { o, igual: true };
      const pagoManual = ["pago_pendiente", "pago_a_verificar"].includes(antes) && ["en_preparacion", "programado"].includes(estado);
      if (o.mp && antes === "pago_pendiente" && estado !== "cancelado") return { error: "Este pago lo confirma Mercado Pago", status: 409 };
      o.estado = estado;
      if (["pago_pendiente", "pago_a_verificar"].includes(antes) && ["en_preparacion", "programado"].includes(estado) && !o.pagoVerificadoPor) o.pagoVerificadoPor = "local";
      if (antes === "pago_a_verificar" && estado === "en_preparacion") o.pagoVerificadoPor = "local";
      // La caja cuenta el pedido cuando se entrega; si después se cancela, se descuenta
      if (estado === "entregado" && !o.enCaja) { o.enCaja = true; await sumarCaja(o, 1); }
      if (estado === "cancelado") { if (o.enCaja) { o.enCaja = false; await sumarCaja(o, -1); } await contarCancelado(o); }
      await sincronizarStock(o);
      await saveOrder(o);
      return { o, pagoManual };
    });
    if (r.error) return res.status(r.status).json({ error: r.error });
    if (r.pagoManual && !String(r.o.chat).startsWith("local:")) await sendToClient(r.o.chat, PAGO_CONFIRMADO(r.o));
    else if (!r.igual && STATUS_MSG[estado] && !String(r.o.chat).startsWith("local:") && (await avisos())[estado]) await sendToClient(r.o.chat, STATUS_MSG[estado](r.o));
    res.json({ ok: true, estado });
  } catch (e) { res.status(409).json({ error: e.message }); }
}
