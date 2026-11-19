// Configuración de WhatsApp: lista los números de la cuenta y suscribe la app a los webhooks.
// Uso: /api/wa-setup?secret=CRON_SECRET
import { sendEmail } from "../lib/email.js";
import { redis } from "../lib/redis.js";
const API = "https://graph.facebook.com/v23.0";

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.query.secret !== process.env.CRON_SECRET) return res.status(401).end();
  // Reactivar el bot para un número: /api/wa-setup?secret=...&enable=549...
  if (req.query.enable) {
    const n = String(req.query.enable).replace(/\D/g, "");
    const before = { off: await redis.get(`off:${n}`), cls: await redis.get(`cls:${n}`), pause: await redis.get(`pause:${n}`) };
    await redis.del(`off:${n}`, `pause:${n}`);
    await redis.set(`cls:${n}`, "CLIENTE"); // no volver a filtrarlo como personal
    const listed = (process.env.BOT_OFF_NUMBERS || "").split(",").some((b) => b && n.endsWith(b.slice(-10)));
    return res.json({ ok: true, number: n, before, inContactList: listed });
  }
  // Desactivar el bot para un número: /api/wa-setup?secret=...&disable=549...
  if (req.query.disable) {
    const n = String(req.query.disable).replace(/\D/g, "");
    await redis.set(`off:${n}`, "1");
    return res.json({ ok: true, number: n, off: await redis.get(`off:${n}`) });
  }
  if (req.query.testmail) {
    await sendEmail("✅ Prueba: los avisos del bot funcionan", ["Si ves este mail, los avisos de WhatsApp van a llegar acá.", "— Agente de Picture Web Dev"]);
    return res.json({ ok: true, sent: true });
  }
  const token = process.env.WHATSAPP_TOKEN;
  const waba = process.env.WHATSAPP_WABA_ID;
  const auth = { Authorization: `Bearer ${token}` };
  const j = async (r) => r.json().catch(() => ({}));

  const numbers = await j(await fetch(`${API}/${waba}/phone_numbers?fields=id,display_phone_number,verified_name,status,platform_type,code_verification_status`, { headers: auth }));
  const subscribe = await j(await fetch(`${API}/${waba}/subscribed_apps`, { method: "POST", headers: auth }));
  const subs = await j(await fetch(`${API}/${waba}/subscribed_apps`, { headers: auth }));
  const debug = await j(await fetch(`${API}/debug_token?input_token=${token}&access_token=${token}`));

  res.json({
    numbers: numbers.data || numbers.error?.message,
    subscribe: subscribe.success ?? subscribe.error?.message,
    subscribedApps: (subs.data || []).map((a) => a.whatsapp_business_api_data?.name || a.whatsapp_business_api_data?.id),
    token: debug.data && { valid: debug.data.is_valid, expires: debug.data.expires_at ? new Date(debug.data.expires_at * 1000).toISOString() : "nunca", scopes: debug.data.scopes },
  });
}
