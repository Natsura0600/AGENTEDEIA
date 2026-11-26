// Zona y costo de envío para una dirección escrita (lo usa el carrito de la web y el panel del dueño).
// GET /api/envio?dir=Belgrano 1234
import { redis } from "../lib/redis.js";
import { getMenu } from "../lib/menu.js";
import { detectarZona, origenLocal, linkMapa } from "../lib/geo.js";
import { rol } from "../lib/auth.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const c = await getMenu();
  // Panel del dueño: dónde quedó ubicado el local
  if (req.query.origen) {
    if (rol(req.query.key) !== "dueno") return res.status(401).json({ error: "Clave incorrecta" });
    const o = await origenLocal(await getMenu(true));
    return res.json({ ...o, mapa: linkMapa(o) });
  }
  const dir = String(req.query.dir || "").slice(0, 160);
  if (dir.trim().length < 4) return res.status(400).json({ error: "Escribí calle y número" });
  // Freno simple contra abuso: 30 consultas por minuto por IP
  const ip = String(req.headers?.["x-forwarded-for"] || "x").split(",")[0].trim();
  const rk = `flama:rl:envio:${ip}:${Math.floor(Date.now() / 60000)}`;
  const n = await redis.incr(rk);
  if (n === 1) await redis.expire?.(rk, 120);
  if (n > 30) return res.status(429).json({ error: "Muchas consultas, probá en un minuto" });
  try {
    // ?debug=1 con la clave del dueño: muestra qué encontró cada buscador
    if (req.query.debug && rol(req.query.key) === "dueno") { const diag = {}; const r = await detectarZona(dir, c, diag); return res.json({ ...r, diag }); }
    const r = await detectarZona(dir, c);
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.json(r);
  } catch (e) {
    console.error(e);
    res.status(502).json({ encontrada: false, error: "No pudimos buscar la dirección" });
  }
}
