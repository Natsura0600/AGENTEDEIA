// API del panel: lista los chats y prende/apaga el bot en cada uno.
// GET  /api/panel?key=...                         → chats y estado
// POST /api/panel?key=...&phone=549...&on=1|0     → prende/apaga un chat
// POST /api/panel?key=...&global=1|0              → prende/apaga el bot para todos
import { redis } from "../lib/redis.js";
import { listChats } from "../lib/chats.js";

const digits = (s) => String(s || "").replace(/\D/g, "");
const blocked = () => (process.env.BOT_OFF_NUMBERS || "").split(",").map(digits).filter(Boolean);
const inContacts = (p) => blocked().some((b) => p.endsWith(b.slice(-10)));

export default async function handler(req, res) {
  const key = process.env.PANEL_KEY || process.env.CRON_SECRET;
  if (!key || req.query.key !== key) return res.status(401).json({ error: "Clave incorrecta" });

  if (req.method === "POST") {
    if (req.query.global !== undefined) {
      if (req.query.global === "1") await redis.del("bot:global-off");
      else await redis.set("bot:global-off", "1");
    } else {
      const p = digits(req.query.phone);
      if (!p) return res.status(400).json({ error: "Falta el número" });
      if (req.query.on === "1") {
        await redis.del(`off:${p}`, `pause:${p}`);
        await redis.set(`cls:${p}`, "CLIENTE");
      } else {
        await redis.set(`off:${p}`, "1");
      }
    }
  }

  const chats = await listChats();
  const out = [];
  for (const c of chats) {
    const contact = inContacts(c.phone);
    const off = Boolean(await redis.get(`off:${c.phone}`));
    out.push({ ...c, contact, on: !contact && !off });
  }
  const globalOn = process.env.BOT_DISABLED !== "1" && !(await redis.get("bot:global-off"));
  res.json({ globalOn, chats: out });
}
