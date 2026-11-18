# Agente de WhatsApp — Picture Web Dev

Contesta los WhatsApp de la agencia con GPT-5 mini (Vercel AI Gateway), manda el formulario
"Pedí tu web 🚀" (https://forms.gle/4CQdifqFRH7pmBdU9) y te avisa cuando entra un lead.

Hay dos formas de conectarlo a WhatsApp (el cerebro es el mismo):
- **Baileys** (`index.js`): se vincula a tu número con QR/código, como WhatsApp Web. Corre con `npm start` en un proceso siempre prendido (tu PC, un VPS o Railway). Vercel no puede mantenerlo conectado.
- **Cloud API de Meta** (`api/webhook.js`): corre en Vercel.

## Baileys rápido
```bash
npm install
cp .env.example .env   # poné AI_GATEWAY_API_KEY (Vercel > AI Gateway > API Keys)
npm start              # escaneá el QR
```
En cada chat: `/bot off` lo apaga, `/bot on` lo prende. Si contestás vos, el bot se calla 24 h.

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
