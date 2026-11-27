// Envía mensajes al cliente por el canal que corresponda: WhatsApp (API oficial) o el chat de prueba web
import { redis } from "./redis.js";

export async function sendToClient(chat, text) {
  if (chat.startsWith("web:")) {
    // Lista de Redis: agregar es 1 comando y no se pisa si llegan dos avisos juntos
    const k = `flama:ob:${chat}`;
    if ((await redis.rpush(k, JSON.stringify({ text, at: Date.now() }))) === 1) await redis.expire(k, 86400);
    return;
  }
  if (!process.env.WHATSAPP_TOKEN) return console.warn("WhatsApp no configurado");
  const res = await fetch(`https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    signal: AbortSignal.timeout(10000),
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: chat.replace(/^wa:/, ""), type: "text", text: { body: text.slice(0, 4000) } }),
  });
  if (!res.ok) console.error("WhatsApp error", res.status, await res.text());
}

export async function takeOutbox(chat) {
  const k = `flama:ob:${chat}`;
  const q = await redis.lrange(k, 0, 49);
  if (q.length) await redis.del(k);
  return q.map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
}

export const URL_PUBLICA = (process.env.PUBLIC_URL || "https://flama-demo.vercel.app").replace(/\/$/, "");
export const linkSeguimiento = (o) => (o.seg ? `${URL_PUBLICA}/pedido/${o.seg}` : null);
// Cuando el local confirma el pago a mano: siempre se avisa (con el link), porque el cliente está esperando eso
export const PAGO_CONFIRMADO = (o) => `¡Pago confirmado${o.nombre ? ", " + String(o.nombre).split(" ")[0] : ""}! ✅ Tu pedido #${o.id} ${o.estado === "programado" ? "queda confirmado para cuando abramos" : "ya está en la cocina 🔥"}.` + (linkSeguimiento(o) ? `\n\n📍 Seguí tu pedido en vivo acá: ${linkSeguimiento(o)}` : "");
export const STATUS_MSG = {
  en_preparacion: (o) => `¡Listo, ${o.nombre}! Tu pedido #${o.id} ya está en preparación 🔥`,
  listo: (o) => `Tu pedido #${o.id} ya está listo para retirar en Mitre 670. ¡Te esperamos!`,
  en_camino: (o) => `Tu pedido #${o.id} salió para ${o.direccion}. En un ratito llega 🛵`,
  entregado: (o) => `¡Gracias por pedir en Flama, ${o.nombre}! Que lo disfrutes.`,
  cancelado: (o) => `Tu pedido #${o.id} fue cancelado. Si tenés dudas, escribinos por acá.`,
};
