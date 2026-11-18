import QRCode from "qrcode";
import { redis, isLinked, resetSession } from "../lib/wa.js";
import { checkKey } from "../lib/auth.js";

export default async function handler(req, res) {
  if (!checkKey(req)) return res.status(401).json({ error: "Clave incorrecta" });
  if (req.method === "DELETE") {
    await resetSession();
    await redis.del("link:status", "link:qr", "link:lock");
    return res.json({ status: "idle" });
  }
  if (await isLinked()) return res.json({ status: "connected" });
  const qr = await redis.get("link:qr");
  const status = (await redis.get("link:status")) || "idle";
  res.json({ status, qr: qr ? await QRCode.toDataURL(qr, { margin: 1, width: 300 }) : null });
}
