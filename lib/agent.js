import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { SYSTEM_PROMPT } from "./prompt.js";
import { getHistory, saveHistory, pause } from "./store.js";
import { sendText } from "./whatsapp.js";

// Modelo vía Vercel AI Gateway (sin API key: usa la autenticación del proyecto en Vercel)
const MODEL = process.env.AI_MODEL || "openai/gpt-5-mini";

export async function reply(phone, text, contactName) {
  const owner = process.env.OWNER_PHONE;
  const notify = (msg) => (owner ? sendText(owner, msg) : null);

  const history = await getHistory(phone);
  const first = history.length === 0 && contactName ? `[Nombre de perfil en WhatsApp: ${contactName}]\n` : "";
  const messages = [...history, { role: "user", content: first + text }];

  const result = await generateText({
    model: MODEL,
    system: SYSTEM_PROMPT,
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
          await pause(phone);
          await notify(`🙋 Piden atención humana (wa.me/${phone})\nMotivo: ${motivo}\nBot pausado 24 h. Para reactivarlo mandale al bot: /bot on ${phone}`);
          return "Derivado a Octavio.";
        },
      }),
    },
  });

  const answer = result.text.trim() || "Gracias por escribir. En un rato te responde Octavio personalmente.";
  await saveHistory(phone, [...messages, { role: "assistant", content: answer }]);
  return answer;
}
