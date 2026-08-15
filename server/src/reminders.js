// Tarea programada en memoria: cada cierto tiempo revisa qué entrevistas
// empiezan en ~24 horas y todavía no tienen recordatorio enviado, y le
// manda un correo al líder que la va a realizar.
//
// No usa ningún paquete de "cron" externo (no hay acceso a npm en este
// entorno): un simple setInterval alcanza para este volumen de datos.

import { load, withDb } from './db.js';
import { sendEmail, isEmailConfigured } from './email.js';

const CHECK_EVERY_MS = 15 * 60 * 1000; // revisa cada 15 minutos
const TARGET_MS = 24 * 60 * 60 * 1000; // recordatorio 24 horas antes
const WINDOW_MS = 20 * 60 * 1000; // ventana de +/-20 min para no repetir ni saltarse el envío

function interviewStart(iv) {
  return new Date(`${iv.date}T${iv.startTime}:00`).getTime();
}

function dueForReminder(iv, now) {
  if (iv.reminderSent) return false;
  if (!iv.interviewerEmail) return false;
  const start = interviewStart(iv);
  if (Number.isNaN(start)) return false;
  const diff = start - now;
  return diff > TARGET_MS - WINDOW_MS && diff < TARGET_MS + WINDOW_MS;
}

function reminderHtml(iv) {
  const rows = [
    `<li><strong>Miembro:</strong> ${escHtml(iv.memberName)}</li>`,
    `<li><strong>Fecha:</strong> ${escHtml(iv.date)}</li>`,
    `<li><strong>Hora:</strong> ${escHtml(iv.startTime)}${iv.endTime ? ' - ' + escHtml(iv.endTime) : ''}</li>`,
    iv.location ? `<li><strong>Lugar:</strong> ${escHtml(iv.location)}</li>` : '',
    iv.description ? `<li><strong>Detalle:</strong> ${escHtml(iv.description)}</li>` : '',
  ].filter(Boolean).join('');
  return `<p>Hola${iv.interviewerName ? ' ' + escHtml(iv.interviewerName) : ''},</p>
<p>Este es un recordatorio: tienes una entrevista agendada para <strong>mañana</strong> en el Calendario Barrio Valle Grande.</p>
<ul>${rows}</ul>
<p>— Calendario Barrio Valle Grande</p>`;
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function checkAndSendReminders() {
  if (!isEmailConfigured()) return;
  const data = load();
  const now = Date.now();
  const due = data.interviews.filter((iv) => dueForReminder(iv, now));
  for (const iv of due) {
    try {
      await sendEmail({
        to: iv.interviewerEmail,
        subject: `Recordatorio: entrevista con ${iv.memberName} mañana`,
        html: reminderHtml(iv),
      });
      await withDb((d) => {
        const target = d.interviews.find((i) => i.id === iv.id);
        if (target) target.reminderSent = true;
      });
      console.log(`[recordatorios] enviado a ${iv.interviewerEmail} (entrevista #${iv.id})`);
    } catch (err) {
      console.error(`[recordatorios] error enviando entrevista #${iv.id}:`, err.message);
    }
  }
}

export function startReminderScheduler() {
  if (!isEmailConfigured()) {
    console.log('[recordatorios] desactivados: falta GMAIL_USER o GMAIL_APP_PASSWORD en las variables de entorno.');
    return;
  }
  console.log('[recordatorios] activados vía Resend — revisando cada 15 minutos.');
  checkAndSendReminders().catch((err) => console.error('[recordatorios] error inicial:', err));
  setInterval(() => {
    checkAndSendReminders().catch((err) => console.error('[recordatorios] error:', err));
  }, CHECK_EVERY_MS);
}
