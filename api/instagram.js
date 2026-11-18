// Webhook de Instagram: Meta avisa cada DM nuevo y el agente responde al instante.
import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { reply } from "../lib/agent.js";
import { isPaused, pause, resume } from "../lib/store.js";
import { redis } from "../lib/wa.js";
import { sendDM, typing, getProfile, queueNotify } from "../lib/instagram.js";

export const config = { api: { bodyParser: false }, maxDuration: 60 };

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function validSignature(raw, header) {
  const secret = process.env.INSTAGRAM_APP_SECRET;
  if (!secret) return true;
  if (!header) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

async function handle(ev) {
  console.log("Instagram evento:", JSON.stringify({ from: ev.sender?.id, to: ev.recipient?.id, echo: ev.message?.is_echo, text: ev.message?.text?.slice(0, 50) }));
  const msg = ev.message;
  if (!msg || msg.is_deleted || msg.is_unsupported) return;
  if (!(await redis.set(`igseen:${msg.mid}`, "1", { nx: true, ex: 172800 }))) return;

  // Mensajes que mandaste vos (desde la app) llegan como "echo"
  if (msg.is_echo) {
    if (await redis.get(`igsent:${msg.mid}`)) return; // lo mandó el bot
    const chat = `ig:${ev.recipient.id}`;
    const text = (msg.text || "").trim();
    if (text === "/bot on") return resume(chat);
    if (text === "/bot off") return pause(chat, 24 * 365);
    return pause(chat); // contestaste vos → el bot se calla 24 h
  }

  const userId = ev.sender.id;
  const chat = `ig:${userId}`;
  if (await isPaused(chat)) return;

  const text = (msg.text || "").trim();
  if (!text) {
    return sendDM(userId, "¡Gracias por tu mensaje! Por el momento solo puedo leer texto. ¿Me lo escribís así te ayudo?");
  }

  await typing(userId, true);
  const profile = await getProfile(userId).catch(() => ({}));
  const label = profile.username ? `instagram.com/${profile.username}` : `Instagram ${userId}`;
  const answer = await reply(userId, text, profile.name || profile.username, {
    chat,
    channel: "Instagram",
    label,
    notify: (t) => queueNotify(t),
  });
  await sendDM(userId, answer);
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && token === process.env.INSTAGRAM_VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(200).send("Webhook de Instagram activo ✅");
  }
  if (req.method !== "POST") return res.status(405).end();

  const raw = await rawBody(req);
  console.log("Instagram webhook recibido:", raw.toString("utf8").slice(0, 500));
  if (!validSignature(raw, req.headers["x-hub-signature-256"])) {
    console.error("Firma inválida: revisá que INSTAGRAM_APP_SECRET sea la clave secreta de la misma app de Meta");
    return res.status(401).end();
  }

  let data;
  try { data = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).end(); }

  // Meta manda los DMs como entry[].messaging[] o como entry[].changes[] (field "messages")
  const events = (data.entry || []).flatMap((e) => [
    ...(e.messaging || []),
    ...(e.changes || []).filter((c) => c.field === "messages" && c.value?.message).map((c) => c.value),
  ]);
  if (events.length) {
    waitUntil(
      events.reduce((p, ev) => p.then(() => handle(ev)), Promise.resolve())
        .catch((e) => console.error("Instagram error:", e))
    );
  }
  res.status(200).end();
}
