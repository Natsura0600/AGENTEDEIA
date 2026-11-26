// Cliente de Upstash Redis compartido (valores en texto plano).
// Si Upstash no está conectado, usa una memoria temporal para que el bot igual responda.
import { Redis } from "@upstash/redis";

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const mem = new Map();
const memory = {
  async get(k) { const v = mem.get(k); return v && (!v.exp || v.exp > Date.now()) ? v.val : null; },
  async set(k, val, opts = {}) {
    if (opts.nx && (await this.get(k)) !== null) return null;
    mem.set(k, { val: String(val), exp: opts.ex ? Date.now() + opts.ex * 1000 : 0 });
    return "OK";
  },
  async del(...ks) { ks.forEach((k) => mem.delete(k)); return ks.length; },
  async rpush(k, v) { const a = JSON.parse((await this.get(k)) || "[]"); a.push(v); mem.set(k, { val: JSON.stringify(a), exp: 0 }); return a.length; },
  async mget(...ks) { return Promise.all(ks.flat().map((k) => this.get(k))); },
  async incr(k) { const n = Number((await this.get(k)) || 0) + 1; mem.set(k, { val: String(n), exp: 0 }); return n; },
  async scan(cursor, { match = "*" } = {}) {
    const re = new RegExp("^" + match.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return ["0", [...mem.keys()].filter((k) => re.test(k) && (!mem.get(k).exp || mem.get(k).exp > Date.now()))];
  },
  async lpop(k) { const a = JSON.parse((await this.get(k)) || "[]"); const v = a.shift() ?? null; mem.set(k, { val: JSON.stringify(a), exp: 0 }); return v; },
};

if (!url || !token) console.warn("Upstash no está conectado: usando memoria temporal");
export const redis = url && token ? new Redis({ url, token, automaticDeserialization: false }) : memory;
