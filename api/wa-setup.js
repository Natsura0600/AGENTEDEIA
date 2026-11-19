// Configuración de WhatsApp: lista los números de la cuenta y suscribe la app a los webhooks.
// Uso: /api/wa-setup?secret=CRON_SECRET
const API = "https://graph.facebook.com/v23.0";

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.query.secret !== process.env.CRON_SECRET) return res.status(401).end();
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
