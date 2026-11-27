import { createHmac, timingSafeEqual } from "node:crypto";
import { URL_PUBLICA } from "./notify.js";

export const mercadoPagoConfigurado = () => Boolean(process.env.MP_ACCESS_TOKEN && process.env.MP_WEBHOOK_SECRET && process.env.MP_COLLECTOR_ID);

async function mp(path, options = {}) {
  const response = await fetch("https://api.mercadopago.com" + path, {
    signal: AbortSignal.timeout(5000),
    ...options,
    headers: { Authorization: "Bearer " + process.env.MP_ACCESS_TOKEN, "Content-Type": "application/json" },
  });
  if (!response.ok) throw new Error("Mercado Pago respondió " + response.status);
  return response.json();
}

export async function crearLink(o) {
  const preference = await mp("/checkout/preferences", {
    method: "POST",
    body: JSON.stringify({
      items: [{ id: o.id, title: "Pedido FLAMA #" + o.id, quantity: 1, currency_id: "ARS", unit_price: o.total }],
      external_reference: o.mp.referencia,
      notification_url: URL_PUBLICA + "/api/mercado-pago?source_news=webhooks",
      back_urls: { success: URL_PUBLICA + "/pedido/" + o.seg, pending: URL_PUBLICA + "/pedido/" + o.seg, failure: URL_PUBLICA + "/pedido/" + o.seg },
      expires: true,
      expiration_date_to: new Date(o.mp.vence).toISOString(),
    }),
  });
  const url = new URL(preference.init_point);
  if (url.origin !== "https://www.mercadopago.com.ar") throw new Error("Link de pago inválido");
  return url.href;
}

export function firmaValida(signature, requestId, id) {
  if (!signature || !requestId || !id) return false;
  const fields = new URLSearchParams(signature.replaceAll(",", "&").replace(/&\s+/g, "&"));
  const ts = fields.get("ts") || "";
  const hash = fields.get("v1") || "";
  if (!/^\d{10,13}$/.test(ts) || !/^[a-f\d]{64}$/i.test(hash)) return false;
  const mac = createHmac("sha256", process.env.MP_WEBHOOK_SECRET)
    .update(`id:${id};request-id:${requestId};ts:${ts};`).digest();
  return timingSafeEqual(mac, Buffer.from(hash, "hex"));
}

export const consultarPago = (id) => mp("/v1/payments/" + encodeURIComponent(id));

export function pagoCoincide(pago, pedido, id) {
  return String(pago.id) === id && pago.status === "approved" &&
    String(pago.collector_id) === process.env.MP_COLLECTOR_ID &&
    pago.currency_id === "ARS" && pago.transaction_amount === pedido.total &&
    pago.external_reference === pedido.mp?.referencia;
}
