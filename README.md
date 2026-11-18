# Agente de WhatsApp — Picture Web Dev

Contesta los WhatsApp de la agencia con GPT-5 mini (Vercel AI Gateway), manda el formulario
"Pedí tu web 🚀" (https://forms.gle/4CQdifqFRH7pmBdU9) y te avisa cuando entra un lead.

Todo corre en Vercel: `api/webhook.js` recibe los mensajes de WhatsApp y responde.

## Archivos
- `lib/prompt.js` → qué sabe y cómo habla el bot (editalo acá)
- `lib/agent.js` → modelo de IA + herramientas (registrar lead, derivar a humano)
- `lib/whatsapp.js` → envío de mensajes
- `lib/store.js` → memoria de cada chat (Upstash)

## Configuración (una sola vez)
1. **IA**: Vercel > AI Gateway. Usa el crédito gratis mensual; no hace falta clave.
2. **Memoria**: Vercel > proyecto > Storage > crear/conectar **Upstash Redis**.
3. **WhatsApp**: developers.facebook.com > Crear app (Empresa) > agregar WhatsApp.
   - Copiá **Phone Number ID** y un **token** (temporal para probar; después uno permanente de "Usuario del sistema").
   - En Configuración > Webhook: URL `https://agentedeia.vercel.app/api/webhook`, token de verificación = `WHATSAPP_VERIFY_TOKEN`, suscribir **messages**.
4. Cargá las variables de `.env.example` en Vercel > Settings > Environment Variables y hacé Redeploy.

## Uso
- Lead nuevo → te llega "🟢 Nuevo lead" a `OWNER_PHONE`.
- Piden humano → "🙋" y el bot se pausa 24 h en ese chat.
- Desde tu número, escribile al bot: `/bot on 549...` o `/bot off 549...`.
