// Chat de prueba web (simula WhatsApp para la demo)
// POST {session, text?, image? (base64), mediaType?} → {reply}
// GET  ?session=... → mensajes nuevos del local (cambios de estado)
import { reply, botApagado } from "../lib/agent.js";
import { takeOutbox } from "../lib/notify.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const session = String((req.method === "GET" ? req.query.session : req.body?.session) || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  if (!session) return res.status(400).json({ error: "Falta session" });
  const chat = `web:${session}`;
  if (req.method === "GET") return res.json({ messages: await takeOutbox(chat) });
  if (req.method !== "POST") return res.status(405).end();
  const { text, image, mediaType, name } = req.body || {};
  if (!text && !image) return res.status(400).json({ error: "Mensaje vacío" });
  if (await botApagado()) return res.json({ reply: "¡Gracias por escribir! En un ratito te responde alguien del local 🙌" });
  try {
    const answer = await reply({ chat, text: String(text || "").slice(0, 2000), image, mediaType, name });
    res.json({ reply: answer });
  } catch (e) {
    console.error(e);
    res.status(500).json({ reply: "Uy, tuvimos un problema. Probá de nuevo en un momento." });
  }
}
