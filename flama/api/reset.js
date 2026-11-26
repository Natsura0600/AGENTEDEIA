// Mantenimiento de datos de Flama en Upstash (solo con la clave del dueño).
//   /api/reset?key=CLAVE_DUENO&confirmar=si                  → borra TODO (menú, stock, personal, pedidos...)
//   /api/reset?key=CLAVE_DUENO&confirmar=si&solo=pedidos     → borra pedidos, chats y caja, y devuelve al stock
//                                                             lo que esos pedidos descontaron (menú, recetas,
//                                                             personal y movimientos manuales de stock quedan)
//   /api/reset?key=CLAVE_DUENO&confirmar=si&quitar_foto=ID   → saca la foto de un producto del menú
import { redis } from "../lib/redis.js";
import { rol } from "../lib/auth.js";

const DE_PEDIDOS = /^flama:(order|orders|active|hist|outbox|seen|op|caja):/;

async function todasLasClaves() {
  let cursor = "0";
  const out = [];
  do {
    const [next, keys] = await redis.scan(cursor, { match: "flama:*", count: 500 });
    cursor = String(next);
    out.push(...keys);
  } while (cursor !== "0");
  return out;
}

async function borrarPedidos(claves) {
  // 1) Revertir en el stock solo los movimientos que hicieron los pedidos
  const devolver = {};
  let movimientosQuitados = 0;
  for (const lk of claves.filter((k) => k.startsWith("flama:stocklog:"))) {
    let log = [];
    try { log = JSON.parse((await redis.get(lk)) || "[]"); } catch {}
    const quedan = [];
    for (const m of log) {
      if (m.tipo === "pedido" || m.tipo === "devolucion") {
        for (const [ing, v] of Object.entries(m.delta || {})) devolver[ing] = (devolver[ing] || 0) - Number(v);
        movimientosQuitados++;
      } else quedan.push(m);
    }
    if (quedan.length === log.length) continue;
    if (quedan.length) await redis.set(lk, JSON.stringify(quedan), { ex: 60 * 60 * 24 * 40 });
    else await redis.del(lk);
  }
  let stock = null;
  if (Object.keys(devolver).length) {
    try { stock = JSON.parse((await redis.get("flama:stock")) || "null"); } catch {}
    if (stock) {
      for (const [k, v] of Object.entries(devolver)) if (stock[k]) stock[k].cant = Math.round((Number(stock[k].cant) + v) * 100) / 100;
      await redis.set("flama:stock", JSON.stringify(stock));
    }
  }
  // 2) Borrar pedidos, listas del día, chats, mensajes pendientes, comprobantes usados y caja
  const borrar = claves.filter((k) => DE_PEDIDOS.test(k) || k === "flama:seq");
  for (let i = 0; i < borrar.length; i += 100) await redis.del(...borrar.slice(i, i + 100));
  await redis.incr("flama:ver"); // los paneles abiertos se actualizan solos
  const pedidos = borrar.filter((k) => k.startsWith("flama:order:")).length;
  return {
    ok: true,
    pedidosBorrados: pedidos,
    clavesBorradas: borrar.length,
    movimientosDeStockQuitados: movimientosQuitados,
    stockDevuelto: devolver,
    stockAhora: stock ? Object.fromEntries(Object.entries(stock).map(([k, v]) => [k, v.cant])) : null,
  };
}

async function quitarFoto(id) {
  const fotos = JSON.parse((await redis.get("flama:fotos")) || "{}");
  const tenia = id in fotos;
  delete fotos[id];
  await redis.del(`flama:foto:${id}`);
  await redis.set("flama:fotos", JSON.stringify(fotos));
  await redis.incr("flama:menuv");
  return { ok: true, fotoQuitada: id, tenia, quedanFotos: Object.keys(fotos) };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (rol(req.query.key) !== "dueno") return res.status(401).json({ error: "Clave incorrecta" });
  if (req.query.confirmar !== "si") return res.status(400).json({ error: "Agregá &confirmar=si" });
  if (typeof redis.scan !== "function") return res.json({ borradas: 0, nota: "Upstash no está conectado" });

  if (req.query.quitar_foto) {
    const id = String(req.query.quitar_foto).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 60);
    return res.json(await quitarFoto(id));
  }
  const claves = await todasLasClaves();
  if (req.query.solo === "pedidos") return res.json(await borrarPedidos(claves));

  for (let i = 0; i < claves.length; i += 100) await redis.del(...claves.slice(i, i + 100));
  res.json({ ok: true, borradas: claves.length });
}
