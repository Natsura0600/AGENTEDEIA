// Consultas públicas que Vercel guarda en su caché (CDN): muchas pantallas o clientes mirando
// le pegan a Vercel, y Upstash recibe como mucho una consulta cada pocos segundos.
//   GET /api/estado          → { v, bot }  versión de los pedidos (el panel solo pide datos cuando cambia)
//   GET /api/estado?t=TOKEN  → estado de un pedido para el link de seguimiento del cliente
import { redis } from "../lib/redis.js";
import { leerSeguimiento } from "../lib/orders.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  const t = String(req.query.t || "");
  if (t) {
    if (!/^[A-Za-z0-9_-]{16}$/.test(t)) return res.status(404).json({ error: "Link inválido" });
    const o = await leerSeguimiento(t);
    res.setHeader("Cache-Control", o ? "public, max-age=0, s-maxage=10" : "public, max-age=0, s-maxage=60");
    res.setHeader("X-Robots-Tag", "noindex");
    return o ? res.json(o) : res.status(404).json({ error: "Este pedido ya no está disponible" });
  }
  const [v, off] = await redis.mget("flama:ver", "flama:bot_off");
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=5");
  res.json({ v: String(v || 0), bot: off !== "1" });
}
