// Panel de pedidos: GET lista, POST cambia estado y avisa al cliente
import { listOrders, getOrder, saveOrder, panelState, sumarCaja, contarCancelado, cajaHoy, ESTADOS } from "../lib/orders.js";
import { sendToClient, STATUS_MSG } from "../lib/notify.js";
import { redis } from "../lib/redis.js";

export default async function handler(req, res) {
  const key = process.env.PANEL_KEY || "flama2026";
  if (req.query.key !== key) return res.status(401).json({ error: "Clave incorrecta" });
  if (req.method === "POST" && req.body?.bot) {
    await redis.set("flama:bot_off", req.body.bot === "off" ? "1" : "0");
    return res.json(await panelState());
  } else if (req.method === "POST") {
    const { id, estado } = req.body || {};
    const o = await getOrder(String(id));
    if (!o || !ESTADOS[estado]) return res.status(400).json({ error: "Pedido o estado inválido" });
    const antes = o.estado;
    o.estado = estado;
    if (antes === "pago_a_verificar" && estado === "en_preparacion") o.pagoVerificadoPor = "local";
    // La caja cuenta el pedido cuando se entrega; si después se cancela, se descuenta
    if (estado === "entregado" && !o.enCaja) { o.enCaja = true; await sumarCaja(o, 1); }
    if (estado === "cancelado") { if (o.enCaja) { o.enCaja = false; await sumarCaja(o, -1); } await contarCancelado(o); }
    await saveOrder(o);
    if (STATUS_MSG[estado]) await sendToClient(o.chat, STATUS_MSG[estado](o));
  }
  const st = await panelState();
  // Si el panel ya tiene esta versión, no se releen los pedidos (1 comando por consulta)
  if (req.method === "GET" && req.query.v === st.ver) return res.json({ ...st, same: true });
  res.json({ ...st, estados: ESTADOS, orders: await listOrders(), caja: await cajaHoy() });
}
