// Pedidos guardados en Redis (Upstash) con prefijo flama:
import { redis } from "./redis.js";

const K = (s) => `flama:${s}`;
export const ESTADOS = {
  pago_pendiente: "Esperando pago",
  pago_a_verificar: "Pago a verificar",
  programado: "Pagado · para cuando abra",
  en_preparacion: "En preparación",
  listo: "Listo para retirar",
  en_camino: "En camino",
  entregado: "Entregado",
  cancelado: "Cancelado",
};

export async function nextId() {
  const n = Number((await redis.get(K("seq"))) || 100) + 1;
  await redis.set(K("seq"), String(n));
  return String(n);
}
export async function saveOrder(o) {
  o.updatedAt = Date.now();
  await redis.set(K(`order:${o.id}`), JSON.stringify(o));
  let ids = [];
  try { ids = JSON.parse((await redis.get(K("orders"))) || "[]"); } catch {}
  if (!ids.includes(o.id)) { ids.unshift(o.id); await redis.set(K("orders"), JSON.stringify(ids.slice(0, 300))); }
  await redis.set(K(`active:${o.chat}`), o.id);
  return o;
}
export async function getOrder(id) {
  try { return JSON.parse((await redis.get(K(`order:${id}`))) || "null"); } catch { return null; }
}
export async function activeOrder(chat) {
  const id = await redis.get(K(`active:${chat}`));
  return id ? getOrder(id) : null;
}
export async function listOrders() {
  let ids = [];
  try { ids = JSON.parse((await redis.get(K("orders"))) || "[]"); } catch {}
  const out = [];
  for (const id of ids.slice(0, 80)) { const o = await getOrder(id); if (o) out.push(o); }
  return out;
}
// Número de operación ya usado (evita comprobantes repetidos)
export async function claimOperation(op, orderId) {
  if (!op) return true;
  const key = K(`op:${String(op).replace(/\s/g, "")}`);
  const r = await redis.set(key, orderId, { nx: true, ex: 60 * 60 * 24 * 90 });
  return r !== null;
}
