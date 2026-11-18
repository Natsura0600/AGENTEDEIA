import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { SYSTEM_PROMPT } from "./prompt.js";
import { getHistory, saveHistory, pause } from "./store.js";

// Modelo vía Vercel AI Gateway (sin API key: usa la autenticación del proyecto en Vercel)
const MODEL = process.env.AI_MODEL || "openai/gpt-5-mini";

// opts.chat: id del chat (JID de Baileys); opts.notify: función que te manda el aviso
export async function reply(phone, text, contactName, opts = {}) {
  const chat = opts.chat || phone;
  const notify = opts.notify || (async () => {});

  const history = await getHistory(chat);
  const first = history.length === 0 && contactName ? `[Nombre de perfil en WhatsApp: ${contactName}]\n` : "";
  const messages = [...history, { role: "user", content: first + text }];

  const result = await generateText({
    model: MODEL,
    instructions: SYSTEM_PROMPT,
    providerOptions: { openai: { reasoningEffort: "minimal" } }, // responde más rápido
    messages,
    stopWhen: stepCountIs(4),
    tools: {
      registrar_lead: tool({
        description: "Guarda un cliente potencial y avisa a Octavio. Usar cuando ya se sabe nombre, negocio y necesidad, o cuando dice que completó el formulario.",
        inputSchema: z.object({
          nombre: z.string(),
          negocio: z.string(),
          necesidad: z.string(),
          notas: z.string().optional(),
        }),
        execute: async (i) => {
          await notify(`🟢 Nuevo lead (wa.me/${phone})\n${i.nombre} — ${i.negocio}\nNecesita: ${i.necesidad}${i.notas ? `\nNotas: ${i.notas}` : ""}`);
          return "Lead registrado, Octavio fue avisado.";
        },
      }),
      derivar_a_humano: tool({
        description: "Pausa el bot en este chat y avisa a Octavio para que atienda personalmente.",
        inputSchema: z.object({ motivo: z.string() }),
        execute: async ({ motivo }) => {
          await pause(chat);
          await notify(`🙋 Piden atención humana (wa.me/${phone})\nMotivo: ${motivo}\nBot pausado 24 h. Para reactivarlo escribí /bot on en ese chat.`);
          return "Derivado a Octavio.";
        },
      }),
    },
  });

  const answer = result.text.trim() || "Gracias por escribir. En un rato te responde Octavio personalmente.";
  await saveHistory(chat, [...messages, { role: "assistant", content: answer }]);
  return answer;
}
