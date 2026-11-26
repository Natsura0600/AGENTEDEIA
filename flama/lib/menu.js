import { redis } from "./redis.js";

// Datos del local (horarios, alias, demoras).
export const LOCAL = {
  nombre: "Flama",
  direccion: "Mitre 670, Luján",
  instagram: "@flama_birra_burgers",
  alias: process.env.ALIAS || "FLAMA.BURGERS.MP",
  titular: process.env.TITULAR || "Flama Burgers",
  // Horario de atención (hora de Argentina). [día 0=dom..6=sáb]: [abre, cierra] en horas
  horarios: { 0: [19.5, 24], 2: [19.5, 24], 3: [19.5, 24], 4: [19.5, 24], 5: [19.5, 25], 6: [19.5, 25] },
  horarioTexto: "martes a domingo de 19:30 a 00:00 (viernes y sábado hasta la 01:00)",
  demoras: { retiro: "25 a 35 minutos", envio: "40 a 55 minutos" },
};

// ---------------- Carta inicial (después la edita el dueño desde su panel) ----------------
const BURGERS = [
  ["cheese-burger", "Cheese Burger", "Carne, cheddar", 13500, 15000, ""],
  ["cheese-2", "Cheese 2.0", "Carne, cheddar, cebolla crispy, bacon, barbacoa, alioli", 14500, 16000, "Nueva"],
  ["all-american", "All American", "Carne, cheddar, mayonesa ahumada, bacon, tomate, cebolla, pepinillos, lechuga", 14500, 16000, ""],
  ["cuarto-de-kilo", "Cuarto de Kilo", "Carne, doble cheddar, relish, mostaza, ketchup, cebolla picada", 14500, 16000, ""],
  ["big-magia", "Big Magia", "Carne, cheddar, pepinillos, lechuga, cebolla, salsa mil islas", 14500, 16000, ""],
  ["oklahoma", "Oklahoma", "Carne smash, cheddar, bacon, cebolla grillada", 14500, 16000, "Más pedida"],
  ["rocket", "Rocket", "Carne, roquefort, bacon, cebolla caramelizada", 14500, 16000, ""],
  ["anderson", "Anderson", "Carne, cheddar, dambo, bacon, huevo, champi, alioli", 15500, 17000, "La más cargada"],
];
const BEBIDAS = [
  ["coca", "Coca-Cola", "Botella 500 ml", 2500], ["coca-zero", "Coca-Cola Zero", "Botella 500 ml", 2500],
  ["sprite", "Sprite", "Botella 500 ml", 2500], ["fanta", "Fanta", "Botella 500 ml", 2500],
  ["agua", "Agua sin gas", "Botella 500 ml", 2000], ["agua-gas", "Agua con gas", "Botella 500 ml", 2000],
  ["saborizada", "Agua saborizada", "Pomelo, naranja o manzana. 500 ml", 2300], ["limonada", "Limonada casera", "Con menta y jengibre. 500 ml", 3500],
  ["coca-15", "Coca-Cola 1,5 L", "Para compartir", 4500],
];
export function cartaBase() {
  return {
    categorias: [
      { id: "burgers", nombre: "Hamburguesas", nota: "Todas vienen con papas. Todas pueden ser veggies." },
      { id: "sliders", nombre: "Sliders", nota: "" },
      { id: "bebidas", nombre: "Bebidas", nota: "" },
    ],
    productos: [
      ...BURGERS.map(([id, nombre, desc, simple, doble, etiqueta]) => ({ id, cat: "burgers", nombre, desc, tipo: "tamanos", simple, doble, precio: 0, extras: true, veggie: true, etiqueta, estado: "disponible" })),
      { id: "sliders", cat: "sliders", nombre: "Sliders x3", desc: "Tres mini burgers, carne 80 g, pan de papa, cheddar, manteca de ajo", tipo: "unico", precio: 19500, simple: 0, doble: 0, extras: false, veggie: false, etiqueta: "Para compartir", estado: "disponible" },
      ...BEBIDAS.map(([id, nombre, desc, precio]) => ({ id, cat: "bebidas", nombre, desc, tipo: "unico", precio, simple: 0, doble: 0, extras: false, veggie: false, etiqueta: "", estado: "disponible" })),
    ],
    extras: [
      { id: "extra-carne", nombre: "Extra carne", precio: 2000, agotado: false },
      { id: "extra-bacon", nombre: "Extra bacon", precio: 2000, agotado: false },
    ],
    zonas: [
      { id: "centro", nombre: "Centro (hasta 15 cuadras)", precio: 1500 },
      { id: "cercana", nombre: "Barrios cercanos (San Jorge, Padre Varela, Lanusse, El Quinto)", precio: 2500 },
      { id: "lejana", nombre: "Barrios alejados (Jáuregui, Open Door, Olivera, Pueblo Nuevo)", precio: 4000 },
    ],
  };
}

// ---------------- Normalizar lo que guarda el dueño ----------------
export const slug = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "item";
const txt = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const plata = (n) => Math.max(0, Math.round(Number(n) || 0));
function unico(base, usados) { let id = slug(base), i = 2; while (usados.has(id)) id = `${slug(base)}-${i++}`; usados.add(id); return id; }

export function normalizar(c) {
  if (!c || !Array.isArray(c.categorias) || !Array.isArray(c.productos)) throw new Error("Carta inválida");
  const ids = new Set();
  const categorias = c.categorias.map((x) => ({ id: x.id && !ids.has(x.id) ? (ids.add(x.id), x.id) : unico(x.nombre || "categoria", ids), nombre: txt(x.nombre, 40) || "Sin nombre", nota: txt(x.nota, 160) })).filter((x) => x.nombre);
  if (!categorias.length) throw new Error("Tiene que haber al menos una categoría");
  const cats = new Set(categorias.map((x) => x.id));
  const pids = new Set();
  const productos = c.productos.map((p) => {
    const tipo = p.tipo === "tamanos" ? "tamanos" : "unico";
    const o = {
      id: p.id && /^[a-z0-9-]+$/.test(p.id) && !pids.has(p.id) ? (pids.add(p.id), p.id) : unico(p.nombre || "producto", pids),
      cat: cats.has(p.cat) ? p.cat : categorias[0].id,
      nombre: txt(p.nombre, 50), desc: txt(p.desc, 240), tipo,
      simple: tipo === "tamanos" ? plata(p.simple) : 0, doble: tipo === "tamanos" ? plata(p.doble) : 0, precio: tipo === "unico" ? plata(p.precio) : 0,
      extras: tipo === "tamanos" && p.extras !== false, veggie: tipo === "tamanos" && p.veggie !== false,
      etiqueta: txt(p.etiqueta, 24), estado: ["disponible", "agotado", "oculto"].includes(p.estado) ? p.estado : "disponible",
    };
    if (!o.nombre) throw new Error("Hay un producto sin nombre");
    if (tipo === "tamanos" && (!o.simple || !o.doble)) throw new Error(`Falta el precio simple o doble de ${o.nombre}`);
    if (tipo === "unico" && !o.precio) throw new Error(`Falta el precio de ${o.nombre}`);
    return o;
  });
  const eids = new Set();
  const extras = (c.extras || []).map((e) => ({ id: e.id && !eids.has(e.id) ? (eids.add(e.id), e.id) : "extra-" + unico(e.nombre || "extra", eids), nombre: txt(e.nombre, 40), precio: plata(e.precio), agotado: !!e.agotado })).filter((e) => e.nombre);
  const zids = new Set();
  const zonas = (c.zonas || []).map((z) => ({ id: z.id && !zids.has(z.id) ? (zids.add(z.id), z.id) : unico(z.nombre || "zona", zids), nombre: txt(z.nombre, 90), precio: plata(z.precio) })).filter((z) => z.nombre);
  return { categorias, productos, extras, zonas };
}

// ---------------- Leer y guardar la carta ----------------
let cache = { t: 0, c: null };
export async function getMenu(fresh = false) {
  if (!fresh && cache.c && Date.now() - cache.t < 20000) return cache.c;
  let c = null;
  try { c = JSON.parse(await redis.get("flama:carta")); } catch {}
  if (!c) {
    c = cartaBase();
    // Pasa los precios y agotados que el dueño ya había cambiado con la versión anterior del panel
    try {
      const ov = JSON.parse((await redis.get("flama:menu")) || "{}");
      for (const p of c.productos) {
        const pr = ov.precios?.[p.id];
        if (pr?.simple) p.simple = pr.simple; if (pr?.doble) p.doble = pr.doble; if (pr?.precio) p.precio = pr.precio;
        if (ov.agotado?.[p.id]) p.estado = "agotado";
      }
      for (const e of c.extras) { if (ov.extras?.[e.id]) e.precio = ov.extras[e.id]; if (ov.agotado?.[e.id]) e.agotado = true; }
      for (const z of c.zonas) if (ov.zonas?.[z.id]) z.precio = ov.zonas[z.id];
    } catch {}
    await redis.set("flama:carta", JSON.stringify(c));
  }
  cache = { t: Date.now(), c };
  return c;
}
export async function guardarCarta(c) {
  const limpio = normalizar(c);
  await redis.set("flama:carta", JSON.stringify(limpio));
  await redis.incr("flama:menuv");
  cache = { t: 0, c: null };
  return limpio;
}
export const visibles = (c) => c.productos.filter((p) => p.estado !== "oculto");

// ---------------- Texto del menú para el bot ----------------
const $ = (n) => "$" + Number(n).toLocaleString("es-AR");
export function menuTexto(c = cartaBase()) {
  const bloques = c.categorias.map((cat) => {
    const ps = visibles(c).filter((p) => p.cat === cat.id);
    if (!ps.length) return "";
    const lineas = ps.map((p) => {
      const precio = p.tipo === "tamanos" ? `simple ${$(p.simple)} / doble ${$(p.doble)}` : $(p.precio);
      return `- ${p.nombre} [id: ${p.id}]${p.desc ? ` (${p.desc})` : ""}: ${precio}${p.etiqueta ? ` · ${p.etiqueta}` : ""}${p.estado === "agotado" ? " (AGOTADO HOY: no se puede pedir)" : ""}`;
    });
    return `${cat.nombre.toUpperCase()}${cat.nota ? ` — ${cat.nota}` : ""}\n${lineas.join("\n")}`;
  }).filter(Boolean);
  const ex = c.extras.map((e) => `- ${e.nombre} [id: ${e.id}]: ${$(e.precio)}${e.agotado ? " (AGOTADO HOY)" : ""}`).join("\n");
  const zs = c.zonas.map((z) => `- ${z.nombre} [id: ${z.id}]: ${$(z.precio)}`).join("\n");
  return `${bloques.join("\n\n")}\n\nEXTRAS (solo para productos con simple/doble; por unidad, se pueden repetir: ej. 2 extra carne)\n${ex}\n\nDELIVERY\n${zs}\n- Retiro en el local (${LOCAL.direccion}): sin cargo`;
}

// ¿Está abierto ahora? (hora Argentina)
export function abierto(d = new Date()) {
  const ar = new Date(d.toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
  const h = ar.getHours() + ar.getMinutes() / 60;
  const hoy = LOCAL.horarios[ar.getDay()];
  const ayer = LOCAL.horarios[(ar.getDay() + 6) % 7];
  if (hoy && h >= hoy[0] && h < Math.min(hoy[1], 24)) return true;
  if (ayer && ayer[1] > 24 && h < ayer[1] - 24) return true; // pasada la medianoche
  return false;
}

// Calcula el total a partir de los ítems (precios de la carta, nunca del modelo)
export function calcular(items, entrega, zonaId, c = cartaBase()) {
  let total = 0;
  const lineas = [];
  for (const it of items) {
    const cant = Math.max(1, Number(it.cantidad) || 1);
    const p = visibles(c).find((x) => x.id === it.id);
    if (!p) throw new Error(`No existe el producto ${it.id}`);
    if (p.estado === "agotado") throw new Error(`${p.nombre} está agotado hoy`);
    let precio, nombre;
    if (p.tipo === "tamanos") {
      const tam = it.tamano === "doble" ? "doble" : "simple";
      precio = p[tam]; nombre = `${p.nombre} ${tam}${it.veggie && p.veggie ? " veggie" : ""}`;
    } else { precio = p.precio; nombre = p.nombre; }
    const extras = p.extras ? (it.extras || []).map((id) => c.extras.find((e) => e.id === id)).filter(Boolean) : [];
    for (const e of extras) if (e.agotado) throw new Error(`${e.nombre} está agotado hoy`);
    precio += extras.reduce((s, e) => s + e.precio, 0);
    const cnt = {}; extras.forEach((e) => (cnt[e.nombre] = (cnt[e.nombre] || 0) + 1));
    const ext = extras.length ? ` + ${Object.entries(cnt).map(([n, k]) => `${k > 1 ? k + " " : ""}${n.toLowerCase()}`).join(", ")}` : "";
    const nota = it.nota ? ` (${it.nota})` : "";
    lineas.push({ texto: `${cant}x ${nombre}${ext}${nota}`, subtotal: precio * cant });
    total += precio * cant;
  }
  let envio = 0;
  if (entrega === "envio") {
    const z = c.zonas.find((x) => x.id === zonaId);
    if (!z) throw new Error("Falta la zona de envío");
    envio = z.precio;
  }
  return { lineas, envio, total: total + envio };
}
