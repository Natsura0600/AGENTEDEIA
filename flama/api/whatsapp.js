// Webhook de WhatsApp (API oficial). Listo para cuando se conecte el número de Flama.
import { waitUntil } from "@vercel/functions";
import { reply, botApagado } from "../lib/agent.js";
import { sendToClient } from "../lib/notify.js";
import { redis } from "../lib/redis.js";

export const config = { maxDuration: 60 };

async function mediaBase64(id) {
  const auth = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const meta = await (await fetch(`https://graph.facebook.com/v23.0/${id}`, { headers: auth })).json();
  const bin = await (await fetch(meta.url, { headers: auth })).arrayBuffer();
  return { b64: Buffer.from(bin).toString("base64"), type: meta.mime_type || "image/jpeg" };
}

async function handle(m, contact) {
  if (!(await redis.set(`flama:seen:${m.id}`, "1", { nx: true, ex: 172800 }))) return;
  if (await botApagado()) return;
  const chat = `wa:${m.from}`;
  let text = m.text?.body || m.image?.caption || "";
  let image, mediaType;
  if (m.type === "image") ({ b64: image, type: mediaType } = await mediaBase64(m.image.id));
  if (!text && !image) text = `(mandó un mensaje de tipo ${m.type})`;
  const answer = await reply({ chat, text, image, mediaType, name: contact?.profile?.name });
  await sendToClient(chat, answer);
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const q = req.query;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN) return res.send(q["hub.challenge"]);
    return res.send("Webhook de Flama activo");
  }
  const v = req.body?.entry?.[0]?.changes?.[0]?.value;
  const jobs = (v?.messages || []).map((m) => () => handle(m, v.contacts?.[0]));
  if (jobs.length) waitUntil(jobs.reduce((p, j) => p.then(j), Promise.resolve()).catch((e) => console.error(e)));
  res.status(200).end();
}
