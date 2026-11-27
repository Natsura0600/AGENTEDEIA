// Claves de acceso a los paneles.
// - Viajan en el encabezado "x-flama-key" (nunca en la URL: no quedan en registros ni en el historial).
// - En producción no hay claves por defecto: si falta la variable, nadie entra.
// - Quien prueba claves equivocadas queda bloqueado 15 minutos después de 30 intentos.
import { createHash, timingSafeEqual } from "node:crypto";
import { redis } from "./redis.js";

const produccion = process.env.VERCEL_ENV === "production";
export const CLAVE_EMPLEADOS = () => process.env.PANEL_KEY || (produccion ? null : "flama2026");
export const CLAVE_DUENO = () => process.env.OWNER_KEY || (produccion ? null : "dueno-flama");

const h = (s) => createHash("sha256").update(String(s)).digest();
const igual = (a, b) => !!a && !!b && timingSafeEqual(h(a), h(b));

export function rol(key) {
  if (!key || String(key).length > 200) return null;
  if (igual(key, CLAVE_DUENO())) return "dueno";
  if (igual(key, CLAVE_EMPLEADOS())) return "empleado";
  return null;
}

export const ipDe = (req) => String(req.headers?.["x-forwarded-for"] || req.headers?.["x-real-ip"] || "x").split(",")[0].trim().slice(0, 64) || "x";
export const claveDe = (req) => String(req.headers?.["x-flama-key"] || "");
export const BLOQUEO = (ip) => `flama:bl:${ip}`;
const LIMITE = 30, VENTANA = 15 * 60;

async function anotarFallo(ip) {
  try {
    const k = `flama:fa:${ip}:${Math.floor(Date.now() / (VENTANA * 1000))}`;
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, VENTANA + 60);
    if (n >= LIMITE) await redis.set(BLOQUEO(ip), "1", { ex: VENTANA });
  } catch {}
}

// Devuelve el rol o responde el error y devuelve null.
// necesita: "local" (empleados o dueño) o "dueno".
// bloqueo: si el que llama ya leyó la marca de bloqueo (en un mget), la pasa para no gastar otro comando.
export async function autorizar(req, res, necesita = "local", { bloqueo } = {}) {
  const ip = ipDe(req), r = rol(claveDe(req));
  if (!r) {
    await anotarFallo(ip);
    res.setHeader("Cache-Control", "no-store");
    res.status(401).json({ error: "Clave incorrecta" });
    return null;
  }
  if (necesita === "dueno" && r !== "dueno") { res.status(403).json({ error: "Esto es solo para el dueño" }); return null; }
  const bl = bloqueo !== undefined ? bloqueo : await redis.get(BLOQUEO(ip)).catch(() => null);
  if (bl) { res.status(429).json({ error: "Demasiados intentos con clave equivocada desde esta conexión. Probá en 15 minutos." }); return null; }
  res.setHeader("Cache-Control", "no-store");
  return r;
}

// Límite simple por ventana de tiempo (1 comando por llamada, 2 la primera vez de la ventana)
export async function limite(clave, max, segundos) {
  try {
    const k = `flama:rl:${clave}:${Math.floor(Date.now() / (segundos * 1000))}`;
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, segundos + 30);
    return n <= max;
  } catch { return true; }
}
