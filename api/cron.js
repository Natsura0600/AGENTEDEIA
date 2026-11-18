// Corre cada 2 minutos: se conecta, recibe los mensajes pendientes, responde y se desconecta.
import { isJidGroup, jidNormalizedUser } from "baileys";
import { connect, redis, isLinked } from "../lib/wa.js";
import { reply } from "../lib/agent.js";
import { isPaused, pause, resume } from "../lib/store.js";

export const config = { maxDuration: 120 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (m) => m.message?.conversation || m.message?.extendedTextMessage?.text || "";
function phoneOf(key) {
  const jid = key.remoteJidAlt?.endsWith("@s.whatsapp.net") ? key.remoteJidAlt : key.remoteJid;
  return jid.split("@")[0].split(":")[0];
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).end();
  if (!(await isLinked())) return res.json({ ok: false, reason: "WhatsApp no vinculado" });
  if (!(await redis.set("cron:lock", 1, { nx: true, ex: 115 }))) return res.json({ ok: true, skipped: true });

  const inbox = [];
  let lastMsgAt = Date.now();
  let opened = false;
  let sock;
  try {
    sock = await connect({
      onOpen: () => { opened = true; lastMsgAt = Date.now(); },
      onMessages: ({ messages }) => { inbox.push(...messages); lastMsgAt = Date.now(); },
    });

    // Esperar los mensajes pendientes: hasta 25 s, o 6 s sin novedades después de conectar
    const t0 = Date.now();
    while (Date.now() - t0 < 25000 && (!opened || Date.now() - lastMsgAt < 6000)) await sleep(500);

    const me = jidNormalizedUser(sock.user?.id || "");
    const ownerJid = process.env.OWNER_PHONE ? `${process.env.OWNER_PHONE}@s.whatsapp.net` : me;
    const send = async (jid, text) => {
      const s = await sock.sendMessage(jid, { text });
      if (s?.key?.id) await redis.set(`sent:${s.key.id}`, 1, { ex: 86400 });
    };

    let answered = 0;
    const minTs = Math.floor(Date.now() / 1000) - 6 * 3600; // ignora mensajes de más de 6 h
    for (const m of inbox) {
      try {
        const chat = m.key.remoteJid;
        if (!chat || isJidGroup(chat) || chat === "status@broadcast" || chat.endsWith("@newsletter")) continue;
        if (!m.message || m.message.protocolMessage || m.message.reactionMessage) continue;
        if (Number(m.messageTimestamp) < minTs) continue;
        if (!(await redis.set(`seen:${m.key.id}`, 1, { nx: true, ex: 172800 }))) continue;
        const text = textOf(m).trim();

        if (m.key.fromMe) {
          if (await redis.get(`sent:${m.key.id}`)) continue; // lo mandó el bot
          if (text === "/bot on") { await resume(chat); await sock.sendMessage(chat, { delete: m.key }); continue; }
          if (text === "/bot off") { await pause(chat, 24 * 365); await sock.sendMessage(chat, { delete: m.key }); continue; }
          if (chat !== me && chat !== ownerJid) await pause(chat); // contestaste vos → el bot se calla 24 h
          continue;
        }
        if (chat === ownerJid || (await isPaused(chat))) continue;

        await sock.readMessages([m.key]);
        if (!text) { await send(chat, "¡Gracias! Por ahora leo solo mensajes de texto. ¿Me lo escribís así te ayudo?"); continue; }
        const answer = await reply(phoneOf(m.key), text, m.pushName, { chat, notify: (t) => send(ownerJid, t) });
        await send(chat, answer);
        answered++;
      } catch (e) {
        console.error("Error con un mensaje:", e.message);
      }
    }

    await sleep(3000); // deja salir los envíos
    res.json({ ok: true, received: inbox.length, answered });
  } finally {
    sock?.end(undefined);
    await redis.del("cron:lock");
  }
}
