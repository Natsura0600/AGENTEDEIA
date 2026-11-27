// Preview de Flama: ubica una dirección en Luján y devuelve los km al local (Mitre 670).
// Independiente de la demo: no usa base de datos (guarda en memoria y en la caché de Vercel).
// GET /api/envio?dir=Belgrano 1234  →  { encontrada, km, exacta, texto, lat, lng }
const LOCAL = { lat: -34.567525, lng: -59.113401 }; // Bartolomé Mitre 670, Luján (Georef)

// Caja que cubre todo el partido de Luján (Luján, Jáuregui, Open Door, Olivera, Torres, Carlos Keen, Cortínez)
const CAJA = { latMin: -34.8, latMax: -34.35, lngMin: -59.45, lngMax: -58.9 };
const CENTRO_LUJAN = { lat: -34.5636, lng: -59.1208, aprox: true }; // si no se pudo ubicar el local
const LOCALIDADES = ["Jáuregui", "Open Door", "Olivera", "Torres", "Carlos Keen", "Cortínez"];
// Centro aproximado de cada localidad: Georef a veces marca sus calles como "Luján", así que también se mira la cercanía
const CENTROS = { "Jáuregui": [-34.602, -59.174], "Open Door": [-34.489, -59.079], "Olivera": [-34.629, -59.253], "Torres": [-34.432, -59.129], "Carlos Keen": [-34.487, -59.218], "Cortínez": [-34.553, -59.208] };
const dentro = (p) => p && p.lat >= CAJA.latMin && p.lat <= CAJA.latMax && p.lng >= CAJA.lngMin && p.lng <= CAJA.lngMax;
const sinTilde = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function distanciaKm(a, b) {
  const r = (x) => (x * Math.PI) / 180, R = 6371;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// "Belgrano al 1234 entre Mitre y Rivadavia, depto 3, Luján" → calle "Belgrano 1234", localidad null
export function limpiarDireccion(d) {
  const partes = String(d || "").replace(/\([^)]*\)?/g, " ").replace(/\s+/g, " ").trim().split(",");
  // La localidad solo se toma de lo que va después de una coma ("San Martín 120, Jáuregui")
  const resto = sinTilde(partes.slice(1).join(","));
  const loc = LOCALIDADES.find((l) => resto.includes(sinTilde(l))) || null;
  let s = partes[0]
    .replace(/\s+(entre|e\/)\s+.*$/i, "")
    .replace(/[,\s]+(piso|dpto\.?|depto\.?|departamento|dto\.?|timbre|of\.?|oficina|torre|bloque|lote|mz\.?|manzana|casa)\b.*$/i, "")
    .replace(/\bal\s+(\d+)/i, "$1")
    .replace(/\b(n[°º]|nro\.?|n[uú]mero)\s*/gi, "")
    .replace(/[,.;\s]+$/g, "")
    .trim();
  return { calle: s, localidad: loc };
}

const conTiempo = (ms) => AbortSignal.timeout(ms);

async function porGoogle({ calle, localidad }, diag) {
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key) return null;
  const q = new URLSearchParams({
    address: `${calle}, ${localidad || "Luján"}, Buenos Aires, Argentina`,
    components: "country:AR", region: "ar", language: "es",
    bounds: `${CAJA.latMin},${CAJA.lngMin}|${CAJA.latMax},${CAJA.lngMax}`, key,
  });
  const j = await (await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${q}`, { signal: conTiempo(4000) })).json();
  const r = (j.results || []).find((x) => dentro({ lat: x.geometry.location.lat, lng: x.geometry.location.lng }));
  if (!r) return null;
  const exacta = ["ROOFTOP", "RANGE_INTERPOLATED"].includes(r.geometry.location_type) && !r.partial_match;
  return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, texto: r.formatted_address.replace(/, Argentina$/, ""), exacta, fuente: "google" };
}

async function porGeoref({ calle, localidad }, diag) {
  if (!/\d/.test(calle)) return null; // Georef necesita la altura
  const q = new URLSearchParams({ direccion: calle, departamento: "Luján", provincia: "06", max: "5" });
  const j = await (await fetch(`https://apis.datos.gob.ar/georef/api/direcciones?${q}`, { signal: conTiempo(4000) })).json();
  const ds = (j.direcciones || []).filter((d) => d.ubicacion && d.ubicacion.lat != null && dentro({ lat: d.ubicacion.lat, lng: d.ubicacion.lon }));
  if (!ds.length) return null;
  if (diag) diag.georef = ds.map((x) => ({ calle: x.calle?.nombre, altura: x.altura?.valor, localidad: x.localidad_censal?.nombre, lat: x.ubicacion.lat, lng: x.ubicacion.lon }));
  // Si el cliente dijo la localidad, solo vale una calle de esa localidad (San Martín existe en Luján y en Jáuregui)
  const quiero = sinTilde(localidad || "lujan");
  const cerca = (x) => { const c = CENTROS[localidad]; return c && distanciaKm({ lat: c[0], lng: c[1] }, { lat: x.ubicacion.lat, lng: x.ubicacion.lon }) < 3; };
  const d = ds.find((x) => sinTilde(x.localidad_censal?.nombre).includes(quiero)) || (localidad ? ds.find(cerca) : ds[0]);
  if (!d) return null;
  const nombre = d.calle?.nombre ? d.calle.nombre.replace(/^\d+\s*-\s*/, "").toLowerCase().replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase()) : calle;
  const alt = d.altura?.valor ? ` ${d.altura.valor}` : "";
  return { lat: d.ubicacion.lat, lng: d.ubicacion.lon, texto: `${nombre}${alt}, ${d.localidad_censal?.nombre || "Luján"}`, exacta: !!alt, fuente: "georef" };
}

async function porOSM({ calle, localidad }, diag) {
  const q = new URLSearchParams({
    format: "jsonv2", limit: "3", countrycodes: "ar", bounded: "1", addressdetails: "1",
    viewbox: `${CAJA.lngMin},${CAJA.latMax},${CAJA.lngMax},${CAJA.latMin}`,
    q: `${calle}, ${localidad || "Luján"}, Buenos Aires`,
  });
  const j = await (await fetch(`https://nominatim.openstreetmap.org/search?${q}`, {
    signal: conTiempo(4000), headers: { "User-Agent": "FlamaPedidos/1.0 (+https://flama-demo.vercel.app)", "Accept-Language": "es" },
  })).json();
  const todos = (j || []).map((x) => ({ ...x, lat: Number(x.lat), lng: Number(x.lon) }));
  if (diag) diag.osm = todos.map((x) => ({ nombre: x.display_name, tipo: x.addresstype || x.type, lat: x.lat, lng: x.lng }));
  const quiero = localidad ? sinTilde(localidad) : null;
  const r = todos.filter(dentro).find((x) => !quiero || sinTilde(x.display_name).includes(quiero));
  if (!r) return null;
  const a = r.address || {};
  const exacta = !!a.house_number;
  const calleOSM = a.road ? a.road.replace(/^\d+\s*-\s*/, "") : r.name;
  const texto = [calleOSM ? `${calleOSM}${a.house_number ? " " + a.house_number : ""}` : null, a.city || a.town || a.village || "Luján"].filter(Boolean).join(", ");
  return { lat: r.lat, lng: r.lng, texto, exacta, fuente: "osm" };
}

const memo = new Map();
async function ubicar(direccion) {
  const d = limpiarDireccion(direccion);
  if (d.calle.length < 3) return null;
  const k = sinTilde(d.calle + " " + (d.localidad || ""));
  if (memo.has(k)) return memo.get(k);
  let mejor = null;
  for (const f of [porGoogle, porGeoref, porOSM]) {
    try { const r = await f(d); if (r?.exacta) { mejor = r; break; } if (r && !mejor) mejor = r; } catch (e) { console.warn("geo", f.name, e.message); }
  }
  if (memo.size > 2000) memo.clear();
  memo.set(k, mejor);
  return mejor;
}

// Freno en memoria: 30 búsquedas por minuto por conexión (la caché de Vercel absorbe las repetidas)
const vistos = new Map();
function frenar(ip) {
  const m = Math.floor(Date.now() / 60000), k = ip + ":" + m, n = (vistos.get(k) || 0) + 1;
  if (vistos.size > 5000) vistos.clear();
  vistos.set(k, n); return n > 30;
}

export default async function handler(req, res) {
  const ip = String(req.headers["x-forwarded-for"] || "x").split(",")[0].trim();
  if (frenar(ip)) { res.setHeader("Cache-Control", "no-store"); return res.status(429).json({ error: "Muchas consultas, probá en un minuto" }); }
  const dir = String(req.query.dir || "").slice(0, 160);
  if (dir.trim().length < 4) return res.status(400).json({ error: "Escribí calle y número" });
  try {
    const p = await ubicar(dir);
    if (!p) { res.setHeader("Cache-Control", "public, s-maxage=3600"); return res.json({ encontrada: false }); }
    const km = Math.round(distanciaKm(LOCAL, p) * 10) / 10;
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    res.json({ encontrada: true, km, exacta: p.exacta, texto: p.texto, lat: p.lat, lng: p.lng, fuente: p.fuente });
  } catch (e) {
    console.error(e);
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ encontrada: false, error: "No pudimos buscar la dirección" });
  }
}
