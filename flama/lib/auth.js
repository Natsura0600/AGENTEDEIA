// Dos claves: una para los empleados (pedidos, fichaje) y otra para el dueño (todo).
export const CLAVE_EMPLEADOS = () => process.env.PANEL_KEY || "flama2026";
export const CLAVE_DUENO = () => process.env.OWNER_KEY || "dueno-flama";
export function rol(key) {
  if (!key) return null;
  if (key === CLAVE_DUENO()) return "dueno";
  if (key === CLAVE_EMPLEADOS()) return "empleado";
  return null;
}
