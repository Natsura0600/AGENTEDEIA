import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { reply } from "../lib/agent.js";
import { sendText, markRead } from "../lib/whatsapp.js";
import { isPaused, resume, alreadySeen } from "../lib/store.js";

export const config = { api: { bodyParser: false }, maxDuration: 60 };

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

async function handle(msg, contact) {
  const from = msg.from;
  const owner = process.env.OWNER_PHONE;
  const body = msg.text?.body?.trim() || "";

  // Comandos desde tu número: "/bot on 549..." o "/bot off 549..."
  if (owner && from === owner && body.startsWith("/bot ")) {
    const [, cmd, target] = body.split(/\s+/);
    if (cmd === "on" && target) { await resume(target); return sendText(owner, `Bot reactivado para ${target} ✅`); }
    if (cmd === "off" && target) {
      const { pause } = await import("../lib/store.js");
      await pause(target, 24 * 365);
      return sendText(owner, `Bot apagado para ${target} ⏸️`);
    }
    return;
  }
  if (await isPaused(from)) return;

  await markRead(msg.id);
  if (msg.type !== "text") {
    return sendText(from, "¡Gracias! Por ahora leo solo mensajes de texto. ¿Me lo escribís así te ayudo?");
  }
  const answer = await reply(from, body, contact?.profile?.name);
  if (answer) await sendText(from, answer);
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(200).send("Agente de WhatsApp de Picture Web Dev activo ✅");
  }
  if (req.method !== "POST") return res.status(405).end();

  const raw = await rawBody(req);
  if (!validSignature(raw, req.headers["x-hub-signature-256"])) return res.status(401).end();

  let data;
  try { data = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).end(); }
  const value = data.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];

  if (msg && !(await alreadySeen(msg.id))) {
    waitUntil(handle(msg, value.contacts?.[0]).catch((e) => console.error("Error:", e)));
  }
  res.status(200).end();
}
