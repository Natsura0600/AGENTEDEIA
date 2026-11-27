// Exporta la caja del mes en un archivo que abre Excel (CSV con ; y acentos)
import { cajaMes } from "../lib/orders.js";
import { autorizar } from "../lib/auth.js";
import { resumenMes } from "../lib/personal.js";

export default async function handler(req, res) {
  if (!(await autorizar(req, res, "dueno"))) return;
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || "") ? req.query.mes
    : new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).slice(0, 7);
  if (req.query.tipo === "horas") return horas(res, mes);
  const dias = await cajaMes(mes);
  const rows = [["Fecha", "Pedidos", "Retiro", "Delivery", "Mostrador", "Cancelados", "Envíos cobrados", "Efectivo", "Transferencia", "Tarjeta", "Total caja", "Ticket promedio", "Más vendido"]];
  const tot = { pedidos: 0, retiro: 0, delivery: 0, mostrador: 0, cancelados: 0, envios: 0, efectivo: 0, transferencia: 0, tarjeta: 0, ventas: 0 };
  for (const d of dias) {
    if (!d.pedidos && !d.cancelados) continue;
    const top = Object.entries(d.productos || {}).sort((a, b) => b[1] - a[1])[0];
    const pp = d.porPago || {};
    rows.push([d.fecha.split("-").reverse().join("/"), d.pedidos, d.retiro, d.delivery, d.mostrador || 0, d.cancelados, d.envios, pp.efectivo || 0, pp.transferencia || 0, pp.tarjeta || 0, d.ventas, d.pedidos ? Math.round(d.ventas / d.pedidos) : 0, top ? `${top[0]} (${top[1]})` : ""]);
    for (const k of ["pedidos", "retiro", "delivery", "mostrador", "cancelados", "envios", "ventas"]) tot[k] += d[k] || 0;
    for (const k of ["efectivo", "transferencia", "tarjeta"]) tot[k] += pp[k] || 0;
  }
  rows.push([]);
  rows.push(["TOTAL MES", tot.pedidos, tot.retiro, tot.delivery, tot.mostrador, tot.cancelados, tot.envios, tot.efectivo, tot.transferencia, tot.tarjeta, tot.ventas, tot.pedidos ? Math.round(tot.ventas / tot.pedidos) : 0, ""]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="flama-caja-${mes}.csv"`);
  res.send(csv(rows));
}

// Celdas que empiezan con = + - @ se anteponen con ' para que Excel no las ejecute como fórmula
const celda = (v) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s) ? "'" + s : s; };
const csv = (rows) => "\ufeff" + rows.map((r) => r.map((v) => `"${celda(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
const TZ = "America/Argentina/Buenos_Aires";
const f = (t) => (t ? new Date(t).toLocaleString("es-AR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "sin salida");
async function horas(res, mes) {
  const { empleados, fichajes } = await resumenMes(mes);
  const rows = [["RESUMEN DEL MES " + mes], ["Empleado", "Puesto", "Días", "Turnos", "Horas", "Valor hora", "A pagar", "Turnos sin salida"]];
  for (const e of empleados) rows.push([e.nombre, e.puesto, e.dias, e.turnos, String(e.horas).replace(".", ","), e.valorHora, e.pagar, e.abiertos]);
  rows.push([], ["DETALLE DE FICHAJES"], ["Empleado", "Entrada", "Salida", "Horas", "Corregido a mano"]);
  for (const x of fichajes) { const e = empleados.find((y) => y.id === x.emp); rows.push([e?.nombre || "(borrado)", f(x.in), f(x.out), x.out ? String(Math.round(((x.out - x.in) / 36e5) * 100) / 100).replace(".", ",") : "", x.editado ? "sí" : ""]); }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="flama-horas-${mes}.csv"`);
  res.send(csv(rows));
}
