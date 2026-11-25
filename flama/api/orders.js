// Panel de pedidos: GET lista, POST cambia estado y avisa al cliente
import { listOrders, getOrder, saveOrder, ESTADOS } from "../lib/orders.js";
import { sendToClient, STATUS_MSG } from "../lib/notify.js";

export default async function handler(req, res) {
  const key = process.env.PANEL_KEY || "flama2026";
  if (req.query.key !== key) return res.status(401).json({ error: "Clave incorrecta" });
  if (req.method === "POST") {
    const { id, estado } = req.body || {};
    const o = await getOrder(String(id));
    if (!o || !ESTADOS[estado]) return res.status(400).json({ error: "Pedido o estado inválido" });
    const antes = o.estado;
    o.estado = estado;
    if (antes === "pago_a_verificar" && estado === "en_preparacion") o.pagoVerificadoPor = "local";
    await saveOrder(o);
    if (STATUS_MSG[estado]) await sendToClient(o.chat, STATUS_MSG[estado](o));
  }
  res.json({ estados: ESTADOS, orders: await listOrders() });
}
