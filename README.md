# Agente de WhatsApp — Picture Web Dev

Contesta tus WhatsApp con GPT-5 mini (Vercel AI Gateway), manda el formulario "Pedí tu web 🚀"
(https://forms.gle/4CQdifqFRH7pmBdU9) y te avisa cuando entra un lead. Todo en Vercel, sin servidor prendido.

## Cómo funciona
- `public/index.html` → página para vincular tu WhatsApp con QR (con contraseña).
- `api/link.js` + `api/status.js` → generan el QR y guardan la sesión de Baileys en Upstash Redis.
- `api/cron.js` → cada 2 minutos se conecta, lee los mensajes nuevos, contesta y se desconecta.
- `lib/prompt.js` → qué dice el bot (editá acá) · `lib/agent.js` → IA y herramientas.

## Configuración
1. Vercel > proyecto > **Storage** > conectar **Upstash Redis**.
2. Variables: `ADMIN_PASSWORD`, `CRON_SECRET` (y opcional `OWNER_PHONE`). Redeploy.
3. Entrá a la web del proyecto, poné la contraseña, **Generar QR** y escanealo desde
   WhatsApp > Dispositivos vinculados.

## Uso
- Respuestas: entre 0 y 2 minutos después de cada mensaje.
- Si contestás vos un chat, el bot se calla 24 h ahí.
- En cualquier chat: `/bot off` lo apaga, `/bot on` lo prende.
- Lead nuevo o pedido de humano → aviso en "Mensaje para mí".

Baileys no es oficial: no lo uses para mensajes masivos.
