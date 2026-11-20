// Registro de los últimos chats para el panel
import { redis } from "./redis.js";

const KEY = "chats:recent";
const MAX = 150;

export async function recordChat(phone, name, text) {
  let list = [];
  try { list = JSON.parse((await redis.get(KEY)) || "[]"); } catch {}
  const prev = list.find((c) => c.phone === phone);
  list = list.filter((c) => c.phone !== phone);
  list.unshift({ phone, name: name || prev?.name || "", last: String(text || "").slice(0, 80), at: Date.now() });
  await redis.set(KEY, JSON.stringify(list.slice(0, MAX)));
}

export async function listChats() {
  try { return JSON.parse((await redis.get(KEY)) || "[]"); } catch { return []; }
}
