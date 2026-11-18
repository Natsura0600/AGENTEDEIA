const API = "https://graph.facebook.com/v23.0";

async function call(body) {
  const res = await fetch(`${API}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });
  if (!res.ok) console.error("WhatsApp API error", res.status, await res.text());
  return res.ok;
}

export const sendText = (to, text) => call({ to, type: "text", text: { body: text.slice(0, 4000) } });
export const markRead = (id) => call({ status: "read", message_id: id, typing_indicator: { type: "text" } });
