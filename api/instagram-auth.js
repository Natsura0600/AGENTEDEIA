// Conexión de Instagram sin copiar tokens a mano:
// 1) /api/instagram-auth            → te manda al login de Instagram
// 2) Instagram vuelve acá con ?code  → se canjea por un token de 60 días y se guarda en Redis
import { redis } from "../lib/wa.js";

const REDIRECT = "https://agentedeia-two.vercel.app/api/instagram-auth";
const SCOPES = "instagram_business_basic,instagram_business_manage_messages";

const page = (title, body) => `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,Arial,sans-serif;background:#0a0a0a;color:#f5f5f5;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}
.c{max-width:440px;border:1px solid #2a2a2a;padding:36px 28px}h1{font-size:22px}p{color:#bbb;line-height:1.6}</style></head>
<body><div class="c"><h1>${title}</h1>${body}</div></body></html>`;

export default async function handler(req, res) {
  const appId = process.env.INSTAGRAM_APP_ID;
  const secret = process.env.INSTAGRAM_APP_SECRET;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!appId || !secret) return res.status(500).send(page("Falta configurar", "<p>Cargá INSTAGRAM_APP_ID e INSTAGRAM_APP_SECRET en Vercel.</p>"));

  const { code, error_description } = req.query;
  if (error_description) return res.send(page("No se pudo conectar", `<p>${String(error_description)}</p>`));

  // Login "unified" (Facebook Login for Business con configuración de Instagram)
  const configId = process.env.INSTAGRAM_CONFIG_ID;
  if (configId) return unified(req, res, { appId, secret, configId, code });

  if (!code) {
    const url = `https://www.instagram.com/oauth/authorize?enable_fb_login=0&force_reauth=true&client_id=${appId}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=${SCOPES}`;
    res.writeHead(302, { Location: url });
    return res.end();
  }

  // Código → token corto
  const form = new URLSearchParams({ client_id: appId, client_secret: secret, grant_type: "authorization_code", redirect_uri: REDIRECT, code: String(code).replace(/#_$/, "") });
  const shortRes = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form });
  const short = await shortRes.json();
  if (!short.access_token) return res.send(page("No se pudo conectar", `<p>${short.error_message || JSON.stringify(short)}</p>`));

  // Token corto → token de 60 días
  const longRes = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${secret}&access_token=${short.access_token}`);
  const long = await longRes.json();
  const token = long.access_token || short.access_token;
  await redis.set("ig:token", token);

  // Suscribir la cuenta a los mensajes
  await fetch(`https://graph.instagram.com/v23.0/me/subscribed_apps?subscribed_fields=messages,message_echoes&access_token=${token}`, { method: "POST" }).catch(() => {});
  const me = await (await fetch(`https://graph.instagram.com/v23.0/me?fields=username&access_token=${token}`)).json().catch(() => ({}));

  res.send(page("✅ Instagram conectado", `<p>La cuenta <b>@${me.username || "?"}</b> quedó vinculada al agente.<br>Ya podés probar mandándole un DM desde otra cuenta.</p>`));
}

async function unified(req, res, { appId, secret, configId, code }) {
  const FB = "https://graph.facebook.com/v23.0";
  if (!code) {
    const url = `https://www.facebook.com/v23.0/dialog/oauth?client_id=${appId}&config_id=${configId}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&override_default_response_type=true`;
    res.writeHead(302, { Location: url });
    return res.end();
  }
  const fail = (m) => res.send(page("No se pudo conectar", `<p>${m}</p>`));

  // Código → token de usuario → token de 60 días
  const t1 = await (await fetch(`${FB}/oauth/access_token?client_id=${appId}&client_secret=${secret}&redirect_uri=${encodeURIComponent(REDIRECT)}&code=${encodeURIComponent(code)}`)).json();
  if (!t1.access_token) return fail(t1.error?.message || JSON.stringify(t1));
  const t2 = await (await fetch(`${FB}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${secret}&fb_exchange_token=${t1.access_token}`)).json();
  const userToken = t2.access_token || t1.access_token;

  // Buscar la página de Facebook que tiene el Instagram vinculado
  const pages = await (await fetch(`${FB}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${userToken}`)).json();
  const list = pages.data || [];
  const pg = list.find((p) => p.instagram_business_account) || null;

  if (!pg) {
    // Sin página: guardar el token de usuario (por si el login unificado da acceso directo) y avisar
    await redis.set("ig:token", userToken);
    const names = list.map((p) => p.name).join(", ") || "ninguna";
    return fail(`Se inició sesión, pero no encontré una página de Facebook con Instagram vinculado (páginas: ${names}).<br>` +
      `Vinculá @picturewebdev a una página de Facebook (Instagram → Configuración → Centro de cuentas, o desde la página de Facebook → Configuración → Cuentas vinculadas) y volvé a abrir este link.`);
  }

  await redis.set("ig:token", pg.access_token); // token de página: no vence
  await fetch(`${FB}/${pg.id}/subscribed_apps?subscribed_fields=messages,message_echoes&access_token=${pg.access_token}`, { method: "POST" }).catch(() => {});
  res.send(page("✅ Instagram conectado", `<p>La cuenta <b>@${pg.instagram_business_account.username}</b> (página ${pg.name}) quedó vinculada al agente.<br>Ya podés probar mandándole un DM desde otra cuenta.</p>`));
}
