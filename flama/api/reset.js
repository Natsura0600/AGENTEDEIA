// Borra TODOS los datos de Flama en Upstash (pedidos, chats, caja, contador).
// Uso: /api/reset?key=CLAVE_DEL_PANEL&confirmar=si
import { redis } from "../lib/redis.js";
import { rol } from "../lib/auth.js";

export default async function handler(req, res) {
  if (rol(req.query.key) !== "dueno") return res.status(401).json({ error: "Clave incorrecta" });
  if (req.query.confirmar !== "si") return res.status(400).json({ error: "Agregá &confirmar=si para borrar todo" });
  if (typeof redis.scan !== "function") return res.json({ borradas: 0, nota: "Upstash no está conectado" });
  let cursor = "0", borradas = 0;
  do {
    const [next, keys] = await redis.scan(cursor, { match: "flama:*", count: 500 });
    cursor = String(next);
    if (keys.length) { await redis.del(...keys); borradas += keys.length; }
  } while (cursor !== "0");
  res.json({ ok: true, borradas });
}
