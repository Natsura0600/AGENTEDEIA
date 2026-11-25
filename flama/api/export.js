// Exporta la caja del mes en un archivo que abre Excel (CSV con ; y acentos)
import { cajaMes } from "../lib/orders.js";

export default async function handler(req, res) {
  if (req.query.key !== (process.env.PANEL_KEY || "flama2026")) return res.status(401).send("Clave incorrecta");
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || "") ? req.query.mes
    : new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).slice(0, 7);
  const dias = await cajaMes(mes);
  const rows = [["Fecha", "Pedidos entregados", "Retiro", "Delivery", "Cancelados", "Envíos cobrados", "Total caja", "Ticket promedio", "Más vendido"]];
  const tot = { pedidos: 0, retiro: 0, delivery: 0, cancelados: 0, envios: 0, ventas: 0 };
  for (const d of dias) {
    if (!d.pedidos && !d.cancelados) continue;
    const top = Object.entries(d.productos || {}).sort((a, b) => b[1] - a[1])[0];
    rows.push([d.fecha.split("-").reverse().join("/"), d.pedidos, d.retiro, d.delivery, d.cancelados, d.envios, d.ventas, d.pedidos ? Math.round(d.ventas / d.pedidos) : 0, top ? `${top[0]} (${top[1]})` : ""]);
    for (const k in tot) tot[k] += d[k] || 0;
  }
  rows.push([]);
  rows.push(["TOTAL MES", tot.pedidos, tot.retiro, tot.delivery, tot.cancelados, tot.envios, tot.ventas, tot.pedidos ? Math.round(tot.ventas / tot.pedidos) : 0, ""]);
  const csv = "\ufeff" + rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="flama-caja-${mes}.csv"`);
  res.send(csv);
}
