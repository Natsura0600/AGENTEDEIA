// Instagram API oficial (Instagram Login). El token se guarda en Redis y se renueva solo cada día.
import { redis } from "./wa.js";

const IG_API = "https://graph.instagram.com/v23.0";
const FB_API = "https://graph.facebook.com/v23.0";
// Tokens "IG..." (Instagram login) van a graph.instagram.com; tokens "EAA..." (Facebook login / página) a graph.facebook.com
let apiOverride = null; // "instagram" | "facebook" guardado al conectar
const apiFor = (token) => {
  if (apiOverride === "instagram") return IG_API;
  if (apiOverride === "facebook" || apiOverride === "facebook-ig") return FB_API;
  return token?.startsWith("EAA") ? FB_API : IG_API;
};

export async function getToken() {
  apiOverride = await redis.get("ig:api");
  return (await redis.get("ig:token")) || process.env.INSTAGRAM_TOKEN;
}
// Para enviar con token de usuario del sistema por Facebook: /{ig-id}/messages en vez de /me/messages
async function sendPath() {
  const igId = await redis.get("ig:id");
  return apiOverride === "facebook-ig" && igId ? `/${igId}/messages` : "/me/messages";
}

export async function sendDM(recipientId, text) {
  const token = await getToken();
  const API = apiFor(token);
  const parts = [];
  // Instagram acepta hasta 1000 caracteres por mensaje: se corta por párrafos
  let buf = "";
  for (const p of text.split("\n\n")) {
    if ((buf + "\n\n" + p).length > 950 && buf) { parts.push(buf); buf = p; }
    else buf = buf ? `${buf}\n\n${p}` : p;
  }
  if (buf) parts.push(buf.slice(0, 1000));

  for (const part of parts) {
    const res = await fetch(`${API}${await sendPath()}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text: part } }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) console.error("Instagram API error", res.status, JSON.stringify(data));
    if (data.message_id) await redis.set(`igsent:${data.message_id}`, "1", { ex: 86400 });
  }
}

export async function typing(recipientId, on = true) {
  const token = await getToken();
  const API = apiFor(token);
  await fetch(`${API}${await sendPath()}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: recipientId }, sender_action: on ? "typing_on" : "typing_off" }),
  }).catch(() => {});
}

export async function getProfile(userId) {
  const token = await getToken();
  const API = apiFor(token);
  const res = await fetch(`${API}/${userId}?fields=username,name`, { headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? res.json() : {};
}

export async function refreshToken() {
  const token = await getToken();
  if (!token) return { ok: false, reason: "Sin token" };
  if (token.startsWith("EAA")) return { ok: true, skipped: "Token de Facebook: no usa la renovación de Instagram" };
  const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`);
  const data = await res.json();
  if (data.access_token) {
    await redis.set("ig:token", data.access_token);
    return { ok: true, expiresInDays: Math.round(data.expires_in / 86400) };
  }
  return { ok: false, error: data };
}

// Avisos que viajan de Instagram a tu WhatsApp (los manda el cron de WhatsApp)
export const queueNotify = (text) => redis.rpush("notify:queue", text);

// Diagnóstico: a qué cuenta pertenece el token (nunca devuelve tokens)
export async function whoAmI() {
  const token = await getToken();
  const API = apiFor(token);
  const get = async (path) => {
    const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return r.json().catch(() => ({}));
  };
  if (!token?.startsWith("EAA")) return { type: "instagram", me: await get("/me?fields=id,username") };
  const me = await get("/me?fields=id,name");
  const pages = await get("/me/accounts?fields=id,name,instagram_business_account{id,username}");
  const perms = await get("/me/permissions");
  const igId = process.env.INSTAGRAM_ACCOUNT_ID;
  const ig = igId ? await get(`/${igId}?fields=id,username,name`) : null;
  const igSubs = igId ? await get(`/${igId}/subscribed_apps`) : null;
  const biz = await get("/me/businesses?fields=id,name,owned_pages{id,name,instagram_business_account},instagram_business_accounts{id,username}");
  return {
    type: "facebook",
    me,
    pages: (pages.data || []).map((p) => ({ id: p.id, name: p.name, instagram: p.instagram_business_account })),
    pagesError: pages.error?.message,
    permissions: (perms.data || []).map((p) => `${p.permission}:${p.status}`),
    permissionsError: perms.error?.message,
    instagram: ig,
    instagramSubs: igSubs,
    businesses: biz.data,
    businessesError: biz.error?.message,
  };
}

// Usa el token guardado para descubrir a qué cuenta de Instagram tiene acceso (debug_token → granular_scopes)
export async function setupFromToken() {
  const token = await getToken();
  const appToken = `${process.env.INSTAGRAM_APP_ID}|${process.env.INSTAGRAM_APP_SECRET}`;
  const dbg = await (await fetch(`${FB_API}/debug_token?input_token=${token}&access_token=${encodeURIComponent(appToken)}`)).json();
  const scopes = dbg.data?.granular_scopes || [];
  const ids = [...new Set(scopes.filter((g) => g.scope.startsWith("instagram")).flatMap((g) => g.target_ids || []))];
  // Tokens de usuario del sistema: las cuentas asignadas salen de /me/assigned_instagram_accounts
  const assigned = await (await fetch(`${FB_API}/me/assigned_instagram_accounts?fields=id,username`, { headers: { Authorization: `Bearer ${token}` } })).json().catch(() => ({}));
  for (const a of assigned.data || []) if (!ids.includes(a.id)) ids.push(a.id);
  const out = { valid: dbg.data?.is_valid, app: dbg.data?.app_id, type: dbg.data?.type, scopes: scopes.map((g) => g.scope), igIds: ids, error: dbg.error?.message };
  for (const id of ids) {
    const r = await (await fetch(`${FB_API}/${id}?fields=id,username`, { headers: { Authorization: `Bearer ${token}` } })).json();
    out[`check_${id}`] = r.username || r.error?.message;
    if (r.username) {
      await redis.set("ig:id", id);
      await redis.set("ig:api", "facebook-ig");
      const sub = await (await fetch(`${FB_API}/${id}/subscribed_apps?subscribed_fields=messages,message_echoes`, { method: "POST", headers: { Authorization: `Bearer ${token}` } })).json().catch((e) => ({ error: { message: e.message } }));
      out.connected = r.username;
      out.subscribe = sub.success ?? sub.error?.message;
      break;
    }
  }
  return out;
}

// Prueba varios endpoints para encontrar la cuenta de Instagram asignada (no devuelve tokens)
export async function probe() {
  const token = await getToken();
  const paths = [
    "/me?fields=id,name",
    "/me/assigned_pages?fields=id,name,instagram_business_account{id,username}",
    "/me/assigned_instagram_accounts?fields=id,username",
    "/me/assigned_business_asset_groups",
    "/me/assigned_ad_accounts?fields=id,name",
    "/me/accounts?fields=id,name,instagram_business_account{id,username}",
    "/me/instagram_business_accounts?fields=id,username",
    "/me?fields=instagram_business_account{id,username}",
    "/me?fields=business{id,name}",
  ];
  const out = {};
  for (const p of paths) {
    const r = await (await fetch(`${FB_API}${p}`, { headers: { Authorization: `Bearer ${token}` } })).json().catch((e) => ({ error: { message: e.message } }));
    out[p.split("?")[0] + (p.includes("fields=") && p.startsWith("/me?") ? "?" + p.split("fields=")[1].split("{")[0] : "")] = r.error ? "ERR " + r.error.message : r;
  }
  return out;
}
