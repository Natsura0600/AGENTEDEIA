// Webhook de WhatsApp (API oficial): Meta avisa cada mensaje y el bot responde al instante.
// No hay cron ni conexión abierta: la función solo corre cuando llega un mensaje.
import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { reply, classify } from "../lib/agent.js";
import { sendText, markRead } from "../lib/whatsapp.js";
import { isPaused, pause, resume } from "../lib/store.js";
import { redis } from "../lib/redis.js";
import { queueNotify } from "../lib/instagram.js";
import { sendEmail } from "../lib/email.js";

export const config = { api: { bodyParser: false }, maxDuration: 60 };

const digits = (s) => String(s || "").replace(/\D/g, "");
// Números que el bot nunca contesta (familia, amigos…), separados por coma en BOT_OFF_NUMBERS
const blocked = () => (process.env.BOT_OFF_NUMBERS || "").split(",").map(digits).filter(Boolean);
const isOff = async (phone) =>
  blocked().some((b) => phone.endsWith(b.slice(-10))) || Boolean(await redis.get(`off:${phone}`));

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
function validSignature(raw, header) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true;
  if (!header) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

// Comandos que escribís VOS (desde la app de WhatsApp Business con coexistencia, o desde OWNER_PHONE):
//   /bot off            → en el chat de un cliente: el bot nunca más contesta ese chat
//   /bot on             → lo vuelve a activar
//   /bot off 549...     → desde tu número personal (OWNER_PHONE) al bot
async function command(text, chatPhone) {
  const [, cmd, target] = text.trim().split(/\s+/);
  const phone = digits(target) || chatPhone;
  if (!phone) return false;
  if (cmd === "apagar") { await redis.set("bot:global-off", "1"); return "Bot apagado para TODOS los chats ⏸️ (/bot prender para volver)"; }
  if (cmd === "prender") { await redis.del("bot:global-off"); return "Bot prendido para todos ✅"; }
  if (cmd === "off") { await redis.set(`off:${phone}`, "1"); return `Bot desactivado para ${phone} ⏸️`; }
  if (cmd === "on") { await redis.del(`off:${phone}`); await resume(phone); return `Bot activado para ${phone} ✅`; }
  return false;
}

async function handleMessage(msg, contact) {
  if (!(await redis.set(`waseen:${msg.id}`, "1", { nx: true, ex: 172800 }))) return;
  const from = digits(msg.from);
  const text = (msg.text?.body || "").trim();
  console.log("WA mensaje de", from, "| en lista de contactos:", blocked().some((b) => from.endsWith(b.slice(-10))), "| total lista:", blocked().length);
  const owner = digits(process.env.OWNER_PHONE);

  if (owner && from === owner && text.startsWith("/bot ")) {
    const r = await command(text);
    if (r) await sendText(owner, r);
    return;
  }
  if (process.env.BOT_DISABLED === "1" || (await redis.get("bot:global-off"))) return; // bot apagado para todos
  if ((await isOff(from)) || (await isPaused(from))) return;

  // Filtro con IA: solo en el primer mensaje de cada chat
  if (!(await redis.get(`cls:${from}`))) {
    const kind = msg.type === "text" ? await classify(text, contact?.profile?.name) : "DUDOSO";
    console.log("Clasificación", from, kind);
    if (kind === "PERSONAL") {
      await redis.set(`off:${from}`, "1"); // charla personal: el bot no contesta nunca en este chat
      return;
    }
    await redis.set(`cls:${from}`, kind);
  }

  await markRead(msg.id);
  if (msg.type !== "text") {
    await sendText(from, "¡Gracias por tu mensaje! Por el momento solo puedo leer texto. ¿Me lo escribís así te ayudo?");
    return;
  }
  const name = contact?.profile?.name || "Sin nombre";
  const link = `https://wa.me/${from}`;
  // Avisos (lead nuevo / pide humano): por mail y, si está configurado, a tu WhatsApp personal
  const notify = async (t) => {
    const human = t.startsWith("🙋");
    await sendEmail(human ? `🙋 ${name} quiere hablar con vos` : `🟢 Nuevo lead: ${name}`, [t, `Abrir el chat: ${link}`]);
    if (owner) await sendText(owner, t);
  };
  const answer = await reply(from, text, contact?.profile?.name, { chat: from, notify });
  if (!(await isOff(from))) await sendText(from, answer);

  // Mail por cada chat nuevo (una vez cada 24 h por contacto)
  if (await redis.set(`mailchat:${from}`, "1", { nx: true, ex: 86400 })) {
    await sendEmail(`💬 Nuevo chat de ${name} (+${from})`, [
      `${name} (+${from}) escribió por WhatsApp:`,
      `“${text}”`,
      `El bot respondió:\n${answer}`,
      `Abrir el chat: ${link}`,
    ]);
  }
}

// Coexistencia: lo que mandás vos desde la app de WhatsApp Business llega como "echo"
async function handleEcho(echo) {
  const to = digits(echo.to);
  const text = (echo.text?.body || "").trim();
  if (text.startsWith("/bot ")) return command(text, to);
  if (to) await redis.set(`off:${to}`, "1"); // contestaste vos → el bot no contesta más en ese chat
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(200).send("Webhook de WhatsApp activo ✅");
  }
  if (req.method !== "POST") return res.status(405).end();

  const raw = await rawBody(req);
  console.log("WA webhook:", raw.toString("utf8").slice(0, 300));
  if (!validSignature(raw, req.headers["x-hub-signature-256"])) {
    console.error("Firma inválida: revisá WHATSAPP_APP_SECRET");
    return res.status(401).end();
  }
  let data;
  try { data = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).end(); }

  const jobs = [];
  for (const entry of data.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (ch.field === "messages") for (const m of v.messages || []) jobs.push(() => handleMessage(m, v.contacts?.[0]));
      if (ch.field === "smb_message_echoes") for (const e of v.message_echoes || []) jobs.push(() => handleEcho(e));
    }
  }
  if (jobs.length) waitUntil(jobs.reduce((p, j) => p.then(j), Promise.resolve()).catch((e) => console.error("WhatsApp error:", e)));
  res.status(200).end();
}
