// WhatsApp Cloud API (oficial de Meta)
import { redis } from "./redis.js";
const API = "https://graph.facebook.com/v23.0";

async function call(body) {
  const res = await fetch(`${API}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) console.error("WhatsApp API error", res.status, JSON.stringify(data));
  return data;
}

// Cada mensaje que manda el bot queda anotado, así se distingue de los que mandás vos desde el celular
export async function sendText(to, text) {
  const data = await call({ to, type: "text", text: { body: text.slice(0, 4000) } });
  const id = data?.messages?.[0]?.id;
  if (id) await redis.set(`botmsg:${id}`, "1", { ex: 172800 });
  return data;
}
// Marca como leído y muestra "escribiendo…"
export const markRead = (id) => call({ status: "read", message_id: id, typing_indicator: { type: "text" } });
