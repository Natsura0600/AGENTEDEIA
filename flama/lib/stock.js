// Control de stock: ingredientes, recetas por producto y movimientos.
// Todo lo puede editar el dueño desde su panel (nombres, unidades, mínimos y recetas).
import { redis } from "./redis.js";
import { getMenu } from "./menu.js";

const K = (s) => `flama:${s}`;
const hoyAR = () => new Date(Date.now() - 6 * 3600e3).toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });

// Valores de ejemplo para la demo (el dueño los cambia en el panel)
const ING_BASE = {
  pan: { nombre: "Pan de papa", unidad: "unidades", cant: 120, min: 30 },
  carne: { nombre: "Medallones de carne", unidad: "medallones", cant: 180, min: 40 },
  cheddar: { nombre: "Cheddar", unidad: "fetas", cant: 300, min: 60 },
};
// Receta sugerida para productos nuevos (el dueño la ajusta en su panel)
function recetasBase(carta) {
  const r = {};
  for (const p of carta.productos) {
    if (p.tipo === "tamanos") {
      const ch = p.id === "rocket" ? 0 : p.id === "cuarto-de-kilo" ? 2 : 1;
      r[p.id] = { simple: { pan: 1, carne: 1, cheddar: ch }, doble: { pan: 1, carne: 2, cheddar: ch * 2 } };
    } else r[p.id] = { unidad: p.id === "sliders" ? { pan: 3, carne: 3, cheddar: 3 } : {} };
  }
  for (const e of carta.extras) r[e.id] = { unidad: e.id === "extra-carne" ? { carne: 1 } : {} };
  return r;
}

export async function getStock() {
  const [i, r] = await redis.mget(K("stock"), K("recetas"));
  let ing, rec;
  try { ing = JSON.parse(i); } catch {}
  try { rec = JSON.parse(r); } catch {}
  if (!ing) { ing = ING_BASE; await redis.set(K("stock"), JSON.stringify(ing)); }
  const base = recetasBase(await getMenu());
  rec = { ...base, ...(rec || {}) };
  return { ing, rec };
}
export const guardarIngredientes = (ing) => redis.set(K("stock"), JSON.stringify(ing));
export const guardarRecetas = (rec) => redis.set(K("recetas"), JSON.stringify(rec));

// Cuánto usa una lista de ítems (los mismos que arma el bot o la venta de mostrador)
export function consumo(items = [], rec) {
  const out = {};
  const sumar = (receta, n) => { for (const [k, v] of Object.entries(receta || {})) out[k] = (out[k] || 0) + Number(v || 0) * n; };
  for (const it of items) {
    const n = Math.max(1, Number(it.cantidad) || 1);
    const r = rec[it.id];
    if (!r) continue;
    const tam = r.unidad ? "unidad" : it.tamano === "doble" ? "doble" : "simple";
    const receta = { ...(r[tam] || {}) };
    if (it.veggie && receta.carne) delete receta.carne; // la veggie usa medallón vegetal
    sumar(receta, n);
    for (const e of it.extras || []) sumar(rec[e]?.unidad, n);
  }
  for (const k in out) if (!out[k]) delete out[k];
  return out;
}

// Aplica un movimiento (+ ingreso, − consumo/merma) y lo registra en el día
export async function mover(delta, tipo, nota = "") {
  const { ing } = await getStock();
  for (const [k, v] of Object.entries(delta)) if (ing[k]) ing[k].cant = Math.round((Number(ing[k].cant) + v) * 100) / 100;
  await guardarIngredientes(ing);
  const lk = K(`stocklog:${hoyAR()}`);
  let log = [];
  try { log = JSON.parse((await redis.get(lk)) || "[]"); } catch {}
  log.unshift({ t: Date.now(), tipo, delta, nota });
  await redis.set(lk, JSON.stringify(log.slice(0, 400)), { ex: 60 * 60 * 24 * 40 });
  await redis.incr(K("ver"));
  return ing;
}
export async function movimientos(dia = hoyAR()) {
  try { return JSON.parse((await redis.get(K(`stocklog:${dia}`))) || "[]"); } catch { return []; }
}

// Se llama cada vez que un pedido cambia de estado:
// descuenta cuando entra a cocina (ya pagado) y devuelve si se cancela.
const PAGADOS = ["programado", "en_preparacion", "listo", "en_camino", "entregado"];
export async function sincronizarStock(o) {
  if (!o.items) return;
  if (PAGADOS.includes(o.estado) && !o.stockOut) {
    const { rec } = await getStock();
    const c = consumo(o.items, rec);
    o.stockOut = c;
    await mover(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, -v])), "pedido", `Pedido #${o.id}`);
  } else if (o.estado === "cancelado" && o.stockOut) {
    await mover(o.stockOut, "devolucion", `Pedido #${o.id} cancelado`);
    o.stockOut = null;
  }
}

export function bajos(ing) {
  return Object.entries(ing).filter(([, v]) => Number(v.cant) <= Number(v.min)).map(([id, v]) => ({ id, nombre: v.nombre, cant: v.cant, unidad: v.unidad }));
}
