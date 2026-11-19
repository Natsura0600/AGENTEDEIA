# Agente de WhatsApp e Instagram — Picture Web Dev

Contesta con GPT-5 mini (Vercel AI Gateway), manda el formulario "Pedí tu web 🚀" y avisa los leads.
Todo con APIs oficiales de Meta: **sin cron, sin conexión abierta**. Vercel solo corre cuando llega un mensaje.

## Archivos
- `api/whatsapp.js` → webhook de WhatsApp (Cloud API)
- `api/instagram.js` → webhook de Instagram
- `lib/prompt.js` → qué dice el bot y cómo habla
- `lib/agent.js` → IA y herramientas (lead, derivar a humano)

## Desactivar el bot en chats
- **Para siempre en un chat:** escribí `/bot off` en ese chat desde la app de WhatsApp Business (coexistencia). `/bot on` lo reactiva.
- **Lista fija:** `BOT_OFF_NUMBERS` en Vercel, separados por coma.
- **Desde tu número personal:** mandale al bot `/bot off 549...`.
- Si contestás vos un chat, el bot no contesta más ahí (para siempre; `/bot on` lo reactiva).
- Filtro con IA: en el primer mensaje de cada chat decide si es cliente o charla personal; si es personal, no contesta nunca en ese chat.

## Webhook en Meta
- URL: `https://TU-PROYECTO.vercel.app/api/whatsapp`
- Token: `pictureweb-wa`
- Campos: `messages` y `smb_message_echoes`
