// Memoria de conversaciones: Upstash Redis si está conectado; si no, memoria temporal.
import { Redis } from "@upstash/redis";

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const redis = url && token ? new Redis({ url, token }) : null;
const mem = new Map();
const TTL = 60 * 60 * 24 * 7;
const MAX = 30;

const get = async (k) => (redis ? await redis.get(k) : mem.get(k));
const set = async (k, v, ex = TTL) => (redis ? redis.set(k, v, { ex }) : mem.set(k, v));
const del = async (k) => (redis ? redis.del(k) : mem.delete(k));

export const getHistory = async (chat) => (await get(`hist:${chat}`)) || [];
export const saveHistory = (chat, msgs) => set(`hist:${chat}`, msgs.slice(-MAX));
export const isPaused = async (chat) => Boolean(await get(`pause:${chat}`));
export const pause = (chat, hours = 24) => set(`pause:${chat}`, 1, hours * 3600);
export const resume = (chat) => del(`pause:${chat}`);

export async function alreadySeen(id) {
  if (redis) return (await redis.set(`seen:${id}`, 1, { nx: true, ex: 86400 })) === null;
  if (mem.has(id)) return true;
  mem.set(id, 1);
  return false;
}
