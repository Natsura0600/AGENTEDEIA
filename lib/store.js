// Memoria persistente en un archivo JSON (data/store.json). Sobrevive reinicios.
import fs from "node:fs";
import path from "node:path";

const FILE = path.resolve(process.env.DATA_DIR || ".", "data/store.json");
const MAX_TURNS = 30;
const HIST_TTL = 7 * 24 * 3600e3; // 7 días

fs.mkdirSync(path.dirname(FILE), { recursive: true });
let db = { hist: {}, pause: {} };
try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}

let timer;
function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => fs.writeFileSync(FILE, JSON.stringify(db)), 500);
}

export function getHistory(chat) {
  const h = db.hist[chat];
  if (!h || Date.now() - h.at > HIST_TTL) return [];
  return h.messages;
}
export function saveHistory(chat, messages) {
  // Cortar siempre en un mensaje de usuario con texto (no en un tool_result huérfano)
  let m = messages.slice(-MAX_TURNS);
  while (m.length && (m[0].role !== "user" || typeof m[0].content !== "string")) m = m.slice(1);
  db.hist[chat] = { at: Date.now(), messages: m };
  persist();
}

export function isPaused(chat) {
  const until = db.pause[chat];
  return Boolean(until && until > Date.now());
}
export function pause(chat, hours = 24) {
  db.pause[chat] = Date.now() + hours * 3600e3;
  persist();
}
export function resume(chat) {
  delete db.pause[chat];
  persist();
}
