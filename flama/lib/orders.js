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
  return String(100 + Number(await redis.incr(K("seq"))));
}
export async function saveOrder(o) {
  o.updatedAt = Date.now();
  const nuevo = !o._saved; delete o._saved;
  await redis.set(K(`order:${o.id}`), JSON.stringify(o), { ex: 60 * 60 * 24 * 30 });
  if (nuevo) {
    let ids = [];
    try { ids = JSON.parse((await redis.get(K("orders"))) || "[]"); } catch {}
    if (!ids.includes(o.id)) { ids.unshift(o.id); await redis.set(K("orders"), JSON.stringify(ids.slice(0, 200))); }
    await redis.set(K(`active:${o.chat}`), o.id, { ex: 60 * 60 * 24 * 2 });
  }
  await redis.incr(K("ver"));
  o._saved = true;
  return o;
}
export async function getOrder(id) {
  try { const o = JSON.parse((await redis.get(K(`order:${id}`))) || "null"); if (o) o._saved = true; return o; } catch { return null; }
}
export async function activeOrder(chat) {
  const id = await redis.get(K(`active:${chat}`));
  return id ? getOrder(id) : null;
}
export async function listOrders() {
  let ids = [];
  try { ids = JSON.parse((await redis.get(K("orders"))) || "[]"); } catch {}
  ids = ids.slice(0, 60);
  if (!ids.length) return [];
  const vals = await redis.mget(...ids.map((id) => K(`order:${id}`)));
  return vals.map((v) => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean);
}
// Estado barato para el panel: versión de pedidos + bot apagado, en 1 solo comando
export async function panelState() {
  const [ver, off] = await redis.mget(K("ver"), K("bot_off"));
  return { ver: String(ver || 0), botOn: off !== "1" };
}
// Número de operación ya usado (evita comprobantes repetidos)
export async function claimOperation(op, orderId) {
  if (!op) return true;
  const key = K(`op:${String(op).replace(/\s/g, "")}`);
  const r = await redis.set(key, orderId, { nx: true, ex: 60 * 60 * 24 * 90 });
  return r !== null;
}
