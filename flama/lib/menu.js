// Datos del local. Editá acá menú, precios, zonas, horarios y alias.
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

export const HAMBURGUESAS = [
  { id: "cheese-burger", nombre: "Cheese Burger", desc: "carne, cheddar", simple: 13500, doble: 15000 },
  { id: "cheese-2", nombre: "Cheese 2.0", desc: "carne, cheddar, cebolla crispy, bacon, barbacoa, alioli", simple: 14500, doble: 16000 },
  { id: "all-american", nombre: "All American", desc: "carne, cheddar, mayonesa ahumada, bacon, tomate, cebolla, pepinillos, lechuga", simple: 14500, doble: 16000 },
  { id: "cuarto-de-kilo", nombre: "Cuarto de Kilo", desc: "carne, doble cheddar, relish, mostaza, ketchup, cebolla picada", simple: 14500, doble: 16000 },
  { id: "big-magia", nombre: "Big Magia", desc: "carne, cheddar, pepinillos, lechuga, cebolla, salsa mil islas", simple: 14500, doble: 16000 },
  { id: "oklahoma", nombre: "Oklahoma", desc: "carne smash, cheddar, bacon, cebolla grillada", simple: 14500, doble: 16000 },
  { id: "rocket", nombre: "Rocket", desc: "carne, roquefort, bacon, cebolla caramelizada", simple: 14500, doble: 16000 },
  { id: "anderson", nombre: "Anderson", desc: "carne, cheddar, dambo, bacon, huevo, champi, alioli", simple: 15500, doble: 17000 },
];
export const SLIDERS = { id: "sliders", nombre: "Sliders (3 unidades)", desc: "carne 80 g, pan de papa, cheddar, manteca de ajo", precio: 19500 };
export const EXTRAS = { "extra-carne": { nombre: "Extra carne", precio: 2000 }, "extra-bacon": { nombre: "Extra bacon", precio: 2000 } };
// Bebidas (precios de ejemplo para la demo)
export const BEBIDAS = [
  { id: "coca", nombre: "Coca-Cola 500 ml", precio: 2500 },
  { id: "coca-zero", nombre: "Coca-Cola Zero 500 ml", precio: 2500 },
  { id: "sprite", nombre: "Sprite 500 ml", precio: 2500 },
  { id: "fanta", nombre: "Fanta 500 ml", precio: 2500 },
  { id: "agua", nombre: "Agua sin gas 500 ml", precio: 2000 },
  { id: "agua-gas", nombre: "Agua con gas 500 ml", precio: 2000 },
  { id: "saborizada", nombre: "Agua saborizada 500 ml", precio: 2300 },
  { id: "limonada", nombre: "Limonada casera 500 ml", precio: 3500 },
  { id: "coca-15", nombre: "Coca-Cola 1,5 L", precio: 4500 },
];
export const NOTAS_MENU = "Todas las hamburguesas vienen con papas y todas pueden ser veggies.";

// Zonas de delivery (precios de ejemplo para la demo)
export const ZONAS = [
  { id: "centro", nombre: "Centro (hasta 15 cuadras)", precio: 1500 },
  { id: "cercana", nombre: "Barrios cercanos (San Jorge, Padre Varela, Lanusse, El Quinto)", precio: 2500 },
  { id: "lejana", nombre: "Barrios alejados (Jáuregui, Open Door, Olivera, Pueblo Nuevo)", precio: 4000 },
];

export function menuTexto() {
  const hs = HAMBURGUESAS.map((h) => `- ${h.nombre} (${h.desc}): simple $${h.simple} / doble $${h.doble}`).join("\n");
  const ex = Object.values(EXTRAS).map((e) => `- ${e.nombre}: $${e.precio}`).join("\n");
  const zs = ZONAS.map((z) => `- ${z.nombre}: $${z.precio}`).join("\n");
  const bs = BEBIDAS.map((b) => `- ${b.nombre}: $${b.precio}`).join("\n");
  return `HAMBURGUESAS\n${hs}\n- ${SLIDERS.nombre} (${SLIDERS.desc}): $${SLIDERS.precio}\n${NOTAS_MENU}\n\nEXTRAS (por unidad, se pueden repetir: ej. 2 extra carne)\n${ex}\n\nBEBIDAS\n${bs}\n\nDELIVERY\n${zs}\n- Retiro en el local (${LOCAL.direccion}): sin cargo`;
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

// Calcula el total a partir de los ítems (precios del menú, no del modelo)
export function calcular(items, entrega, zonaId) {
  let total = 0;
  const lineas = [];
  for (const it of items) {
    const cant = Math.max(1, Number(it.cantidad) || 1);
    let precio, nombre;
    const beb = BEBIDAS.find((b) => b.id === it.id);
    if (beb) { precio = beb.precio; nombre = beb.nombre; }
    else if (it.id === "sliders") { precio = SLIDERS.precio; nombre = SLIDERS.nombre; }
    else {
      const h = HAMBURGUESAS.find((x) => x.id === it.id);
      if (!h) throw new Error(`No existe el producto ${it.id}`);
      const tam = it.tamano === "doble" ? "doble" : "simple";
      precio = h[tam]; nombre = `${h.nombre} ${tam}${it.veggie ? " veggie" : ""}`;
    }
    const extras = (it.extras || []).filter((e) => EXTRAS[e]);
    precio += extras.reduce((s, e) => s + EXTRAS[e].precio, 0);
    const cnt = {}; extras.forEach((e) => (cnt[e] = (cnt[e] || 0) + 1));
    const ext = extras.length ? ` + ${Object.entries(cnt).map(([e, n]) => `${n > 1 ? n + " " : ""}${EXTRAS[e].nombre.toLowerCase()}`).join(", ")}` : "";
    const nota = it.nota ? ` (${it.nota})` : "";
    lineas.push({ texto: `${cant}x ${nombre}${ext}${nota}`, subtotal: precio * cant });
    total += precio * cant;
  }
  let envio = 0;
  if (entrega === "envio") {
    const z = ZONAS.find((x) => x.id === zonaId);
    if (!z) throw new Error("Falta la zona de envío");
    envio = z.precio;
  }
  return { lineas, envio, total: total + envio };
}
