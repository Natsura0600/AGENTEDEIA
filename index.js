import "dotenv/config";
import makeWASocket, {
  useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason,
  isJidGroup, jidNormalizedUser,
} from "baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { reply } from "./lib/agent.js";
import { isPaused, pause, resume } from "./lib/store.js";

const logger = pino({ level: "warn" });
const botSent = new Set();          // ids de mensajes que mandó el bot (para no confundirlos con los tuyos)
const busy = new Map();             // un mensaje a la vez por chat
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Solo responde a mensajes recibidos después de arrancar (no al historial viejo)
const startedAt = Math.floor(Date.now() / 1000);

function textOf(m) {
  return m.message?.conversation || m.message?.extendedTextMessage?.text || "";
}
function phoneOf(key) {
  const jid = key.remoteJidAlt?.endsWith("@s.whatsapp.net") ? key.remoteJidAlt : key.remoteJid;
  return jid.split("@")[0].split(":")[0];
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(`${process.env.DATA_DIR || "."}/auth`);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, logger, markOnlineOnConnect: false, syncFullHistory: false });

  sock.ev.on("creds.update", saveCreds);

  // Vincular con código (más cómodo en un servidor que el QR)
  const pairNumber = process.env.PAIRING_NUMBER;
  let codeAsked = false;

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr && pairNumber && !state.creds.registered && !codeAsked) {
      codeAsked = true;
      sock.requestPairingCode(pairNumber).then((code) =>
        console.log(`\n🔑 CÓDIGO DE VINCULACIÓN: ${code}\nEn WhatsApp: Dispositivos vinculados > Vincular dispositivo > Vincular con número de teléfono\n`));
    } else if (qr && !pairNumber) {
      console.log("\nEscaneá este QR desde WhatsApp > Dispositivos vinculados > Vincular dispositivo:\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") console.log("✅ Conectado como", sock.user?.id);
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log("❌ Sesión cerrada desde el celular. Borrá la carpeta auth/ y volvé a escanear.");
        process.exit(1);
      }
      console.log("Reconectando…", code);
      setTimeout(start, 3000);
    }
  });

  const ownerJid = () => {
    const n = process.env.OWNER_PHONE;
    return n ? `${n}@s.whatsapp.net` : jidNormalizedUser(sock.user.id);
  };

  async function send(jid, text) {
    const sent = await sock.sendMessage(jid, { text });
    if (sent?.key?.id) botSent.add(sent.key.id);
    return sent;
  }
  const notifyOwner = (text) => send(ownerJid(), text);

  async function handle(m) {
    const chat = m.key.remoteJid;
    const text = textOf(m).trim();

    // Mensajes enviados desde TU celular en ese chat
    if (m.key.fromMe) {
      if (botSent.delete(m.key.id)) return;              // lo mandó el bot
      if (text === "/bot on") { resume(chat); return sock.sendMessage(chat, { delete: m.key }); }
      if (text === "/bot off") { pause(chat, 24 * 365); return sock.sendMessage(chat, { delete: m.key }); }
      pause(chat);                                        // contestaste vos → el bot se calla 24 h
      return;
    }

    if (isPaused(chat)) return;
    await sock.readMessages([m.key]);

    if (!text) {
      return send(chat, "¡Gracias! Por ahora leo solo mensajes de texto. ¿Me lo escribís así te ayudo?");
    }

    await sock.sendPresenceUpdate("composing", chat);
    const answer = await reply({ chat, phone: phoneOf(m.key), text, contactName: m.pushName, notifyOwner });
    await sleep(800 + Math.min(answer.length * 25, 4000)); // pausa "humana" antes de contestar
    await sock.sendPresenceUpdate("paused", chat);
    if (answer && !isPaused(chat)) await send(chat, answer);
  }

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      const chat = m.key.remoteJid;
      if (!chat || isJidGroup(chat) || chat === "status@broadcast" || chat.endsWith("@newsletter")) continue;
      if (Number(m.messageTimestamp) < startedAt) continue;
      if (!m.message || m.message.protocolMessage || m.message.reactionMessage) continue;
      if (chat === ownerJid() && !m.key.fromMe) continue; // no responderse a sí mismo

      const prev = busy.get(chat) || Promise.resolve();
      const next = prev.then(() => handle(m)).catch((e) => console.error("Error en", chat, e.message));
      busy.set(chat, next);
    }
  });
}

start();
