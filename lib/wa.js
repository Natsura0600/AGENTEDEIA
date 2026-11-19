// Baileys sin servidor: la sesión vive en Upstash Redis y cada función se conecta, trabaja y se desconecta.
import makeWASocket, { initAuthCreds, BufferJSON, proto, fetchLatestBaileysVersion, DisconnectReason } from "baileys";
import { Redis } from "@upstash/redis";
import pino from "pino";

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
export const redis = new Redis({ url, token, automaticDeserialization: false });
const P = "wa";

const enc = (v) => JSON.stringify(v, BufferJSON.replacer);
const dec = (v) => (v == null ? null : JSON.parse(v, BufferJSON.reviver));

export async function useRedisAuthState() {
  const creds = dec(await redis.get(`${P}:creds`)) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          if (!ids.length) return {};
          const vals = await redis.mget(...ids.map((id) => `${P}:${type}-${id}`));
          const out = {};
          ids.forEach((id, i) => {
            let v = dec(vals[i]);
            if (v && type === "app-state-sync-key") v = proto.Message.AppStateSyncKeyData.fromObject(v);
            if (v) out[id] = v;
          });
          return out;
        },
        set: async (data) => {
          const p = redis.pipeline();
          for (const type in data)
            for (const id in data[type]) {
              const v = data[type][id];
              if (v) p.set(`${P}:${type}-${id}`, enc(v));
              else p.del(`${P}:${type}-${id}`);
            }
          await p.exec();
        },
      },
    },
    saveCreds: () => redis.set(`${P}:creds`, enc(creds)),
  };
}

export async function isLinked() {
  const c = dec(await redis.get(`${P}:creds`));
  return Boolean(c?.me?.id);
}

export async function resetSession() {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, { match: `${P}:*`, count: 500 });
    if (keys.length) await redis.del(...keys);
    cursor = String(next);
  } while (cursor !== "0");
}

export async function connect({ onQR, onOpen, onMessages, onClose } = {}) {
  const { state, saveCreds } = await useRedisAuthState();
  // La versión de WhatsApp Web se guarda 1 día en Redis para no consultarla en cada conexión
  let version = JSON.parse((await redis.get("wa:version")) || "null");
  if (!version) {
    ({ version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined })));
    if (version) await redis.set("wa:version", JSON.stringify(version), { ex: 86400 });
  }
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    fireInitQueries: false,        // no pedir datos extra al conectar (ahorra CPU)
    generateHighQualityLinkPreview: false,
    browser: ["Picture Web Dev", "Chrome", "1.0"],
  });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (u) => {
    if (u.qr) onQR?.(u.qr);
    if (u.connection === "open") onOpen?.(sock);
    if (u.connection === "close") onClose?.(u.lastDisconnect?.error?.output?.statusCode);
  });
  if (onMessages) sock.ev.on("messages.upsert", onMessages);
  return sock;
}

export { DisconnectReason };
