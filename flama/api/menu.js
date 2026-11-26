// Menú público para la web (precios, agotados y fotos) y las fotos de cada producto.
import { redis } from "../lib/redis.js";
import { getMenu } from "../lib/menu.js";

export default async function handler(req, res) {
  if (req.query.foto) {
    const v = await redis.get(`flama:foto:${String(req.query.foto).replace(/[^a-z0-9-]/gi, "")}`);
    if (!v) return res.status(404).end();
    const [type, b64] = v.split("|");
    res.setHeader("Content-Type", type);
    // la URL lleva la versión, así que se puede guardar en caché para siempre
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.send(Buffer.from(b64, "base64"));
  }
  const [m, fotos] = await Promise.all([getMenu(), redis.get("flama:fotos")]);
  const items = [
    ...m.HAMBURGUESAS.map((h) => ({ id: h.id, nombre: h.nombre, tipo: "burger", simple: h.simple, doble: h.doble, agotado: !!h.agotado })),
    { id: "sliders", nombre: "Sliders x3", tipo: "sliders", precio: m.SLIDERS.precio, agotado: !!m.SLIDERS.agotado },
    ...m.BEBIDAS.map((b) => ({ id: b.id, nombre: b.nombre, tipo: "bebida", precio: b.precio, agotado: !!b.agotado })),
  ];
  res.setHeader("Cache-Control", "public, s-maxage=20, stale-while-revalidate=60");
  res.json({
    items, fotos: JSON.parse(fotos || "{}"),
    extras: Object.fromEntries(Object.entries(m.EXTRAS).map(([k, e]) => [k, { nombre: e.nombre, precio: e.precio, agotado: !!e.agotado }])),
    zonas: m.ZONAS.map((z) => ({ id: z.id, precio: z.precio })),
  });
}
