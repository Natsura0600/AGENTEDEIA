// Versión Baileys: se vincula a tu WhatsApp con QR o código y responde desde tu número.
// Necesita un proceso siempre prendido (PC, VPS o Railway). La IA va por Vercel AI Gateway.
import "dotenv/config";
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, isJidGroup, jidNormalizedUser } from "baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { reply } from "./lib/agent.js";
import { isPaused, pause, resume } from "./lib/store.js";

const DATA = process.env.DATA_DIR || ".";
const botSent = new Set();
const busy = new Map();
const startedAt = Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const textOf = (m) => m.message?.conversation || m.message?.extendedTextMessage?.text || "";
function phoneOf(key) {
  const jid = key.remoteJidAlt?.endsWith("@s.whatsapp.net") ? key.remoteJidAlt : key.remoteJid;
  return jid.split("@")[0].split(":")[0];
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(`${DATA}/auth`);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, logger: pino({ level: "warn" }), markOnlineOnConnect: false });
  sock.ev.on("creds.update", saveCreds);

  const pairNumber = process.env.PAIRING_NUMBER;
  let codeAsked = false;

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr && pairNumber && !state.creds.registered && !codeAsked) {
      codeAsked = true;
      sock.requestPairingCode(pairNumber).then((c) =>
        console.log(`\n🔑 CÓDIGO: ${c}\nWhatsApp > Dispositivos vinculados > Vincular con número de teléfono\n`));
    } else if (qr && !pairNumber) {
      console.log("\nEscaneá el QR desde WhatsApp > Dispositivos vinculados:\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") console.log("✅ Conectado como", sock.user?.id);
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log("❌ Sesión cerrada. Borrá la carpeta auth/ y volvé a vincular.");
        process.exit(1);
      }
      setTimeout(start, 3000);
    }
  });

  const ownerJid = () => (process.env.OWNER_PHONE ? `${process.env.OWNER_PHONE}@s.whatsapp.net` : jidNormalizedUser(sock.user.id));
  async function send(jid, text) {
    const sent = await sock.sendMessage(jid, { text });
    if (sent?.key?.id) botSent.add(sent.key.id);
  }

  async function handle(m) {
    const chat = m.key.remoteJid;
    const text = textOf(m).trim();

    if (m.key.fromMe) {
      if (botSent.delete(m.key.id)) return;
      if (text === "/bot on") { await resume(chat); return sock.sendMessage(chat, { delete: m.key }); }
      if (text === "/bot off") { await pause(chat, 24 * 365); return sock.sendMessage(chat, { delete: m.key }); }
      return pause(chat); // contestaste vos → el bot se calla 24 h
    }
    if (await isPaused(chat)) return;
    await sock.readMessages([m.key]);
    if (!text) return send(chat, "¡Gracias! Por ahora leo solo mensajes de texto. ¿Me lo escribís así te ayudo?");

    await sock.sendPresenceUpdate("composing", chat);
    const answer = await reply(phoneOf(m.key), text, m.pushName, { chat, notify: (t) => send(ownerJid(), t) });
    await sleep(800 + Math.min(answer.length * 25, 4000));
    await sock.sendPresenceUpdate("paused", chat);
    if (!(await isPaused(chat))) await send(chat, answer);
  }

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      const chat = m.key.remoteJid;
      if (!chat || isJidGroup(chat) || chat === "status@broadcast" || chat.endsWith("@newsletter")) continue;
      if (Number(m.messageTimestamp) < startedAt || !m.message) continue;
      if (m.message.protocolMessage || m.message.reactionMessage) continue;
      if (chat === ownerJid() && !m.key.fromMe) continue;
      const next = (busy.get(chat) || Promise.resolve()).then(() => handle(m)).catch((e) => console.error(chat, e.message));
      busy.set(chat, next);
    }
  });
}

start();
