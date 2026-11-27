// Operaciones que no se pueden pisar cuando dos cosas pasan al mismo tiempo
// (dos pedidos entregados en el mismo segundo, el bot y el mostrador descontando stock a la vez).
// En Upstash corren como scripts Lua (atómicos). Upstash cobra 1 comando + 1 por cada llamada interna.
import { redis, esMemoria } from "./redis.js";
export { LUA_SUMAR_JSON, LUA_STOCK };

// Suma (o resta) números en un JSON, incluso dentro de objetos: {pedidos:1, porPago:{efectivo:1500}}
const LUA_SUMAR_JSON = `
local raw = redis.call('GET', KEYS[1])
local c = raw and cjson.decode(raw) or {}
for k, v in pairs(cjson.decode(ARGV[1])) do
  if type(v) == 'table' then
    if type(c[k]) ~= 'table' then c[k] = {} end
    for k2, v2 in pairs(v) do c[k][k2] = (tonumber(c[k][k2]) or 0) + v2 end
  else
    c[k] = (tonumber(c[k]) or 0) + v
  end
end
local out = cjson.encode(c)
if tonumber(ARGV[2]) > 0 then redis.call('SET', KEYS[1], out, 'EX', ARGV[2]) else redis.call('SET', KEYS[1], out) end
return out`;

// Mueve cantidades de stock y agrega el movimiento al registro del día, todo junto
const LUA_STOCK = `
local raw = redis.call('GET', KEYS[1])
if not raw then return redis.error_reply('SIN_STOCK') end
local ing = cjson.decode(raw)
for k, v in pairs(cjson.decode(ARGV[1])) do
  if type(ing[k]) == 'table' then
    ing[k]['cant'] = math.floor(((tonumber(ing[k]['cant']) or 0) + v) * 100 + 0.5) / 100
  end
end
local out = cjson.encode(ing)
redis.call('SET', KEYS[1], out)
local lraw = redis.call('GET', KEYS[2])
local log = lraw and cjson.decode(lraw) or {}
table.insert(log, 1, cjson.decode(ARGV[2]))
while #log > 400 do table.remove(log) end
redis.call('SET', KEYS[2], cjson.encode(log), 'EX', ARGV[3])
return out`;

function sumarJS(c, d) {
  for (const [k, v] of Object.entries(d)) {
    if (v && typeof v === "object") { c[k] = c[k] && typeof c[k] === "object" ? c[k] : {}; for (const [k2, v2] of Object.entries(v)) c[k][k2] = (Number(c[k][k2]) || 0) + v2; }
    else c[k] = (Number(c[k]) || 0) + v;
  }
  return c;
}

// Si Upstash rechazara los scripts, se sigue funcionando sin atomicidad (y queda en el log)
let sinScripts = esMemoria;
const scriptFallo = (e) => { if (/SIN_STOCK/.test(e.message)) throw e; console.error("Script Lua falló, sigo sin atomicidad:", e.message); sinScripts = true; };

// Devuelve el objeto resultante
export async function sumarJSON(key, delta, ttl = 0) {
  if (!sinScripts) { try { return JSON.parse(await redis.eval(LUA_SUMAR_JSON, [key], [JSON.stringify(delta), String(ttl)])); } catch (e) { scriptFallo(e); } }
  {
    let c = {}; try { c = JSON.parse((await redis.get(key)) || "{}"); } catch {}
    sumarJS(c, delta);
    await redis.set(key, JSON.stringify(c), ttl ? { ex: ttl } : {});
    return c;
  }
}

// Devuelve los ingredientes ya actualizados
export async function moverStock(stockKey, logKey, delta, entrada, ttl) {
  if (!sinScripts) { try { return JSON.parse(await redis.eval(LUA_STOCK, [stockKey, logKey], [JSON.stringify(delta), JSON.stringify(entrada), String(ttl)])); } catch (e) { scriptFallo(e); } }
  {
    const ing = JSON.parse((await redis.get(stockKey)) || "null");
    if (!ing) throw new Error("SIN_STOCK");
    for (const [k, v] of Object.entries(delta)) if (ing[k] && typeof ing[k] === "object") ing[k].cant = Math.round((Number(ing[k].cant) + v) * 100) / 100;
    await redis.set(stockKey, JSON.stringify(ing));
    let log = []; try { log = JSON.parse((await redis.get(logKey)) || "[]"); } catch {}
    log.unshift(entrada); await redis.set(logKey, JSON.stringify(log.slice(0, 400)), { ex: ttl });
    return ing;
  }
}
export const usandoScripts = () => !sinScripts;
