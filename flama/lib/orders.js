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

// Jornada de trabajo (hora Argentina, corta a las 6 am para incluir la noche que pasa de medianoche)
export function jornada(t = Date.now()) {
  return new Date(t - 6 * 3600e3).toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
}

export async function nextId() {
  return String(100 + Number(await redis.incr(K("seq"))));
}
export async function saveOrder(o) {
  o.updatedAt = Date.now();
  const nuevo = !o._saved; delete o._saved;
  await redis.set(K(`order:${o.id}`), JSON.stringify(o), { ex: 60 * 60 * 30 }); // se borra solo al día siguiente
  if (nuevo) {
    o.jornada = o.jornada || jornada(o.createdAt);
    const lk = K(`orders:${o.jornada}`);
    let ids = [];
    try { ids = JSON.parse((await redis.get(lk)) || "[]"); } catch {}
    if (!ids.includes(o.id)) { ids.unshift(o.id); await redis.set(lk, JSON.stringify(ids.slice(0, 500)), { ex: 60 * 60 * 30 }); }
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
  try { ids = JSON.parse((await redis.get(K(`orders:${jornada()}`))) || "[]"); } catch {}
  ids = ids.slice(0, 300);
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

// ---- Caja diaria (se guarda para siempre, 1 registro por día) ----
const vacio = () => ({ pedidos: 0, ventas: 0, envios: 0, retiro: 0, delivery: 0, mostrador: 0, cancelados: 0, productos: {}, porPago: {} });
export async function sumarCaja(o, signo = 1) {
  const k = K(`caja:${o.jornada || jornada(o.createdAt)}`);
  let d; try { d = { ...vacio(), ...JSON.parse((await redis.get(k)) || "{}") }; } catch { d = vacio(); }
  d.pedidos += signo; d.ventas += signo * o.total; d.envios += signo * (o.envio || 0);
  d[o.canal === "mostrador" ? "mostrador" : o.entrega === "envio" ? "delivery" : "retiro"] += signo;
  const pago = o.pago || "transferencia"; d.porPago = d.porPago || {}; d.porPago[pago] = (d.porPago[pago] || 0) + signo * o.total;
  for (const l of o.lineas || []) { const m = l.texto.match(/^(\d+)x (.+?)(?: \+| \(|$)/); if (m) d.productos[m[2]] = (d.productos[m[2]] || 0) + signo * Number(m[1]); }
  await redis.set(k, JSON.stringify(d));
}
export async function contarCancelado(o) {
  const k = K(`caja:${o.jornada || jornada(o.createdAt)}`);
  let d; try { d = { ...vacio(), ...JSON.parse((await redis.get(k)) || "{}") }; } catch { d = vacio(); }
  d.cancelados += 1; await redis.set(k, JSON.stringify(d));
}
export async function cajaHoy() {
  try { return { ...vacio(), ...JSON.parse((await redis.get(K(`caja:${jornada()}`))) || "{}") }; } catch { return vacio(); }
}
export async function cajaMes(mes) { // mes = "YYYY-MM"
  const [y, m] = mes.split("-").map(Number);
  const dias = new Date(y, m, 0).getDate();
  const fechas = Array.from({ length: dias }, (_, i) => `${mes}-${String(i + 1).padStart(2, "0")}`);
  const vals = await redis.mget(...fechas.map((f) => K(`caja:${f}`)));
  return fechas.map((f, i) => { let d = null; try { d = JSON.parse(vals[i]); } catch {} return { fecha: f, ...(d ? { ...vacio(), ...d } : vacio()) }; });
}
