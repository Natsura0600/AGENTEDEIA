// Panel del dueño: resumen de caja, stock y recetas, personal, menú (precios, agotados, fotos) y ajustes.
import { redis } from "../lib/redis.js";
import { rol, CLAVE_EMPLEADOS } from "../lib/auth.js";
import { cajaHoy, cajaMes, panelState } from "../lib/orders.js";
import { getStock, guardarIngredientes, guardarRecetas, mover, movimientos, bajos } from "../lib/stock.js";
import { empleados, guardarEmpleado, borrarEmpleado, resumenMes, trabajandoAhora, editarFichaje, mesDe } from "../lib/personal.js";
import { getMenu, getCambiosMenu, guardarCambiosMenu, menuBase } from "../lib/menu.js";

export const config = { api: { bodyParser: { sizeLimit: "3mb" } } };
const mesOk = (m) => (/^\d{4}-\d{2}$/.test(m || "") ? m : mesDe());
const slug = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24);

export default async function handler(req, res) {
  if (rol(req.query.key) !== "dueno") return res.status(401).json({ error: "Clave incorrecta" });
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
    const m = menuBase();
    const productos = [
      ...m.HAMBURGUESAS.map((h) => ({ id: h.id, nombre: h.nombre, tams: ["simple", "doble"] })),
      { id: "sliders", nombre: "Sliders x3", tams: ["unidad"] },
      { id: "extra-carne", nombre: "Extra carne", tams: ["unidad"] },
      { id: "extra-bacon", nombre: "Extra bacon", tams: ["unidad"] },
      ...m.BEBIDAS.map((b) => ({ id: b.id, nombre: b.nombre, tams: ["unidad"] })),
    ];
    return { ing, rec, productos, bajos: bajos(ing), movimientos: (await movimientos()).slice(0, 60) };
  }
  if (op === "personal") {
    const mes = mesOk(q.mes);
    const [r, ahora] = await Promise.all([resumenMes(mes), trabajandoAhora()]);
    return { mes, ...r, ahora };
  }
  if (op === "menu") {
    const [menu, cambios, fotos] = await Promise.all([getMenu(true), getCambiosMenu(), redis.get("flama:fotos")]);
    return { menu, cambios, fotos: JSON.parse(fotos || "{}") };
  }
  if (op === "ajustes") {
    const st = await panelState();
    return { botOn: st.botOn, claveEmpleados: CLAVE_EMPLEADOS() };
  }
  return {};
}

async function escribir(b) {
  switch (b.op) {
    // ---- stock ----
    case "mov": { // ingreso (+), merma (−) o conteo (fija el valor real)
      const { ing } = await getStock();
      const it = ing[b.ing]; if (!it) throw new Error("No existe ese ingrediente");
      const n = Number(b.cant); if (!isFinite(n)) throw new Error("Cantidad inválida");
      const delta = b.tipo === "conteo" ? n - Number(it.cant) : b.tipo === "merma" ? -Math.abs(n) : Math.abs(n);
      await mover({ [b.ing]: delta }, b.tipo, b.nota || ""); return;
    }
    case "ing": { // crear o editar ingrediente (nombre, unidad, mínimo)
      const { ing } = await getStock();
      const id = b.id || slug(b.nombre);
      if (!id || !String(b.nombre || "").trim()) throw new Error("Falta el nombre");
      if (!b.id && ing[id]) throw new Error("Ya existe un ingrediente con ese nombre");
      ing[id] = { nombre: String(b.nombre).trim().slice(0, 40), unidad: String(b.unidad || "unidades").trim().slice(0, 20), cant: ing[id]?.cant ?? Number(b.cant || 0), min: Number(b.min) || 0 };
      await guardarIngredientes(ing); await redis.incr("flama:ver"); return;
    }
    case "ing_borrar": {
      const { ing, rec } = await getStock(); delete ing[b.id];
      for (const p of Object.values(rec)) for (const t of Object.values(p)) delete t[b.id];
      await guardarIngredientes(ing); await guardarRecetas(rec); await redis.incr("flama:ver"); return;
    }
    case "recetas": { // { id: { simple: {pan:1,...}, doble: {...} } }
      const { rec } = await getStock();
      for (const [pid, tams] of Object.entries(b.recetas || {})) {
        rec[pid] = rec[pid] || {};
        for (const [t, r] of Object.entries(tams)) rec[pid][t] = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.max(0, Number(v) || 0)]).filter(([, v]) => v > 0));
      }
      await guardarRecetas(rec); return;
    }
    // ---- personal ----
    case "emp": await guardarEmpleado(b.emp || {}); return;
    case "emp_borrar": await borrarEmpleado(b.id); return;
    case "fich": await editarFichaje({ mes: mesOk(b.mes), id: b.id, inT: b.in, outT: b.out, emp: b.emp, borrar: b.borrar }); return;
    // ---- menú ----
    case "menu": await guardarCambiosMenu(b.cambios || {}); await redis.incr("flama:menuv"); return;
    case "foto": { // imagen ya achicada en el navegador (webp/jpeg en base64)
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
    default: throw new Error("Operación desconocida");
  }
}
