// Ubica una dirección escrita dentro del partido de Luján, mide la distancia al local
// y elige la zona de envío según los km que el dueño carga en su panel.
// Busca en: Google (si hay GOOGLE_MAPS_KEY) → Georef (API oficial de direcciones del Estado) → OpenStreetMap.
import { redis } from "./redis.js";
import { LOCAL } from "./menu.js";

// Caja que cubre todo el partido de Luján (Luján, Jáuregui, Open Door, Olivera, Torres, Carlos Keen, Cortínez)
const CAJA = { latMin: -34.8, latMax: -34.35, lngMin: -59.45, lngMax: -58.9 };
const CENTRO_LUJAN = { lat: -34.5636, lng: -59.1208, aprox: true }; // si no se pudo ubicar el local
const LOCALIDADES = ["Jáuregui", "Open Door", "Olivera", "Torres", "Carlos Keen", "Cortínez"];
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

async function porGoogle({ calle, localidad }) {
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

async function porGeoref({ calle, localidad }) {
  if (!/\d/.test(calle)) return null; // Georef necesita la altura
  const q = new URLSearchParams({ direccion: calle, departamento: "Luján", provincia: "06", max: "5" });
  const j = await (await fetch(`https://apis.datos.gob.ar/georef/api/direcciones?${q}`, { signal: conTiempo(4000) })).json();
  const ds = (j.direcciones || []).filter((d) => d.ubicacion && d.ubicacion.lat != null && dentro({ lat: d.ubicacion.lat, lng: d.ubicacion.lon }));
  if (!ds.length) return null;
  const quiero = sinTilde(localidad || "lujan");
  const d = ds.find((x) => sinTilde(x.localidad_censal?.nombre).includes(quiero)) || ds[0];
  const nombre = d.calle?.nombre ? d.calle.nombre.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : calle;
  const alt = d.altura?.valor ? ` ${d.altura.valor}` : "";
  return { lat: d.ubicacion.lat, lng: d.ubicacion.lon, texto: `${nombre}${alt}, ${d.localidad_censal?.nombre || "Luján"}`, exacta: !!alt, fuente: "georef" };
}

async function porOSM({ calle, localidad }) {
  const q = new URLSearchParams({
    format: "jsonv2", limit: "3", countrycodes: "ar", bounded: "1", addressdetails: "1",
    viewbox: `${CAJA.lngMin},${CAJA.latMax},${CAJA.lngMax},${CAJA.latMin}`,
    q: `${calle}, ${localidad || "Luján"}, Buenos Aires`,
  });
  const j = await (await fetch(`https://nominatim.openstreetmap.org/search?${q}`, {
    signal: conTiempo(4000), headers: { "User-Agent": "FlamaPedidos/1.0 (+https://flama-demo.vercel.app)", "Accept-Language": "es" },
  })).json();
  const r = (j || []).map((x) => ({ ...x, lat: Number(x.lat), lng: Number(x.lon) })).find(dentro);
  if (!r) return null;
  const a = r.address || {};
  const exacta = !!a.house_number;
  const texto = [a.road ? `${a.road}${a.house_number ? " " + a.house_number : ""}` : r.name, a.city || a.town || a.village || "Luján"].filter(Boolean).join(", ");
  return { lat: r.lat, lng: r.lng, texto, exacta, fuente: "osm" };
}

// Devuelve { lat, lng, texto, exacta, fuente } o null si no se encontró en Luján
export async function ubicar(direccion) {
  const d = limpiarDireccion(direccion);
  if (d.calle.length < 3) return null;
  const ck = `flama:geo:${sinTilde(d.calle + " " + (d.localidad || "")).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90)}`;
  try { const c = await redis.get(ck); if (c) return c === "-" ? null : JSON.parse(c); } catch {}
  let mejor = null;
  for (const f of [porGoogle, porGeoref, porOSM]) {
    try {
      const r = await f(d);
      if (r?.exacta) { mejor = r; break; }
      if (r && !mejor) mejor = r;
    } catch (e) { console.warn("geo", f.name, e.message); }
  }
  await redis.set(ck, mejor ? JSON.stringify(mejor) : "-", { ex: mejor ? 60 * 60 * 24 * 60 : 60 * 60 * 6 }).catch(() => {});
  return mejor;
}

// Ubicación del local: la que fija el dueño en su panel, o la que se calcula una vez con la dirección del local
export async function origenLocal(c) {
  if (c?.ubicacion?.lat && c?.ubicacion?.lng) return { lat: c.ubicacion.lat, lng: c.ubicacion.lng, fuente: "dueño" };
  try { const v = await redis.get("flama:geo:origen"); if (v) return JSON.parse(v); } catch {}
  const p = await ubicar(LOCAL.direccion);
  const o = p ? { lat: p.lat, lng: p.lng, fuente: p.fuente, texto: p.texto, aprox: !p.exacta } : CENTRO_LUJAN;
  if (p) await redis.set("flama:geo:origen", JSON.stringify(o)).catch(() => {});
  return o;
}

export const linkMapa = (p) => `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;

// Zona para una dirección. Zonas con "hasta km" se eligen solas; las que no tienen km quedan para elegir a mano.
export async function detectarZona(direccion, c) {
  const zonasKm = (c.zonas || []).filter((z) => Number(z.hastaKm) > 0).sort((a, b) => a.hastaKm - b.hastaKm);
  const lugar = await ubicar(direccion);
  if (!lugar) return { encontrada: false, maxKm: zonasKm.at(-1)?.hastaKm || 0 };
  const origen = await origenLocal(c);
  const km = Math.round(distanciaKm(origen, lugar) * 10) / 10;
  const z = zonasKm.find((x) => km <= Number(x.hastaKm));
  return {
    encontrada: true, km, exacta: lugar.exacta, texto: lugar.texto, fuente: lugar.fuente,
    lat: lugar.lat, lng: lugar.lng, mapa: linkMapa(lugar),
    zona: z ? { id: z.id, nombre: z.nombre, precio: z.precio, hastaKm: z.hastaKm } : null,
    fuera: !z && zonasKm.length > 0,
    maxKm: zonasKm.at(-1)?.hastaKm || 0,
    origenAprox: !!origen.aprox,
  };
}
