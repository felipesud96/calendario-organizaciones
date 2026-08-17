// Tarea programada en memoria: cada cierto tiempo revisa qué entrevistas
// empiezan en ~24 horas y todavía no tienen recordatorio enviado, y le
// manda un correo a los dos participantes (líder y miembro) que tengan
// email cargado.
//
// No usa ningún paquete de "cron" externo (no hay acceso a npm en este
// entorno): un simple setInterval alcanza para este volumen de datos.

import { load, withDb } from './db.js';
import { isEmailConfigured } from './email.js';
import { sendReminderEmail, sendCommitmentDueSoonEmail, sendDailyDigestEmail } from './notifications.js';
import { isObispadoLeader } from './routes/stake.js';
import { computeBishopricOverview } from './routes/dashboard.js';

const CHECK_EVERY_MS = 15 * 60 * 1000; // revisa cada 15 minutos
const TARGET_MS = 24 * 60 * 60 * 1000; // recordatorio 24 horas antes
const WINDOW_MS = 20 * 60 * 1000; // ventana de +/-20 min para no repetir ni saltarse el envío

const todayISO = () => new Date().toISOString().slice(0, 10);
function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function interviewStart(iv) {
  return new Date(`${iv.date}T${iv.startTime}:00`).getTime();
}

function dueForReminder(iv, now) {
  if (iv.reminderSent) return false;
  // ya se marcó ✅/❌ (por ejemplo, se adelantó o se canceló de antemano) —
  // no tiene sentido recordar una entrevista que ya se verificó.
  if (iv.status && iv.status !== 'scheduled') return false;
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

// Compromisos (actas de Reuniones y Consejos) que vencen mañana y todavía
// no tienen recordatorio enviado — se les avisa a la cuenta de quien es
// responsable. Como el compromiso solo tiene una FECHA límite (no una
// hora), no hace falta la misma ventana de +/-20 min que las entrevistas:
// alcanza con que la fecha de mañana coincida.
async function checkCommitmentReminders() {
  if (!isEmailConfigured()) return;
  const data = load();
  const tomorrow = addDaysISO(1);
  for (const m of data.meetings) {
    if (m.status !== 'active') continue;
    for (const c of (m.commitments || [])) {
      if (c.status !== 'pending' || c.dueDate !== tomorrow || c.commitmentReminderSent) continue;
      const assignee = data.users.find((u) => u.id === Number(c.assignedToUserId));
      if (!assignee || !assignee.email) continue;
      await sendCommitmentDueSoonEmail(c, assignee.email, assignee.name, m.title);
      await withDb((d) => {
        const meeting = d.meetings.find((x) => x.id === m.id);
        const target = meeting?.commitments?.find((x) => x.id === c.id);
        if (target) target.commitmentReminderSent = true;
      });
    }
  }
}

// Resumen diario para cada líder de Obispado y el Administrador — como
// mucho una vez por día de calendario (lastDigestDate en memoria; si el
// servidor se reinicia justo ese día, en el peor de los casos se manda una
// segunda vez, sin mayor daño).
let lastDigestDate = null;
async function checkDailyDigest() {
  if (!isEmailConfigured()) return;
  const today = todayISO();
  if (lastDigestDate === today) return;
  const data = load();
  const overview = computeBishopricOverview(data);
  // overview.cleaningPending son los YA ATRASADOS (fecha < hoy); acá interesa
  // el turno programado para HOY, sin importar su estado todavía.
  const cleaningToday = data.cleaningShifts.filter((s) => s.date === today).map((s) => ({ id: s.id, date: s.date, familyName: s.familyName }));
  const interviewsToday = overview.upcomingInterviews.filter((iv) => iv.date === today);
  const activitiesToday = data.events.filter((e) => e.date === today && !e.isMeeting);
  // Los compromisos ATRASADOS ya viven en overview.overdueCommitments; acá
  // se calculan aparte los que vencen justo HOY (todavía no atrasados).
  const dueToday = [];
  for (const m of data.meetings) {
    if (m.status !== 'active') continue;
    for (const c of (m.commitments || [])) {
      if (c.status === 'pending' && c.dueDate === today) {
        const assignee = data.users.find((u) => u.id === Number(c.assignedToUserId));
        dueToday.push({ description: c.description, assignedToName: assignee?.name || '(usuario eliminado)' });
      }
    }
  }
  const recipients = data.users.filter((u) => u.email && isObispadoLeader(u, data));
  if (!recipients.length) { lastDigestDate = today; return; }
  for (const u of recipients) {
    await sendDailyDigestEmail(u.email, u.name, {
      cleaningToday, interviewsToday, activitiesToday, commitmentsDueToday: dueToday,
    });
  }
  lastDigestDate = today;
}

export function startReminderScheduler() {
  if (!isEmailConfigured()) {
    console.log('[recordatorios] desactivados: falta GMAIL_USER o GMAIL_APP_PASSWORD en las variables de entorno.');
    return;
  }
  console.log('[recordatorios] activados vía Gmail — revisando cada 15 minutos (entrevistas 24h antes, compromisos que vencen mañana, y resumen diario para el Obispado).');
  const runAll = () => Promise.all([
    checkAndSendReminders(),
    checkCommitmentReminders(),
    checkDailyDigest(),
  ]);
  runAll().catch((err) => console.error('[recordatorios] error inicial:', err));
  setInterval(() => {
    runAll().catch((err) => console.error('[recordatorios] error:', err));
  }, CHECK_EVERY_MS);
}
