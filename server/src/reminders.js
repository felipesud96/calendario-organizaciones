// Tarea programada en memoria: cada cierto tiempo revisa qué entrevistas
// empiezan en ~24 horas y todavía no tienen recordatorio enviado, y le
// manda un correo a los dos participantes (líder y miembro) que tengan
// email cargado.
//
// No usa ningún paquete de "cron" externo (no hay acceso a npm en este
// entorno): un simple setInterval alcanza para este volumen de datos.

import { load, withDb } from './db.js';
import { isEmailConfigured } from './email.js';
import { sendReminderEmail } from './notifications.js';

const CHECK_EVERY_MS = 15 * 60 * 1000; // revisa cada 15 minutos
const TARGET_MS = 24 * 60 * 60 * 1000; // recordatorio 24 horas antes
const WINDOW_MS = 20 * 60 * 1000; // ventana de +/-20 min para no repetir ni saltarse el envío

function interviewStart(iv) {
  return new Date(`${iv.date}T${iv.startTime}:00`).getTime();
}

function dueForReminder(iv, now) {
  if (iv.reminderSent) return false;
  if (!iv.interviewerEmail && !iv.memberEmail) return false;
  const start = interviewStart(iv);
  if (Number.isNaN(start)) return false;
  const diff = start - now;
  return diff > TARGET_MS - WINDOW_MS && diff < TARGET_MS + WINDOW_MS;
}

async function checkAndSendReminders() {
  if (!isEmailConfigured()) return;
  const data = load();
  const now = Date.now();
  const due = data.interviews.filter((iv) => dueForReminder(iv, now));
  for (const iv of due) {
    await sendReminderEmail(iv);
    await withDb((d) => {
      const target = d.interviews.find((i) => i.id === iv.id);
      if (target) target.reminderSent = true;
    });
  }
}

export function startReminderScheduler() {
  if (!isEmailConfigured()) {
    console.log('[recordatorios] desactivados: falta GMAIL_USER o GMAIL_APP_PASSWORD en las variables de entorno.');
    return;
  }
  console.log('[recordatorios] activados vía Gmail — revisando cada 15 minutos.');
  checkAndSendReminders().catch((err) => console.error('[recordatorios] error inicial:', err));
  setInterval(() => {
    checkAndSendReminders().catch((err) => console.error('[recordatorios] error:', err));
  }, CHECK_EVERY_MS);
}
