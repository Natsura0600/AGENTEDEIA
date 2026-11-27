// Webhook de WhatsApp (API oficial). Listo para cuando se conecte el número de Flama.
// Seguridad: solo se aceptan mensajes firmados por Meta (encabezado X-Hub-Signature-256 con WHATSAPP_APP_SECRET).
import { createHmac, timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { reply, botApagado } from "../lib/agent.js";
import { sendToClient } from "../lib/notify.js";
import { redis } from "../lib/redis.js";
import { limite } from "../lib/auth.js";

export const config = { maxDuration: 60 };

async function mediaBase64(id) {
  const auth = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const meta = await (await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(id)}`, { headers: auth, signal: AbortSignal.timeout(10000) })).json();
  if (!meta.url || (meta.file_size && meta.file_size > 3_000_000)) return { b64: null };
  const bin = await (await fetch(meta.url, { headers: auth, signal: AbortSignal.timeout(15000) })).arrayBuffer();
  return { b64: Buffer.from(bin).toString("base64"), type: meta.mime_type || "image/jpeg" };
}

async function handle(m, contact) {
  if (!m?.id || !/^\d{6,16}$/.test(String(m.from || ""))) return;
  if (!(await redis.set(`flama:seen:${m.id}`, "1", { nx: true, ex: 172800 }))) return; // Meta reintenta: no contestar dos veces
  // Tope por número: 30 mensajes por hora (cada respuesta por WhatsApp se paga)
  if (!(await limite(`wa:${m.from}`, 30, 3600))) return;
  if (await botApagado()) return;
  const chat = `wa:${m.from}`;
  let text = m.text?.body || m.image?.caption || "";
  let image, mediaType;
  if (m.type === "image") ({ b64: image, type: mediaType } = await mediaBase64(m.image.id));
  if (!text && !image) text = `(mandó un mensaje de tipo ${m.type})`;
  const answer = await reply({ chat, text, image: image || undefined, mediaType, name: contact?.profile?.name });
  await sendToClient(chat, answer);
}

function firmaValida(raw, firma) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !firma) return false;
  const esperado = Buffer.from("sha256=" + createHmac("sha256", secret).update(raw).digest("hex"));
  const recibido = Buffer.from(String(firma));
  return recibido.length === esperado.length && timingSafeEqual(recibido, esperado);
}

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  const tok = process.env.WHATSAPP_VERIFY_TOKEN;
  if (q.get("hub.mode") === "subscribe" && tok && q.get("hub.verify_token") === tok) return new Response(q.get("hub.challenge") || "", { status: 200 });
  return new Response("Webhook de Flama activo", { status: 200 });
}

export async function POST(request) {
  const raw = await request.text();
  if (!firmaValida(raw, request.headers.get("x-hub-signature-256"))) return new Response("Firma inválida", { status: 401 });
  let body; try { body = JSON.parse(raw); } catch { return new Response("JSON inválido", { status: 400 }); }
  const jobs = [];
  for (const e of body?.entry || []) for (const c of e?.changes || []) for (const m of c?.value?.messages || []) jobs.push(() => handle(m, c.value.contacts?.[0]));
  if (jobs.length) waitUntil(jobs.slice(0, 20).reduce((p, j) => p.then(j).catch((e) => console.error(e)), Promise.resolve()));
  return new Response(null, { status: 200 });
}
