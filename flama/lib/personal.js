// Fichero de personal: empleados con PIN, entradas/salidas y horas por mes.
import { redis } from "./redis.js";

const K = (s) => `flama:${s}`;
const TZ = "America/Argentina/Buenos_Aires";
export const mesDe = (t = Date.now()) => new Date(t).toLocaleDateString("en-CA", { timeZone: TZ }).slice(0, 7);
const mesAnterior = (m) => { const [y, mm] = m.split("-").map(Number); const d = new Date(Date.UTC(y, mm - 2, 15)); return d.toISOString().slice(0, 7); };
const nid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Empleados de ejemplo para la demo (el dueño los edita o borra)
const EJEMPLO = [
  { id: "e1", nombre: "Juan", puesto: "Cocina", pin: "1111", valorHora: 3500, activo: true },
  { id: "e2", nombre: "Sofi", puesto: "Barra", pin: "2222", valorHora: 3200, activo: true },
];

export async function empleados() {
  const v = await redis.get(K("emp"));
  if (v === null) { await redis.set(K("emp"), JSON.stringify(EJEMPLO)); return EJEMPLO; }
  try { return JSON.parse(v); } catch { return []; }
}
export async function guardarEmpleado(e) {
  const lista = await empleados();
  const pin = String(e.pin || "").replace(/\D/g, "");
  if (pin.length < 4) throw new Error("El PIN tiene que tener 4 números o más");
  if (lista.some((x) => x.pin === pin && x.id !== e.id && x.activo !== false)) throw new Error("Ese PIN ya lo usa otro empleado");
  const limpio = { id: e.id || nid(), nombre: String(e.nombre || "").trim().slice(0, 40), puesto: String(e.puesto || "").trim().slice(0, 30), pin, valorHora: Math.min(1e6, Math.max(0, Number(e.valorHora) || 0)), activo: e.activo !== false };
  if (!limpio.nombre) throw new Error("Falta el nombre");
  if (pin.length > 8) throw new Error("El PIN puede tener hasta 8 números");
  if (!lista.some((x) => x.id === limpio.id) && lista.length >= 80) throw new Error("Máximo 80 empleados");
  const i = lista.findIndex((x) => x.id === limpio.id);
  i >= 0 ? (lista[i] = limpio) : lista.push(limpio);
  await redis.set(K("emp"), JSON.stringify(lista));
  return limpio;
}
export async function borrarEmpleado(id) {
  const lista = (await empleados()).filter((x) => x.id !== id);
  await redis.set(K("emp"), JSON.stringify(lista));
}

export async function fichajes(mes) {
  try { return JSON.parse((await redis.get(K(`fich:${mes}`))) || "[]"); } catch { return []; }
}
const guardarFichajes = (mes, l) => redis.set(K(`fich:${mes}`), JSON.stringify(l), { ex: 60 * 60 * 24 * 400 });

async function turnoAbierto(empId) {
  for (const m of [mesDe(), mesAnterior(mesDe())]) {
    const l = await fichajes(m);
    const f = l.find((x) => x.emp === empId && !x.out);
    if (f) return { mes: m, lista: l, f };
  }
  return null;
}

// Fichar con PIN: si no tiene turno abierto, es entrada; si lo tiene, es salida.
export async function fichar(pin) {
  const e = (await empleados()).find((x) => x.pin === String(pin) && x.activo !== false);
  if (!e) throw new Error("PIN incorrecto");
  const now = Date.now();
  const ab = await turnoAbierto(e.id);
  if (ab) {
    if (now - ab.f.in < 60e3) return { nombre: e.nombre, tipo: "entrada", hora: ab.f.in, repetido: true };
    ab.f.out = now;
    await guardarFichajes(ab.mes, ab.lista);
    return { nombre: e.nombre, tipo: "salida", hora: now, desde: ab.f.in, minutos: Math.round((now - ab.f.in) / 60e3) };
  }
  const m = mesDe(now), l = await fichajes(m);
  l.push({ id: nid(), emp: e.id, in: now, out: null });
  await guardarFichajes(m, l);
  return { nombre: e.nombre, tipo: "entrada", hora: now };
}

export async function trabajandoAhora() {
  const emps = await empleados();
  const out = [];
  for (const m of [mesDe(), mesAnterior(mesDe())]) for (const f of await fichajes(m)) if (!f.out) { const e = emps.find((x) => x.id === f.emp); if (e) out.push({ id: e.id, nombre: e.nombre, puesto: e.puesto, desde: f.in }); }
  return out;
}

// Edición manual del dueño (olvidos de salida, correcciones)
export async function editarFichaje({ mes, id, inT, outT, emp, borrar }) {
  const l = await fichajes(mes);
  if (borrar) { await guardarFichajes(mes, l.filter((x) => x.id !== id)); return; }
  const inN = Number(inT), outN = outT ? Number(outT) : null;
  if (!inN) throw new Error("Falta la hora de entrada");
  const min = Date.UTC(2024, 0, 1), max = Date.now() + 864e5;
  if (inN < min || inN > max || (outN && outN > max)) throw new Error("Fecha u hora fuera de rango");
  if (outN && outN - inN > 24 * 36e5) throw new Error("Un turno no puede durar más de 24 horas");
  if (outN && outN <= inN) throw new Error("La salida tiene que ser después de la entrada");
  if (id) { const f = l.find((x) => x.id === id); if (!f) throw new Error("No existe ese fichaje"); f.in = inN; f.out = outN; f.editado = true; }
  else l.push({ id: nid(), emp, in: inN, out: outN, editado: true });
  l.sort((a, b) => a.in - b.in);
  await guardarFichajes(mes, l);
}

export async function resumenMes(mes) {
  const [emps, l] = await Promise.all([empleados(), fichajes(mes)]);
  const por = emps.map((e) => {
    const fs = l.filter((f) => f.emp === e.id);
    const min = fs.reduce((s, f) => s + (f.out ? (f.out - f.in) / 60e3 : 0), 0);
    const dias = new Set(fs.map((f) => new Date(f.in - 6 * 3600e3).toLocaleDateString("en-CA", { timeZone: TZ }))).size;
    return { ...e, minutos: Math.round(min), horas: Math.round((min / 60) * 100) / 100, dias, turnos: fs.length, abiertos: fs.filter((f) => !f.out).length, pagar: Math.round((min / 60) * (e.valorHora || 0)) };
  });
  return { empleados: por, fichajes: l };
}
