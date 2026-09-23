// ----------------------------------------------------------------------
// "MI SEMANA" (App 3) + RESUMEN SEMANAL DE DESERET (punto 6)
// ----------------------------------------------------------------------
// Un solo cálculo, tres usos:
//   1. GET /api/mi-semana → pantalla de inicio "Mi semana" según el rol.
//   2. Deseret: "¿qué tengo esta semana?".
//   3. Aviso automático los domingos en la tarde (notificación push, y
//      correo si está configurado) con lo que le toca a cada líder.
// Siempre con los mismos permisos de cada módulo.
// ----------------------------------------------------------------------
import { load, withDb } from './db.js';
import { isObispadoLeader } from './routes/stake.js';
import { canScheduleOrg, orgSeesAllInterviews } from './routes/interviews.js';
import { canSeeMeeting } from './routes/events.js';
import { sendUserPush } from './webpush.js';
import { notifEnabled } from './notifications.js';

const ZONA = process.env.TZ_APP || 'America/Santiago';
function ahoraChile() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour), minuto: Number(p.minute), diaSemana: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
const sumarDias = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

function canDecideFor(user, data, organizationId) {
  if (user.role === 'admin') return true;
  if (user.role === 'executive_secretary') return Number(user.organizationId) === Number(organizationId);
  if (user.role !== 'leader') return false;
  if (Number(user.organizationId) === Number(organizationId)) return true;
  return isObispadoLeader(user, data);
}

// `desde` inclusive, `dias` hacia adelante (7 = la semana).
export function resumenSemana(user, data = load(), { desde = null, dias = 7 } = {}) {
  const hoy = ahoraChile().fecha;
  const ini = desde || hoy;
  const fin = sumarDias(ini, dias - 1);
  const org = (id) => data.organizations.find((o) => o.id === Number(id));
  const obispado = isObispadoLeader(user, data);
  const lider = ['admin', 'leader', 'executive_secretary'].includes(user.role);

  // Entrevistas: las que hago yo (entrevistador) o las que me hacen a mí.
  const entrevistas = (data.interviews || [])
    .filter((iv) => (iv.status || 'scheduled') === 'scheduled' && iv.date >= ini && iv.date <= fin)
    .filter((iv) => Number(iv.interviewerUserId) === Number(user.id) || Number(iv.memberUserId) === Number(user.id)
      || (lider && !iv.interviewerUserId && iv.interviewerName === user.name))
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime))
    .map((iv) => ({
      tipo: 'entrevista', fecha: iv.date, hora: iv.startTime || '',
      titulo: Number(iv.memberUserId) === Number(user.id) ? `Tu entrevista${iv.interviewerName ? ` con ${iv.interviewerName}` : ''}` : iv.memberName,
      org: org(iv.organizationId)?.name || '', color: org(iv.organizationId)?.color || null, vista: 'interviews',
    }));

  // Entrevistas ya pasadas que siguen sin marcar (✅/❌) — solo líderes.
  const sinMarcar = lider ? (data.interviews || []).filter((iv) => (iv.status || 'scheduled') === 'scheduled' && iv.date < hoy
    && iv.date >= sumarDias(hoy, -30) && canScheduleOrg(user, iv.organizationId)
    && (orgSeesAllInterviews(user, data) || Number(iv.organizationId) === Number(user.organizationId))).length : 0;

  // Solicitudes de entrevista esperando decisión.
  const solicitudes = lider ? (data.interviewRequests || []).filter((r) => r.status === 'pending' && canDecideFor(user, data, r.organizationId))
    .map((r) => ({ tipo: 'solicitud', fecha: r.date, hora: r.startTime, titulo: r.memberName, org: org(r.organizationId)?.name || '', color: org(r.organizationId)?.color || null, vista: 'interviews' })) : [];

  // Mis compromisos: atrasados y los que vencen en el período.
  const compromisos = [];
  for (const m of data.meetings || []) {
    if (m.status !== 'active') continue;
    for (const c of m.commitments || []) {
      if (c.status !== 'pending' || Number(c.assignedToUserId) !== Number(user.id) || !c.dueDate || c.dueDate > fin) continue;
      compromisos.push({ tipo: 'compromiso', fecha: c.dueDate, hora: '', titulo: c.description, org: m.title, color: null, atrasado: c.dueDate < hoy, vista: 'meetings' });
    }
  }
  compromisos.sort((a, b) => a.fecha.localeCompare(b.fecha));

  // Actividades del período: las de mi organización y las de todo el barrio
  // (el Obispado ve todas). Las reuniones privadas respetan canSeeMeeting.
  const actividades = (data.events || [])
    .filter((e) => e.date >= ini && e.date <= fin && canSeeMeeting(user, e))
    .filter((e) => obispado || e.isWardActivity || Number(e.organizationId) === Number(user.organizationId)
      || (e.involvedOrganizationIds || []).map(Number).includes(Number(user.organizationId)))
    .sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')))
    .map((e) => ({ tipo: 'actividad', fecha: e.date, hora: e.startTime || '', titulo: e.title, org: org(e.organizationId)?.name || 'Barrio', color: org(e.organizationId)?.color || null, vista: 'calendar' }));

  // Aseo del edificio (Obispado): turnos de la semana y atrasados sin confirmar.
  const aseo = obispado ? (data.cleaningShifts || []).filter((s) => s.date <= fin && (s.date >= ini || s.status === 'scheduled') && s.date >= sumarDias(hoy, -14))
    .filter((s) => s.date >= ini || s.status === 'scheduled')
    .map((s) => ({ tipo: 'aseo', fecha: s.date, hora: '', titulo: s.familyName, org: s.date < hoy ? 'Sin confirmar' : 'Aseo del edificio', color: null, atrasado: s.date < hoy, vista: 'cleaning' })) : [];

  const atrasados = compromisos.filter((c) => c.atrasado).length;
  return {
    desde: ini, hasta: fin, hoy,
    totales: { entrevistas: entrevistas.length, solicitudes: solicitudes.length, compromisos: compromisos.length, atrasados, actividades: actividades.length, sinMarcar },
    entrevistas, solicitudes, compromisos, actividades: actividades.slice(0, 20), aseo,
  };
}

// Frase corta para la notificación / Deseret.
export function fraseResumen(r) {
  const t = r.totales;
  const partes = [];
  if (t.entrevistas) partes.push(`${t.entrevistas} entrevista${t.entrevistas === 1 ? '' : 's'}`);
  if (t.solicitudes) partes.push(`${t.solicitudes} solicitud${t.solicitudes === 1 ? '' : 'es'} por confirmar`);
  if (t.compromisos) partes.push(`${t.compromisos} compromiso${t.compromisos === 1 ? '' : 's'}${t.atrasados ? ` (${t.atrasados} atrasado${t.atrasados === 1 ? '' : 's'})` : ''}`);
  if (t.actividades) partes.push(`${t.actividades} actividad${t.actividades === 1 ? '' : 'es'}`);
  if (t.sinMarcar) partes.push(`${t.sinMarcar} entrevista${t.sinMarcar === 1 ? '' : 's'} sin marcar`);
  return partes.length ? partes.join(', ') : 'nada pendiente 🎉';
}

// ---------------- Aviso semanal (domingo 20:00, hora de Chile) ----------------
// Una vez por semana por persona (weeklySummarySentFor guarda la fecha del
// domingo en que se envió, así un reinicio del servidor no lo repite).
async function enviarResumenesSemanales() {
  const ahora = ahoraChile();
  if (ahora.diaSemana !== 0 || ahora.hora < 20) return;
  const data = load();
  const enviados = data.weeklySummarySentFor || {};
  const lunes = sumarDias(ahora.fecha, 1);
  const destinatarios = data.users.filter((u) => ['admin', 'leader', 'executive_secretary', 'ward_clerk'].includes(u.role)
    && enviados[u.id] !== ahora.fecha && notifEnabled(u, 'push') && notifEnabled(u, 'weeklySummary'));
  if (!destinatarios.length) return;
  for (const u of destinatarios) {
    const r = resumenSemana(u, data, { desde: lunes, dias: 7 });
    try {
      await sendUserPush(u, { title: 'Tu semana en OrganizaSion', body: `Esta semana: ${fraseResumen(r)}.`, url: '/?vista=home' });
    } catch (e) { /* sin suscripción push: no pasa nada */ }
  }
  await withDb((d) => {
    d.weeklySummarySentFor = d.weeklySummarySentFor || {};
    for (const u of destinatarios) d.weeklySummarySentFor[u.id] = ahora.fecha;
  });
}

export function startWeeklySummaryScheduler() {
  setTimeout(() => enviarResumenesSemanales().catch(() => {}), 20 * 1000);
  setInterval(() => enviarResumenesSemanales().catch((e) => console.warn('[resumen semanal]', e.message)), 15 * 60 * 1000);
}
