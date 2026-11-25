// Envía mensajes al cliente por el canal que corresponda: WhatsApp (API oficial) o el chat de prueba web
import { redis } from "./redis.js";

export async function sendToClient(chat, text) {
  if (chat.startsWith("web:")) {
    let q = [];
    try { q = JSON.parse((await redis.get(`flama:outbox:${chat}`)) || "[]"); } catch {}
    q.push({ text, at: Date.now() });
    await redis.set(`flama:outbox:${chat}`, JSON.stringify(q), { ex: 86400 });
    return;
  }
  const res = await fetch(`https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: chat.replace(/^wa:/, ""), type: "text", text: { body: text.slice(0, 4000) } }),
  });
  if (!res.ok) console.error("WhatsApp error", res.status, await res.text());
}

export async function takeOutbox(chat) {
  const key = `flama:outbox:${chat}`;
  let q = [];
  try { q = JSON.parse((await redis.get(key)) || "[]"); } catch {}
  if (q.length) await redis.del(key);
  return q;
}

export const STATUS_MSG = {
  en_preparacion: (o) => `¡Listo, ${o.nombre}! Tu pedido #${o.id} ya está en preparación 🔥`,
  listo: (o) => `Tu pedido #${o.id} ya está listo para retirar en Mitre 670. ¡Te esperamos!`,
  en_camino: (o) => `Tu pedido #${o.id} salió para ${o.direccion}. En un ratito llega 🛵`,
  entregado: (o) => `¡Gracias por pedir en Flama, ${o.nombre}! Que lo disfrutes.`,
  cancelado: (o) => `Tu pedido #${o.id} fue cancelado. Si tenés dudas, escribinos por acá.`,
};
