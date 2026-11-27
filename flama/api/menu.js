// Carta pública para la web y la venta de mostrador (sin productos ocultos) y las fotos de cada producto.
import { redis } from "../lib/redis.js";
import { getMenu, visibles } from "../lib/menu.js";

export default async function handler(req, res) {
  if (req.query.foto) {
    const v = await redis.get(`flama:foto:${String(req.query.foto).replace(/[^a-z0-9-]/gi, "")}`);
    if (!v) { res.setHeader("Cache-Control", "public, s-maxage=600"); return res.status(404).end(); }
    const [type, b64] = v.split("|");
    res.setHeader("Content-Type", /^image\/(webp|jpeg|png)$/.test(type) ? type : "application/octet-stream");
    // la URL lleva la versión, así que se puede guardar en caché para siempre
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.send(Buffer.from(b64, "base64"));
  }
  const [c, fotos] = await Promise.all([getMenu(), redis.get("flama:fotos")]);
  const ps = visibles(c);
  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=300");
  res.json({
    categorias: c.categorias.filter((cat) => ps.some((p) => p.cat === cat.id)),
    productos: ps,
    extras: c.extras,
    zonas: c.zonas,
    fotos: JSON.parse(fotos || "{}"),
  });
}
