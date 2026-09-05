// Tarea programada en memoria: cada cierto tiempo revisa qué entrevistas
// empiezan en ~24 horas y todavía no tienen recordatorio enviado, y le
// manda un correo a los dos participantes (líder y miembro) que tengan
// email cargado.
//
// No usa ningún paquete de "cron" externo (no hay acceso a npm en este
// entorno): un simple setInterval alcanza para este volumen de datos.

import { load, withDb, nextId } from './db.js';
import { isEmailConfigured } from './email.js';
import { canSendWhatsApp } from './whatsapp.js';
import {
  sendReminderEmail, sendCommitmentDueSoonEmail, sendDailyDigestEmail, sendCouncilPrepEmail,
  sendInterviewTodayWhatsApp, sendCommitmentDueTodayWhatsApp,
} from './notifications.js';
import { isObispadoLeader } from './routes/stake.js';
import { computeBishopricOverview } from './routes/dashboard.js';
import { previousMeetingOfType } from './routes/meetings.js';
import { quarterOf, quarterLabel } from './quarter.js';

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

// Recordatorio de "tu entrevista es HOY" por WhatsApp — independiente del
// recordatorio de email (que avisa 24 horas antes): este es aparte porque
// el usuario lo pidió explícitamente como notificación de WhatsApp propia,
// y porque WhatsApp (a diferencia del email) solo puede llegarle a una
// cuenta de la app que ya vinculó su teléfono+clave de CallMeBot en "Mi
// Perfil" — ver whatsapp.js. Se dispara una sola vez por entrevista
// (whatsappTodayReminderSent), en cualquier momento del día de hoy (no hace
// falta ninguna ventana de horas como el de 24h, porque "hoy" ya alcanza).
async function checkInterviewTodayWhatsApp() {
  const data = load();
  const today = todayISO();
  const due = data.interviews.filter((iv) =>
    iv.date === today
    && (!iv.status || iv.status === 'scheduled')
    && !iv.whatsappTodayReminderSent
    && iv.memberUserId
  );
  for (const iv of due) {
    const memberUser = data.users.find((u) => u.id === Number(iv.memberUserId));
    if (canSendWhatsApp(memberUser)) await sendInterviewTodayWhatsApp(iv, memberUser);
    await withDb((d) => {
      const target = d.interviews.find((i) => i.id === iv.id);
      if (target) target.whatsappTodayReminderSent = true;
    });
  }
}

// Recordatorio de "tu compromiso vence HOY" por WhatsApp — igual espíritu
// que el de arriba: independiente del recordatorio de email de "vence
// mañana", y solo le llega a quien ya vinculó su WhatsApp.
async function checkCommitmentDueTodayWhatsApp() {
  const data = load();
  const today = todayISO();
  for (const m of data.meetings) {
    if (m.status !== 'active') continue;
    for (const c of (m.commitments || [])) {
      if (c.status !== 'pending' || c.dueDate !== today || c.whatsappDueTodaySent) continue;
      const assignee = data.users.find((u) => u.id === Number(c.assignedToUserId));
      if (canSendWhatsApp(assignee)) await sendCommitmentDueTodayWhatsApp(c, assignee, m.title);
      await withDb((d) => {
        const meeting = d.meetings.find((x) => x.id === m.id);
        const target = meeting?.commitments?.find((x) => x.id === c.id);
        if (target) target.whatsappDueTodaySent = true;
      });
    }
  }
}

// Punto 18 (idea de UX basada en el Manual General): unos días antes de la
// próxima reunión de un consejo (Consejo de Barrio / Coordinación de
// Ministración) ya agendada, avisa a quien prepara la agenda (el Secretario
// de Barrio y el Obispado) qué compromisos del consejo anterior del mismo
// tipo siguen sin resolver. Solo mira reuniones que YA tienen fecha
// registrada (el acta puede nacer como agenda antes de la reunión, ver
// Punto 7), y se dispara una sola vez por acta (councilPrepReminderSent).
const COUNCIL_TYPES = [
  { type: 'consejo_barrio', label: 'Consejo de Barrio' },
  { type: 'coordinacion_ministracion', label: 'Coordinación de Ministración' },
];
const COUNCIL_PREP_LEAD_DAYS = 2;

async function checkCouncilPrepReminders() {
  if (!isEmailConfigured()) return;
  const data = load();
  const target = addDaysISO(COUNCIL_PREP_LEAD_DAYS);
  for (const { type } of COUNCIL_TYPES) {
    const upcoming = data.meetings.filter((m) => m.type === type && m.status === 'active' && m.date === target && !m.councilPrepReminderSent);
    for (const m of upcoming) {
      const previous = previousMeetingOfType(data, type, m.date);
      const pending = previous
        ? (previous.commitments || []).filter((c) => c.status === 'pending' || c.status === 'not_fulfilled')
        : [];
      const pendingInfo = pending.map((c) => ({
        description: c.description,
        dueDate: c.dueDate,
        assignedToName: data.users.find((u) => u.id === Number(c.assignedToUserId))?.name || '(usuario eliminado)',
      }));
      if (pendingInfo.length) {
        const recipients = data.users.filter((u) => u.email && (u.role === 'ward_clerk' || isObispadoLeader(u, data)));
        const seen = new Set();
        for (const u of recipients) {
          if (seen.has(u.email)) continue;
          seen.add(u.email);
          await sendCouncilPrepEmail(u.email, u.name, m, pendingInfo);
        }
      }
      await withDb((d) => {
        const target2 = d.meetings.find((x) => x.id === m.id);
        if (target2) target2.councilPrepReminderSent = true;
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

// Punto pedido explícitamente: "que automáticamente al terminar el
// trimestre haya un compromiso del presidente del cuórum y presidenta de la
// Soc. Socorro de revisar el modelo de enfoque para actualizar los
// estados" — y, sobre cuándo exactamente: "el día siguiente del término del
// trimestre". Se detecta comparando el trimestre de HOY con el de AYER: si
// cambió, hoy es el primer día de un trimestre nuevo (1 ene / 1 abr / 1 jul
// / 1 oct), o sea "el día siguiente" del que acaba de terminar. El
// compromiso se crea dentro de una acta nueva de "Reuniones y Consejos"
// (tipo general, de la propia organización), exactamente como si la
// presidencia se lo hubiera puesto a sí misma — así aparece en "Mis
// Asignaciones" igual que cualquier otro compromiso, con recordatorios por
// email/WhatsApp incluidos (ver checkCommitmentReminders /
// checkCommitmentDueTodayWhatsApp más arriba, que no distinguen de dónde
// vino el compromiso). ministeringFocusQuarterCommitmentsCreated evita
// crearlo dos veces si el servidor se reinicia el mismo día.
const MINISTERING_FOCUS_QUARTER_COMMITMENT_ORGS = ['Cuórum de Élderes', 'Sociedad de Socorro'];
// Plazo para revisar y actualizar los estados del trimestre recién
// terminado — no pedido explícitamente por el usuario; se asume un margen
// razonable de 2 semanas (se puede ajustar si el Obispado prefiere otro).
const MINISTERING_FOCUS_COMMITMENT_DUE_DAYS = 14;

async function checkQuarterEndMinisteringFocusCommitments() {
  const data = load();
  const todayStr = todayISO();
  const justEndedQuarter = quarterOf(addDaysISO(-1));
  if (justEndedQuarter === quarterOf(todayStr)) return; // hoy no es el primer día de un trimestre nuevo
  const alreadyDone = new Set(data.ministeringFocusQuarterCommitmentsCreated || []);
  for (const orgName of MINISTERING_FOCUS_QUARTER_COMMITMENT_ORGS) {
    const org = data.organizations.find((o) => o.name === orgName);
    if (!org) continue;
    const doneKey = `${justEndedQuarter}:${org.id}`;
    if (alreadyDone.has(doneKey)) continue;
    const president = data.users.find((u) => u.role === 'leader' && u.isPresident && Number(u.organizationId) === Number(org.id));
    // Si todavía no hay presidente cargado para esta organización, se
    // reintenta en el próximo ciclo (cada 15 min) hasta que lo haya — no se
    // marca `alreadyDone` en ese caso.
    if (!president) continue;
    const dueDate = addDaysISO(MINISTERING_FOCUS_COMMITMENT_DUE_DAYS);
    const label = quarterLabel(justEndedQuarter);
    await withDb((d) => {
      const commitment = {
        id: nextId(d, 'commitments'),
        description: `Revisar el modelo de Enfoque Ministración de ${orgName} y actualizar los estados de cada persona — ${label}, que acaba de terminar.`,
        dueDate,
        assignedToUserId: president.id,
        confidential: false,
        status: 'pending',
        completedAt: null,
        completionComment: '',
        whatsappDueTodaySent: false,
      };
      d.meetings.push({
        id: nextId(d, 'meetings'),
        title: `Revisión trimestral de Enfoque Ministración — ${orgName} (${label})`,
        date: todayStr,
        type: 'general',
        confidential: false,
        organizationId: org.id,
        status: 'active',
        createdBy: president.id,
        createdAt: new Date().toISOString(),
        archivedAt: null,
        agendaItems: [],
        commitments: [commitment],
        councilPrepReminderSent: false,
      });
      d.ministeringFocusQuarterCommitmentsCreated = d.ministeringFocusQuarterCommitmentsCreated || [];
      d.ministeringFocusQuarterCommitmentsCreated.push(doneKey);
    });
    console.log(`[enfoque-ministracion] compromiso trimestral creado para ${orgName} (${president.name}) — ${label}, vence ${dueDate}`);
  }
}

// A diferencia de antes, este planificador YA NO depende de que el correo
// (Gmail) esté configurado: las notificaciones por WhatsApp son por cuenta
// propia de cada persona (su teléfono + su clave de CallMeBot en "Mi
// Perfil", ver whatsapp.js) y no necesitan ninguna variable de entorno del
// servidor. Cada función de correo sigue auto-desactivándose sola si falta
// GMAIL_USER/GMAIL_APP_PASSWORD (isEmailConfigured() adentro de cada una),
// así que igual conviene arrancar siempre el planificador.
export function startReminderScheduler() {
  if (isEmailConfigured()) {
    console.log('[recordatorios] correo (Gmail) activado — entrevistas 24h antes, compromisos que vencen mañana, preparación de consejos, y resumen diario para el Obispado.');
  } else {
    console.log('[recordatorios] correo (Gmail) desactivado: falta GMAIL_USER o GMAIL_APP_PASSWORD — los recordatorios por email no se enviarán, pero el WhatsApp (por cuenta propia de cada persona) sigue funcionando igual.');
  }
  console.log('[recordatorios] WhatsApp (CallMeBot) activo por defecto — revisando cada 15 minutos quién tiene entrevista o compromiso que vence hoy y ya vinculó su cuenta.');
  const runAll = () => Promise.all([
    checkAndSendReminders(),
    checkCommitmentReminders(),
    checkCouncilPrepReminders(),
    checkDailyDigest(),
    checkInterviewTodayWhatsApp(),
    checkCommitmentDueTodayWhatsApp(),
    checkQuarterEndMinisteringFocusCommitments(),
  ]);
  runAll().catch((err) => console.error('[recordatorios] error inicial:', err));
  setInterval(() => {
    runAll().catch((err) => console.error('[recordatorios] error:', err));
  }, CHECK_EVERY_MS);
}
