// Pantalla de fichaje del local: el empleado pone su PIN y registra entrada o salida.
import { rol } from "../lib/auth.js";
import { fichar, trabajandoAhora } from "../lib/personal.js";

export default async function handler(req, res) {
  if (!rol(req.query.key)) return res.status(401).json({ error: "Clave incorrecta" });
  if (req.method === "POST") {
    try { return res.json(await fichar(String(req.body?.pin || ""))); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  res.json({ ahora: (await trabajandoAhora()).map(({ nombre, desde }) => ({ nombre, desde })) });
}
