// Pedidos guardados en Redis (Upstash) con prefijo flama:
import { redis } from "./redis.js";
import { sumarJSON } from "./atomico.js";

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
const DIA = 60 * 60 * 30; // los pedidos se borran solos al día siguiente
// Guardar un pedido. Atómico aunque entren muchos a la vez:
// - la lista del día es una lista de Redis (LPUSH), no un JSON que se lee y se reescribe
// - "chg" marca qué pedidos cambiaron y cuándo, para que el panel baje solo esos
// - la versión se sube al final: si el panel la ve, el cambio ya está guardado
export async function saveOrder(o) {
  o.updatedAt = Date.now();
  const nuevo = !o._saved; delete o._saved;
  o.jornada = o.jornada || jornada(o.createdAt);
  await redis.set(K(`order:${o.id}`), JSON.stringify(o), { ex: DIA });
  if (nuevo) {
    const n = await redis.lpush(K(`ped:${o.jornada}`), o.id);
    if (n === 1) await Promise.all([redis.expire(K(`ped:${o.jornada}`), DIA), redis.zadd(K(`chg:${o.jornada}`), { score: o.updatedAt, member: o.id }).then(() => redis.expire(K(`chg:${o.jornada}`), DIA))]);
    else await redis.zadd(K(`chg:${o.jornada}`), { score: o.updatedAt, member: o.id });
    if (!String(o.chat || "").startsWith("local:")) await redis.set(K(`active:${o.chat}`), o.id, { ex: 60 * 60 * 24 * 2 });
  } else await redis.zadd(K(`chg:${o.jornada}`), { score: o.updatedAt, member: o.id });
  await redis.incr(K("ver"));
  o._saved = true;
  return o;
}
const parse = (v) => { try { return JSON.parse(v); } catch { return null; } };
export async function getOrder(id) {
  const o = parse(await redis.get(K(`order:${id}`))); if (o) o._saved = true; return o;
}
export async function activeOrder(chat) {
  const id = await redis.get(K(`active:${chat}`));
  return id ? getOrder(id) : null;
}
async function traer(ids) {
  if (!ids.length) return [];
  return (await redis.mget(...ids.map((id) => K(`order:${id}`)))).map(parse).filter(Boolean);
}
export async function listOrders(j = jornada()) {
  return traer(await redis.lrange(K(`ped:${j}`), 0, 499));
}
// Pedidos que cambiaron desde "desde" (ms). El panel pide con 5 s de margen.
export async function cambiosDesde(j, desde) {
  return traer(await redis.zrange(K(`chg:${j}`), Math.max(0, desde - 5000), "+inf", { byScore: true }));
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

// ---- Caja diaria (se guarda para siempre, 1 registro por día). Sumas atómicas (script Lua). ----
const vacio = () => ({ pedidos: 0, ventas: 0, envios: 0, retiro: 0, delivery: 0, mostrador: 0, cancelados: 0, productos: {}, porPago: {} });
export async function sumarCaja(o, signo = 1) {
  const prod = {};
  for (const l of o.lineas || []) { const m = l.texto.match(/^(\d+)x (.+?)(?: \+| \(|$)/); if (m) prod[m[2]] = (prod[m[2]] || 0) + signo * Number(m[1]); }
  const d = { pedidos: signo, ventas: signo * o.total, envios: signo * (o.envio || 0), [o.canal === "mostrador" ? "mostrador" : o.entrega === "envio" ? "delivery" : "retiro"]: signo, porPago: { [o.pago || "transferencia"]: signo * o.total } };
  if (Object.keys(prod).length) d.productos = prod;
  await sumarJSON(K(`caja:${o.jornada || jornada(o.createdAt)}`), d);
}
export async function contarCancelado(o) {
  await sumarJSON(K(`caja:${o.jornada || jornada(o.createdAt)}`), { cancelados: 1 });
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

// Candado corto por pedido: si dos pantallas (o el bot y una pantalla) tocan el mismo pedido a la vez,
// el segundo espera un instante en vez de pisar al primero (evita caja o stock contados dos veces).
export async function conCandado(id, fn) {
  const k = K(`lock:${id}`);
  for (let i = 0; i < 20; i++) {
    if (await redis.set(k, "1", { nx: true, ex: 10 })) {
      try { return await fn(); } finally { await redis.del(k).catch(() => {}); }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("El pedido se está actualizando desde otro lado, probá de nuevo");
}

// Avisos al cliente que el dueño elige mandar (cada aviso por WhatsApp se paga). Caché de 30 s.
export const AVISOS_BASE = { en_preparacion: true, listo: true, en_camino: true, entregado: false, cancelado: true };
let avisosCache = { t: 0, v: null };
export async function avisos(fresh) {
  if (!fresh && avisosCache.v && Date.now() - avisosCache.t < 30e3) return avisosCache.v;
  const v = { ...AVISOS_BASE, ...(parse(await redis.get(K("avisos"))) || {}) };
  avisosCache = { t: Date.now(), v };
  return v;
}
export async function guardarAvisos(a) {
  const v = Object.fromEntries(Object.keys(AVISOS_BASE).map((k) => [k, a[k] === true]));
  await redis.set(K("avisos"), JSON.stringify(v)); avisosCache = { t: Date.now(), v };
  return v;
}

// Imagen del comprobante: aparte del pedido para que el panel no la baje en cada actualización
export const guardarComprobante = (id, dataUrl) => redis.set(K(`comp:${id}`), dataUrl, { ex: 60 * 60 * 24 * 3 });
export const leerComprobanteImg = (id) => redis.get(K(`comp:${id}`));
