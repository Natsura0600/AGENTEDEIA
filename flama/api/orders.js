// Panel de empleados (y del dueño): pedidos del día, cambios de estado, venta de mostrador.
import { listOrders, getOrder, saveOrder, panelState, sumarCaja, contarCancelado, cajaHoy, nextId, jornada, ESTADOS } from "../lib/orders.js";
import { sendToClient, STATUS_MSG } from "../lib/notify.js";
import { sincronizarStock, getStock, bajos } from "../lib/stock.js";
import { getMenu, calcular } from "../lib/menu.js";
import { redis } from "../lib/redis.js";
import { rol } from "../lib/auth.js";

export default async function handler(req, res) {
  const quien = rol(req.query.key);
  if (!quien) return res.status(401).json({ error: "Clave incorrecta" });
  const body = req.body || {};

  if (req.method === "POST" && body.bot) {
    await redis.set("flama:bot_off", body.bot === "off" ? "1" : "0");
    return res.json(await panelState());
  }

  // Venta de mostrador: ya está cobrada, entra directo a cocina y descuenta stock.
  // Suma a la caja cuando la marcan como entregada, igual que el resto.
  if (req.method === "POST" && body.mostrador) {
    const { items, pago, nombre } = body.mostrador;
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Agregá al menos un producto" });
    let calc;
    try { calc = calcular(items, "retiro", null, await getMenu(true)); } catch (e) { return res.status(400).json({ error: e.message }); }
    const o = {
      id: await nextId(), chat: "local:mostrador", canal: "mostrador", createdAt: Date.now(), jornada: jornada(),
      nombre: String(nombre || "").trim().slice(0, 40) || "Mostrador", entrega: "local", lineas: calc.lineas, envio: 0, total: calc.total, items,
      pago: ["efectivo", "transferencia", "tarjeta"].includes(pago) ? pago : "efectivo", estado: "en_preparacion", pagoVerificadoPor: "local",
    };
    await sincronizarStock(o);
    await saveOrder(o);
    return res.json({ ok: true, id: o.id, total: o.total });
  }

  if (req.method === "POST") {
    const { id, estado } = body;
    const o = await getOrder(String(id));
    if (!o || !ESTADOS[estado]) return res.status(400).json({ error: "Pedido o estado inválido" });
    const antes = o.estado;
    o.estado = estado;
    if (antes === "pago_a_verificar" && estado === "en_preparacion") o.pagoVerificadoPor = "local";
    if (["pago_pendiente", "pago_a_verificar"].includes(antes) && estado === "en_preparacion" && !o.pagoVerificadoPor) o.pagoVerificadoPor = "local";
    // La caja cuenta el pedido cuando se entrega; si después se cancela, se descuenta
    if (estado === "entregado" && !o.enCaja) { o.enCaja = true; await sumarCaja(o, 1); }
    if (estado === "cancelado") { if (o.enCaja) { o.enCaja = false; await sumarCaja(o, -1); } await contarCancelado(o); }
    await sincronizarStock(o);
    await saveOrder(o);
    if (STATUS_MSG[estado] && !String(o.chat).startsWith("local:")) await sendToClient(o.chat, STATUS_MSG[estado](o));
  }

  const st = await panelState();
  // Si el panel ya tiene esta versión, no se releen los pedidos (1 comando por consulta)
  if (req.method === "GET" && req.query.v === st.ver) return res.json({ ...st, same: true });
  const [orders, caja, { ing }] = await Promise.all([listOrders(), cajaHoy(), getStock()]);
  // Los empleados ven cantidades, no la plata de la caja
  const cajaVisible = quien === "dueno" ? caja : { pedidos: caja.pedidos, cancelados: caja.cancelados };
  res.json({ ...st, rol: quien, estados: ESTADOS, orders, caja: cajaVisible, stockBajo: bajos(ing) });
}
