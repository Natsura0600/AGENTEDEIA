import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt.js";
import { getHistory, saveHistory, pause } from "./store.js";

const claude = new Anthropic();
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";

const tools = [
  {
    name: "registrar_lead",
    description: "Guarda un cliente potencial y avisa a Octavio. Usar cuando ya se sabe nombre, negocio y necesidad.",
    input_schema: {
      type: "object",
      properties: {
        nombre: { type: "string" },
        negocio: { type: "string", description: "Nombre y rubro del negocio" },
        necesidad: { type: "string", description: "Qué quiere (web nueva, rediseño, turnos, pedidos...)" },
        tiene_web: { type: "string" },
        notas: { type: "string" },
      },
      required: ["nombre", "negocio", "necesidad"],
    },
  },
  {
    name: "derivar_a_humano",
    description: "Pausa el bot y avisa a Octavio para que atienda él personalmente.",
    input_schema: {
      type: "object",
      properties: { motivo: { type: "string" } },
      required: ["motivo"],
    },
  },
];

async function runTool(name, input, chat, phone, notifyOwner) {
  if (name === "registrar_lead") {
    await notifyOwner(
        `🟢 Nuevo lead (wa.me/${phone})\n${input.nombre} — ${input.negocio}\nNecesita: ${input.necesidad}` +
        (input.tiene_web ? `\nWeb actual: ${input.tiene_web}` : "") +
        (input.notas ? `\nNotas: ${input.notas}` : ""));
    return "Lead registrado. Octavio fue notificado.";
  }
  if (name === "derivar_a_humano") {
    pause(chat);
    await notifyOwner(`🙋 Piden atención humana (wa.me/${phone})\nMotivo: ${input.motivo}\nEl bot quedó pausado 24 h para ese chat. Para reactivarlo, escribí /bot on en ese chat.`);
    return "Derivado. El bot queda pausado para este chat.";
  }
  return "Herramienta desconocida";
}

export async function reply({ chat, phone, text: userText, contactName, notifyOwner }) {
  const history = getHistory(chat);
  const prefix = history.length === 0 && contactName ? `[Nombre de perfil en WhatsApp: ${contactName}]\n` : "";
  const messages = [...history, { role: "user", content: prefix + userText }];

  for (let i = 0; i < 4; i++) {
    const res = await claude.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason !== "tool_use") {
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      saveHistory(chat, messages);
      return text;
    }
    const results = [];
    for (const b of res.content.filter((b) => b.type === "tool_use")) {
      results.push({ type: "tool_result", tool_use_id: b.id, content: await runTool(b.name, b.input, chat, phone, notifyOwner) });
    }
    messages.push({ role: "user", content: results });
  }
  saveHistory(chat, messages);
  return "Gracias por escribir. En un rato te responde Octavio personalmente.";
}
