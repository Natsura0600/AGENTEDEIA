// Panel del dueño: resumen de caja, stock y recetas, personal, menú (precios, agotados, fotos) y ajustes.
import { redis } from "../lib/redis.js";
import { autorizar, CLAVE_EMPLEADOS } from "../lib/auth.js";
import { cajaHoy, cajaMes, panelState, avisos, guardarAvisos } from "../lib/orders.js";
import { getStock, guardarIngredientes, guardarRecetas, mover, movimientos, bajos } from "../lib/stock.js";
import { empleados, guardarEmpleado, borrarEmpleado, resumenMes, trabajandoAhora, editarFichaje, mesDe } from "../lib/personal.js";
import { getMenu, guardarCarta } from "../lib/menu.js";
import { sumarJSON, moverStock, usandoScripts } from "../lib/atomico.js";

export const config = { api: { bodyParser: { sizeLimit: "3mb" } } };
const mesOk = (m) => (/^\d{4}-\d{2}$/.test(m || "") ? m : mesDe());
// Ids seguros (evita "__proto__" y similares) y números con tope
const ID = /^[a-z0-9_-]{1,40}$/;
const idOk = (x) => { const v = String(x || ""); if (!ID.test(v) || v === "__proto__" || v === "constructor" || v === "prototype") throw new Error("Identificador inválido"); return v; };
const num = (v, max = 1e7) => { const n = Number(v); if (!isFinite(n) || Math.abs(n) > max) throw new Error("Número inválido"); return n; };
const slug = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24);

export default async function handler(req, res) {
  if (!(await autorizar(req, res, "dueno"))) return;
  try {
    if (req.method === "GET") return res.json(await leer(req.query.op, req.query));
    const b = req.body || {};
    await escribir(b);
    return res.json({ ok: true, ...(await leer(b.vista || "", b)) });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
}

async function leer(op, q) {
  if (op === "resumen") {
    const mes = mesOk(q.mes);
    const [hoy, dias, st] = await Promise.all([cajaHoy(), cajaMes(mes), panelState()]);
    const prod = {};
    for (const d of dias) for (const [k, v] of Object.entries(d.productos || {})) prod[k] = (prod[k] || 0) + v;
    const top = Object.entries(prod).sort((a, b) => b[1] - a[1]).slice(0, 8);
    return { mes, hoy, dias, top, botOn: st.botOn };
  }
  if (op === "stock") {
    const { ing, rec } = await getStock();
    const c = await getMenu(true);
    const productos = [
      ...c.productos.filter((p) => p.estado !== "oculto").map((p) => ({ id: p.id, nombre: p.nombre, tams: p.tipo === "tamanos" ? ["simple", "doble"] : ["unidad"] })),
      ...c.extras.map((e) => ({ id: e.id, nombre: e.nombre, tams: ["unidad"] })),
    ];
    return { ing, rec, productos, bajos: bajos(ing), movimientos: (await movimientos()).slice(0, 60) };
  }
  if (op === "personal") {
    const mes = mesOk(q.mes);
    const [r, ahora] = await Promise.all([resumenMes(mes), trabajandoAhora()]);
    return { mes, ...r, ahora };
  }
  if (op === "menu") {
    const [carta, fotos] = await Promise.all([getMenu(true), redis.get("flama:fotos")]);
    return { carta, fotos: JSON.parse(fotos || "{}") };
  }
  // Chequeo de mantenimiento: confirma que Upstash corre los scripts atómicos (caja y stock)
  if (op === "diag") {
    const k = `flama:diag:${Date.now()}`;
    await Promise.all(Array.from({ length: 10 }, () => sumarJSON(k, { n: 1, sub: { a: 2 } }, 60)));
    const r = JSON.parse(await redis.get(k)); await redis.del(k);
    const sk = `flama:diag:st:${Date.now()}`, lk = sk + ":log";
    await redis.set(sk, JSON.stringify({ x: { nombre: "x", cant: 10 } }), { ex: 60 });
    await Promise.all(Array.from({ length: 5 }, () => moverStock(sk, lk, { x: -1 }, { t: Date.now(), tipo: "diag" }, 60)));
    const st = JSON.parse(await redis.get(sk)); await redis.del(sk, lk);
    return { scripts: usandoScripts(), caja: r.n === 10 && r.sub.a === 20, stock: st.x.cant === 5 };
  }
  if (op === "ajustes") {
    const st = await panelState();
    return { botOn: st.botOn, claveEmpleados: CLAVE_EMPLEADOS(), avisos: await avisos(true) };
  }
  return {};
}

async function escribir(b) {
  switch (b.op) {
    // ---- stock ----
    case "mov": { // ingreso (+), merma (−) o conteo (fija el valor real)
      const { ing } = await getStock();
      const iid = idOk(b.ing); if (!Object.hasOwn(ing, iid)) throw new Error("No existe ese ingrediente");
      if (!["ingreso", "merma", "conteo"].includes(b.tipo)) throw new Error("Movimiento inválido");
      const n = num(b.cant, 1e6), it = ing[iid];
      const delta = b.tipo === "conteo" ? n - Number(it.cant) : b.tipo === "merma" ? -Math.abs(n) : Math.abs(n);
      await mover({ [iid]: delta }, b.tipo, String(b.nota || "").slice(0, 120)); return;
    }
    case "ing": { // crear o editar ingrediente (nombre, unidad, mínimo)
      const { ing } = await getStock();
      const id = b.id ? idOk(b.id) : slug(b.nombre);
      if (!id || !String(b.nombre || "").trim()) throw new Error("Falta el nombre");
      if (!b.id && Object.keys(ing).length >= 60) throw new Error("Máximo 60 ingredientes");
      if (!b.id && ing[id]) throw new Error("Ya existe un ingrediente con ese nombre");
      ing[id] = { nombre: String(b.nombre).trim().slice(0, 40), unidad: String(b.unidad || "unidades").trim().slice(0, 20), cant: Object.hasOwn(ing, id) ? ing[id].cant : num(b.cant || 0, 1e6), min: Math.max(0, num(b.min || 0, 1e6)) };
      await guardarIngredientes(ing); return;
    }
    case "ing_borrar": {
      const { ing, rec } = await getStock(); const iid = idOk(b.id); delete ing[iid];
      for (const p of Object.values(rec)) for (const t of Object.values(p)) delete t[iid];
      await guardarIngredientes(ing); await guardarRecetas(rec); return;
    }
    case "recetas": { // { id: { simple: {pan:1,...}, doble: {...} } }
      const { rec } = await getStock();
      for (const [pidRaw, tams] of Object.entries(b.recetas || {})) {
        const pid = idOk(pidRaw);
        rec[pid] = Object.hasOwn(rec, pid) ? rec[pid] : {};
        for (const [t, r] of Object.entries(tams || {})) {
          if (!["simple", "doble", "unidad"].includes(t)) throw new Error("Tamaño inválido");
          rec[pid][t] = Object.fromEntries(Object.entries(r || {}).map(([k, v]) => [idOk(k), Math.min(100, Math.max(0, Number(v) || 0))]).filter(([, v]) => v > 0));
        }
      }
      await guardarRecetas(rec); return;
    }
    // ---- personal ----
    case "emp": await guardarEmpleado(b.emp || {}); return;
    case "emp_borrar": await borrarEmpleado(String(b.id || "")); return;
    case "fich": await editarFichaje({ mes: mesOk(b.mes), id: b.id, inT: b.in, outT: b.out, emp: b.emp, borrar: b.borrar }); return;
    // ---- menú ----
    case "carta": await guardarCarta(b.carta); return;
    case "foto": { // imagen ya achicada en el navegador (webp/jpeg en base64)
      b.id = String(b.id || "").replace(/[^a-z0-9-]/gi, "").slice(0, 40); if (!b.id) throw new Error("Producto inválido");
      const fotos = JSON.parse((await redis.get("flama:fotos")) || "{}");
      if (b.borrar) { await redis.del(`flama:foto:${b.id}`); delete fotos[b.id]; }
      else {
        const m = String(b.data || "").match(/^data:(image\/(webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/);
        if (!m) throw new Error("Imagen inválida");
        if (m[3].length > 700000) throw new Error("La foto es muy pesada");
        await redis.set(`flama:foto:${b.id}`, `${m[1]}|${m[3]}`);
        fotos[b.id] = Date.now().toString(36);
      }
      await redis.set("flama:fotos", JSON.stringify(fotos)); await redis.incr("flama:menuv"); return;
    }
    // ---- ajustes ----
    case "bot": await redis.set("flama:bot_off", b.on ? "0" : "1"); return;
    case "avisos": await guardarAvisos(b.avisos || {}); return;
    default: throw new Error("Operación desconocida");
  }
}
