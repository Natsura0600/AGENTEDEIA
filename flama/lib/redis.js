// Cliente de Upstash Redis compartido (valores en texto plano).
// En producción es obligatorio: si falta la conexión, las APIs fallan en vez de guardar en una memoria que se pierde.
// En desarrollo (sin Upstash) usa una memoria local con los mismos comandos, para poder probar todo.
import { Redis } from "@upstash/redis";

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const produccion = process.env.VERCEL_ENV === "production";

const mem = new Map();
const vivo = (k) => { const v = mem.get(k); if (v && v.exp && v.exp <= Date.now()) { mem.delete(k); return null; } return v || null; };
const lista = (k) => { const v = vivo(k); if (!v) return []; if (!Array.isArray(v.val)) throw new Error("WRONGTYPE " + k); return v.val; };
const memory = {
  async get(k) { const v = vivo(k); if (!v) return null; if (typeof v.val !== "string") throw new Error("WRONGTYPE " + k); return v.val; },
  async set(k, val, opts = {}) {
    if (opts.nx && vivo(k)) return null;
    mem.set(k, { val: String(val), exp: opts.ex ? Date.now() + opts.ex * 1000 : 0 });
    return "OK";
  },
  async del(...ks) { let n = 0; ks.flat().forEach((k) => { if (mem.delete(k)) n++; }); return n; },
  async mget(...ks) { return ks.flat().map((k) => { const v = vivo(k); return v && typeof v.val === "string" ? v.val : null; }); },
  async incr(k) { const n = Number((await this.get(k)) || 0) + 1; const v = vivo(k); mem.set(k, { val: String(n), exp: v?.exp || 0 }); return n; },
  async expire(k, sec) { const v = vivo(k); if (!v) return 0; v.exp = Date.now() + sec * 1000; return 1; },
  async lpush(k, ...vals) { const a = lista(k); a.unshift(...vals.reverse()); const v = vivo(k); mem.set(k, { val: a, exp: v?.exp || 0 }); return a.length; },
  async rpush(k, ...vals) { const a = lista(k); a.push(...vals); const v = vivo(k); mem.set(k, { val: a, exp: v?.exp || 0 }); return a.length; },
  async lrange(k, a, b) { const l = lista(k); return l.slice(a, b === -1 ? undefined : b + 1); },
  async zadd(k, ...ms) {
    const v = vivo(k), z = v?.val instanceof Map ? v.val : new Map();
    for (const m of ms) z.set(String(m.member), Number(m.score));
    mem.set(k, { val: z, exp: v?.exp || 0 }); return ms.length;
  },
  async zrange(k, min, max) {
    const v = vivo(k); if (!v) return [];
    const lo = String(min).startsWith("(") ? [Number(String(min).slice(1)), true] : [Number(min), false];
    const hi = max === "+inf" ? Infinity : Number(max);
    return [...v.val].filter(([, s]) => (lo[1] ? s > lo[0] : s >= lo[0]) && s <= hi).sort((a, b) => a[1] - b[1]).map(([m]) => m);
  },
  async scan(cursor, { match = "*" } = {}) {
    const re = new RegExp("^" + match.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return ["0", [...mem.keys()].filter((k) => re.test(k) && vivo(k))];
  },
  // Los scripts Lua se emulan en JS (lib/atomico.js trae la versión JS de cada uno)
  async eval() { throw new Error("EVAL_LOCAL"); },
};

function sinBase() {
  const err = () => { throw new Error("La base de datos (Upstash) no está configurada"); };
  return new Proxy({}, { get: () => err });
}

if (!url || !token) console.warn(produccion ? "FALTA UPSTASH en producción" : "Upstash no está conectado: usando memoria local");
// (las pruebas automáticas pueden enchufar un Redis real con globalThis.__TEST_REDIS)
export const redis = globalThis.__TEST_REDIS ? globalThis.__TEST_REDIS : url && token ? new Redis({ url, token, automaticDeserialization: false }) : produccion ? sinBase() : memory;
export const esMemoria = redis === memory;
