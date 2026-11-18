// Instagram API oficial (Instagram Login). El token se guarda en Redis y se renueva solo cada día.
import { redis } from "./wa.js";

const API = "https://graph.instagram.com/v23.0";

export async function getToken() {
  return (await redis.get("ig:token")) || process.env.INSTAGRAM_TOKEN;
}

export async function sendDM(recipientId, text) {
  const token = await getToken();
  const parts = [];
  // Instagram acepta hasta 1000 caracteres por mensaje: se corta por párrafos
  let buf = "";
  for (const p of text.split("\n\n")) {
    if ((buf + "\n\n" + p).length > 950 && buf) { parts.push(buf); buf = p; }
    else buf = buf ? `${buf}\n\n${p}` : p;
  }
  if (buf) parts.push(buf.slice(0, 1000));

  for (const part of parts) {
    const res = await fetch(`${API}/me/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text: part } }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) console.error("Instagram API error", res.status, JSON.stringify(data));
    if (data.message_id) await redis.set(`igsent:${data.message_id}`, "1", { ex: 86400 });
  }
}

export async function typing(recipientId, on = true) {
  const token = await getToken();
  await fetch(`${API}/me/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: recipientId }, sender_action: on ? "typing_on" : "typing_off" }),
  }).catch(() => {});
}

export async function getProfile(userId) {
  const token = await getToken();
  const res = await fetch(`${API}/${userId}?fields=username,name`, { headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? res.json() : {};
}

export async function refreshToken() {
  const token = await getToken();
  if (!token) return { ok: false, reason: "Sin token" };
  const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`);
  const data = await res.json();
  if (data.access_token) {
    await redis.set("ig:token", data.access_token);
    return { ok: true, expiresInDays: Math.round(data.expires_in / 86400) };
  }
  return { ok: false, error: data };
}

// Avisos que viajan de Instagram a tu WhatsApp (los manda el cron de WhatsApp)
export const queueNotify = (text) => redis.rpush("notify:queue", text);
