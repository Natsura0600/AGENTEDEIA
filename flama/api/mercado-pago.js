import { mercadoPagoConfigurado, firmaValida, consultarPago, pagoCoincide } from "../lib/mercado-pago.js";
import { conCandado, getOrder, saveOrder } from "../lib/orders.js";
import { abierto } from "../lib/menu.js";
import { sincronizarStock } from "../lib/stock.js";
import { sendToClient, PAGO_CONFIRMADO } from "../lib/notify.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (!mercadoPagoConfigurado()) return res.status(503).end();
  const id = String(req.query["data.id"] ?? "");
  if (!/^\d+$/.test(id) || !firmaValida(req.headers["x-signature"], req.headers["x-request-id"], id)) return res.status(401).end();
  try {
    const pago = await consultarPago(id);
    const pedidoId = /^(\d+):[\w-]{24}$/.exec(pago.external_reference)?.[1];
    if (!pedidoId || pago.status !== "approved") return res.status(200).end();
    const confirmado = await conCandado(pedidoId, async () => {
      const o = await getOrder(pedidoId);
      if (!o || o.estado !== "pago_pendiente" || !pagoCoincide(pago, o, id)) return null;
      o.pago = "mercado_pago";
      o.pagoVerificadoPor = "mercado_pago";
      o.mp.pagoId = id;
      o.estado = process.env.RESPETAR_HORARIO === "1" && !abierto() ? "programado" : "en_preparacion";
      await sincronizarStock(o);
      await saveOrder(o);
      return o;
    });
    if (confirmado) await sendToClient(confirmado.chat, PAGO_CONFIRMADO(confirmado)).catch(() => console.warn("No se pudo enviar el aviso de pago"));
    return res.status(200).end();
  } catch {
    return res.status(503).end();
  }
}
