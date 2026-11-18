// Lo dispara cron-job.org cada 1 minuto; se queda 30 s escuchando y responde al instante (el plan Hobby de Vercel solo permite crons diarios): se conecta, recibe los mensajes pendientes, responde y se desconecta.
import { isJidGroup, jidNormalizedUser } from "baileys";
import { connect, redis, isLinked } from "../lib/wa.js";
import { reply } from "../lib/agent.js";
import { isPaused, pause, resume } from "../lib/store.js";

export const config = { maxDuration: 90 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (m) => m.message?.conversation || m.message?.extendedTextMessage?.text || "";
function phoneOf(key) {
  const jid = key.remoteJidAlt?.endsWith("@s.whatsapp.net") ? key.remoteJidAlt : key.remoteJid;
  return jid.split("@")[0].split(":")[0];
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const given = req.query?.secret || (req.headers.authorization || "").replace("Bearer ", "");
  if (secret && given !== secret) return res.status(401).end();
  if (!(await isLinked())) return res.json({ ok: false, reason: "WhatsApp no vinculado" });
  if (!(await redis.set("cron:lock", 1, { nx: true, ex: 55 }))) return res.json({ ok: true, skipped: true });

  const LISTEN_MS = 30000; // se queda escuchando 30 s y contesta en vivo lo que llegue
  let queue = Promise.resolve();
  let received = 0, answered = 0;
  let sock, me, ownerJid;
  const pending = [];

  const send = async (jid, text) => {
    const s = await sock.sendMessage(jid, { text });
    if (s?.key?.id) await redis.set(`sent:${s.key.id}`, 1, { ex: 86400 });
  };

  async function handle(m) {
    try {
      const chat = m.key.remoteJid;
      if (!chat || isJidGroup(chat) || chat === "status@broadcast" || chat.endsWith("@newsletter")) return;
      if (!m.message || m.message.protocolMessage || m.message.reactionMessage) return;
      if (Number(m.messageTimestamp) < Math.floor(Date.now() / 1000) - 6 * 3600) return;
      if (!(await redis.set(`seen:${m.key.id}`, 1, { nx: true, ex: 172800 }))) return;
      const text = textOf(m).trim();

      if (m.key.fromMe) {
        if (await redis.get(`sent:${m.key.id}`)) return; // lo mandó el bot
        if (text === "/bot on") { await resume(chat); await sock.sendMessage(chat, { delete: m.key }); return; }
        if (text === "/bot off") { await pause(chat, 24 * 365); await sock.sendMessage(chat, { delete: m.key }); return; }
        if (chat !== me && chat !== ownerJid) await pause(chat); // contestaste vos → el bot se calla 24 h
        return;
      }
      if (chat === ownerJid || (await isPaused(chat))) return;

      await sock.readMessages([m.key]);
      await sock.sendPresenceUpdate("composing", chat);
      if (!text) { await send(chat, "¡Gracias por tu mensaje! Por el momento solo puedo leer texto. ¿Me lo escribís así te ayudo?"); return; }
      const answer = await reply(phoneOf(m.key), text, m.pushName, { chat, notify: (t) => send(ownerJid, t) });
      await send(chat, answer);
      await sock.sendPresenceUpdate("paused", chat);
      answered++;
    } catch (e) {
      console.error("Error con un mensaje:", e.message);
    }
  }
  const enqueue = (msgs) => {
    received += msgs.length;
    if (!ownerJid) return pending.push(...msgs); // todavía conectando
    for (const m of msgs) queue = queue.then(() => handle(m));
  };

  try {
    let openedAt = 0;
    sock = await connect({
      onOpen: () => {
        openedAt = Date.now();
        me = jidNormalizedUser(sock.user?.id || "");
        ownerJid = process.env.OWNER_PHONE ? `${process.env.OWNER_PHONE}@s.whatsapp.net` : me;
        const early = pending.splice(0); received -= early.length; enqueue(early);
      },
      onMessages: ({ messages }) => enqueue(messages),
    });

    const t0 = Date.now();
    while (!openedAt && Date.now() - t0 < 15000) await sleep(250);
    while (openedAt && Date.now() - openedAt < LISTEN_MS) await sleep(500);
    await queue; // terminar de contestar lo que esté en curso

    // Avisos pendientes de Instagram → tu WhatsApp
    if (ownerJid) {
      let n;
      while ((n = await redis.lpop("notify:queue"))) await send(ownerJid, String(n));
    }

    await sleep(3000); // deja salir los envíos
    res.json({ ok: true, received, answered });
  } finally {
    sock?.end(undefined);
    await redis.del("cron:lock");
  }
}
