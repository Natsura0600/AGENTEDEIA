// Pantalla de fichaje del local: el empleado pone su PIN y registra entrada o salida.
// Freno a quien prueba PINs: 8 errores en 10 minutos bloquean esa conexión 10 minutos.
import { autorizar, ipDe } from "../lib/auth.js";
import { fichar, trabajandoAhora } from "../lib/personal.js";
import { redis } from "../lib/redis.js";

export default async function handler(req, res) {
  if (!(await autorizar(req, res, "local"))) return;
  if (req.method === "POST") {
    const ip = ipDe(req), bk = `flama:pinbl:${ip}`;
    if (await redis.get(bk)) return res.status(429).json({ error: "Demasiados PIN incorrectos. Esperá 10 minutos." });
    try { return res.json(await fichar(String(req.body?.pin || "").replace(/\D/g, "").slice(0, 8))); }
    catch (e) {
      if (/PIN incorrecto/.test(e.message)) {
        const k = `flama:pinf:${ip}:${Math.floor(Date.now() / 6e5)}`;
        const n = await redis.incr(k); if (n === 1) await redis.expire(k, 660);
        if (n >= 8) await redis.set(bk, "1", { ex: 600 });
      }
      return res.status(400).json({ error: e.message });
    }
  }
  res.json({ ahora: (await trabajandoAhora()).map(({ nombre, desde }) => ({ nombre, desde })) });
}
