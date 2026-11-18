// Cron diario de Vercel (permitido en el plan Hobby): renueva el token de Instagram para que no venza.
// También se puede usar para cargar un token nuevo: /api/instagram-refresh?secret=CRON_SECRET&token=NUEVO
import { refreshToken, whoAmI } from "../lib/instagram.js";
import { redis } from "../lib/wa.js";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const given = req.query?.secret || (req.headers.authorization || "").replace("Bearer ", "");
  if (secret && given !== secret) return res.status(401).end();
  if (req.query?.token) {
    await redis.set("ig:token", req.query.token);
    return res.json({ ok: true, saved: true });
  }
  if (req.query?.check) return res.json(await whoAmI());
  res.json(await refreshToken());
}
