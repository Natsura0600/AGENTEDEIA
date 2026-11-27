// Chat de la web (simula WhatsApp para la demo)
// POST {session, text?, image? (base64), mediaType?} → {reply}
// GET  ?session=... → mensajes nuevos del local (cambios de estado)
import { reply, botApagado } from "../lib/agent.js";
import { takeOutbox } from "../lib/notify.js";
import { ipDe, limite } from "../lib/auth.js";

export const config = { maxDuration: 60 };
const TIPOS = /^image\/(jpeg|png|webp|heic|heif)$/;
// Freno en memoria a consultas de mensajes demasiado seguidas (no gasta Redis)
const ultimas = new Map();

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const session = String((req.method === "GET" ? req.query.session : req.body?.session) || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  if (session.length < 8) return res.status(400).json({ error: "Falta session" });
  const chat = `web:${session}`;
  if (req.method === "GET") {
    const t = ultimas.get(session) || 0, ahora = Date.now();
    if (ahora - t < 4000) return res.json({ messages: [] });
    ultimas.set(session, ahora); if (ultimas.size > 5000) ultimas.clear();
    return res.json({ messages: await takeOutbox(chat) });
  }
  if (req.method !== "POST") return res.status(405).end();
  const { text, image, mediaType, name } = req.body || {};
  if (!text && !image) return res.status(400).json({ error: "Mensaje vacío" });
  if (image && (typeof image !== "string" || image.length > 3_500_000 || !TIPOS.test(String(mediaType || "image/jpeg")))) return res.status(400).json({ reply: "La imagen es muy pesada o no es una foto. Mandá una captura del comprobante." });
  // Tope de mensajes por conexión: frena a quien quiera gastar la IA a propósito
  if (!(await limite(`chat:${ipDe(req)}`, 40, 600))) return res.status(429).json({ reply: "Recibimos muchos mensajes seguidos. Esperá unos minutos y seguimos 🙏" });
  if (await botApagado()) return res.json({ reply: "¡Gracias por escribir! En un ratito te responde alguien del local 🙌" });
  try {
    const answer = await reply({ chat, text: String(text || "").slice(0, 1500), image, mediaType, name });
    res.json({ reply: answer });
  } catch (e) {
    console.error(e);
    res.status(500).json({ reply: "Uy, tuvimos un problema. Probá de nuevo en un momento." });
  }
}
