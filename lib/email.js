// Avisos por mail con Resend (https://resend.com). Variables: RESEND_API_KEY, NOTIFY_EMAIL, EMAIL_FROM (opcional)
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

export async function sendEmail(subject, lines) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (!key || !to) return;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#111">${lines
    .map((l) => (l.startsWith("http") ? `<p><a href="${esc(l)}">${esc(l)}</a></p>` : `<p>${esc(l).replace(/\n/g, "<br>")}</p>`))
    .join("")}<hr style="border:none;border-top:1px solid #ddd"><p style="color:#888;font-size:12px">Agente de Picture Web Dev</p></div>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM || "Bot Picture Web Dev <onboarding@resend.dev>", to: [to], subject, html }),
  }).catch((e) => ({ ok: false, text: async () => e.message }));
  if (!res.ok) console.error("Resend error", res.status, await res.text());
}
