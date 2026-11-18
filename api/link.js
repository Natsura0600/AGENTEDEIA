// Inicia la vinculación: abre Baileys hasta 4 min y guarda el QR en Redis para que la página lo muestre.
import { waitUntil } from "@vercel/functions";
import { connect, redis, isLinked, DisconnectReason } from "../lib/wa.js";
import { checkKey } from "../lib/auth.js";

export const config = { maxDuration: 300 };

function linkSession(deadline) {
  return new Promise((resolve) => {
    let done = false;
    const finish = async (status) => {
      if (done) return;
      done = true;
      await redis.set("link:status", status, { ex: 600 });
      resolve();
    };
    const run = async () => {
      const sock = await connect({
        onQR: (qr) => redis.set("link:qr", qr, { ex: 60 }),
        onOpen: async () => {
          await redis.del("link:qr");
          await redis.set("link:status", "connected", { ex: 600 });
          setTimeout(() => { sock.end(undefined); finish("connected"); }, 15000); // deja subir las claves
        },
        onClose: (code) => {
          if (done) return;
          if (code === DisconnectReason.restartRequired) return run(); // normal después de escanear
          if (Date.now() > deadline) return finish("expired");
          if (code === DisconnectReason.loggedOut) return finish("error");
          setTimeout(run, 2000);
        },
      });
      setTimeout(() => { if (!done) { sock.end(undefined); finish("expired"); } }, Math.max(deadline - Date.now(), 0));
    };
    run().catch(() => finish("error"));
  });
}

export default async function handler(req, res) {
  if (!checkKey(req)) return res.status(401).json({ error: "Clave incorrecta" });
  if (await isLinked()) return res.json({ status: "connected" });
  const lock = await redis.set("link:lock", 1, { nx: true, ex: 250 });
  if (lock) {
    await redis.set("link:status", "waiting", { ex: 600 });
    waitUntil(linkSession(Date.now() + 240000).finally(() => redis.del("link:lock")));
  }
  res.json({ status: "waiting" });
}
