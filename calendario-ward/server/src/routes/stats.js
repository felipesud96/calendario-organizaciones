import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireRole } from '../guard.js';
import { canEditOrg, PURPOSE_OPTIONS } from './events.js';
import { isObispadoLeader } from './stake.js';
import { allFamiliesWithStats } from './cleaning.js';
import { allSpeakersWithStats } from './talks.js';
import { allActivityCreatorsWithStats } from './events.js';
import { allMeetingCreatorsWithStats } from './meetings.js';

// Módulo "Estadísticas": evalúa actividades ya pasadas (asistencia
// esperada/real + feedback) y arma un panel resumen por organización — el
// balance del año según "Propósito", el % de éxito de asistencia, y un
// ranking de la actividad más y menos exitosa. Además, un sub-panel
// "Rachas y Logros" (solo Obispado/Admin) con rankings de todo el barrio.

function normalizeSearchText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

const todayISO = () => new Date().toISOString().slice(0, 10);

function parseNonNegativeInt(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

// El líder solo evalúa (y ve en su panel de Estadísticas) las actividades de
// su propia organización — igual que el resto de módulos del barrio; el
// Administrador puede ver/evaluar cualquiera, y si además elige una
// organización puntual, se acota a esa.
function scopeOrganizationId(req) {
  if (req.user.role === 'admin') {
    return req.query.organizationId ? Number(req.query.organizationId) : null; // null = todo el Barrio
  }
  return Number(req.user.organizationId);
}

function evaluationForEvent(data, eventId) {
  return data.eventEvaluations.find((ev) => Number(ev.eventId) === Number(eventId)) || null;
}

function withEventInfo(ev, data) {
  const org = data.organizations.find((o) => o.id === Number(ev.organizationId));
  // rsvpYes: cuántos marcaron "Voy" — se usa como sugerencia (no obligación)
  // de Asistencia Esperada al abrir el formulario de evaluación, ver idea
  // "confirmación de asistencia" en app.js/evaluationModalHtml.
  const rsvps = Array.isArray(ev.rsvps) ? ev.rsvps : [];
  const rsvpYes = rsvps.filter((r) => r.response === 'yes').length;
  return { ...ev, organizationName: org?.name || '', organizationColor: org?.color || '#999999', rsvpYes };
}

// Extraído a su propia función para que notifications.js pueda reutilizar
// el mismo conteo de "actividades por evaluar" en la campana de
// notificaciones sin duplicar esta lógica.
export function pendingEvaluationsFor(user, data, orgId) {
  const today = todayISO();
  let items = data.events.filter((e) => e.date < today && !evaluationForEvent(data, e.id));
  if (orgId !== null && orgId !== undefined) items = items.filter((e) => Number(e.organizationId) === orgId);
  return items.map((e) => withEventInfo(e, data)).sort((a, b) => a.date.localeCompare(b.date));
}

export function registerStatsRoutes(router) {
  // Bandeja de evaluación: actividades que ya pasaron de fecha y todavía no
  // tienen evaluación guardada. Al guardar una evaluación desaparecen de acá
  // (ver POST /api/stats/evaluations).
  router.get('/api/stats/pending-evaluations', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    const orgId = scopeOrganizationId(req);
    sendJson(res, 200, pendingEvaluationsFor(req.user, data, orgId));
  }));

  router.post('/api/stats/evaluations', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const data0 = load();
    const eventId = Number(body?.eventId);
    const event = data0.events.find((e) => e.id === eventId);
    if (!event) return sendJson(res, 404, { error: 'Actividad no encontrada' });
    if (!canEditOrg(req.user, event.organizationId)) {
      return sendJson(res, 403, { error: 'Solo el líder de la organización (o un Administrador) puede evaluar esta actividad' });
    }
    if (event.date >= todayISO()) {
      return sendJson(res, 400, { error: 'Solo se pueden evaluar actividades que ya pasaron de fecha' });
    }
    const expectedAttendance = parseNonNegativeInt(body?.expectedAttendance);
    const actualAttendance = parseNonNegativeInt(body?.actualAttendance);
    if (expectedAttendance === null || actualAttendance === null) {
      return sendJson(res, 400, { error: 'La asistencia esperada y la asistencia real deben ser números enteros (0 o más)' });
    }
    const feedback = String(body?.feedback || '').trim();
    const now = new Date().toISOString();
    const saved = await withDb((data) => {
      let evaluation = data.eventEvaluations.find((ev) => Number(ev.eventId) === eventId);
      if (evaluation) {
        Object.assign(evaluation, { expectedAttendance, actualAttendance, feedback, evaluatedBy: req.user.id, evaluatedAt: now });
      } else {
        evaluation = {
          id: nextId(data, 'eventEvaluations'),
          eventId, expectedAttendance, actualAttendance, feedback,
          evaluatedBy: req.user.id, evaluatedAt: now,
        };
        data.eventEvaluations.push(evaluation);
      }
      return evaluation;
    });
    sendJson(res, 201, saved);
  }));

  // Dashboard: balance del año por Propósito, % de éxito general, y ranking
  // de la actividad más y menos exitosa (asistencia real / esperada).
  router.get('/api/stats/dashboard', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    const orgId = scopeOrganizationId(req);
    const yearsWithData = new Set([new Date().getFullYear()]);
    data.events.forEach((e) => { const y = Number(String(e.date).slice(0, 4)); if (y) yearsWithData.add(y); });
    const requestedYear = Number(req.query.year);
    const year = yearsWithData.has(requestedYear) ? requestedYear : new Date().getFullYear();

    let events = data.events.filter((e) => String(e.date).startsWith(String(year)));
    if (orgId !== null) events = events.filter((e) => Number(e.organizationId) === orgId);

    const evaluated = events
      .map((e) => ({ event: e, evaluation: evaluationForEvent(data, e.id) }))
      .filter((x) => !!x.evaluation);

    const purposeBalance = {};
    PURPOSE_OPTIONS.forEach((p) => { purposeBalance[p] = 0; });
    let sinPropósito = 0;
    evaluated.forEach(({ event }) => {
      if (event.purpose && purposeBalance[event.purpose] !== undefined) purposeBalance[event.purpose] += 1;
      else sinPropósito += 1;
    });

    const withPct = evaluated
      .filter(({ evaluation }) => evaluation.expectedAttendance > 0)
      .map(({ event, evaluation }) => ({
        id: event.id,
        title: event.title,
        date: event.date,
        expectedAttendance: evaluation.expectedAttendance,
        actualAttendance: evaluation.actualAttendance,
        pct: Math.round((evaluation.actualAttendance / evaluation.expectedAttendance) * 1000) / 10,
      }));

    const totalExpected = withPct.reduce((sum, x) => sum + x.expectedAttendance, 0);
    const totalActual = withPct.reduce((sum, x) => sum + x.actualAttendance, 0);
    const overallSuccessPct = totalExpected > 0 ? Math.round((totalActual / totalExpected) * 1000) / 10 : null;

    let topActivity = null;
    let bottomActivity = null;
    if (withPct.length) {
      topActivity = withPct.reduce((best, x) => (x.pct > best.pct ? x : best), withPct[0]);
      bottomActivity = withPct.reduce((worst, x) => (x.pct < worst.pct ? x : worst), withPct[0]);
    }

    // Evolución mensual del % de asistencia (para el mini-gráfico de
    // tendencia del Panel de Control): un punto por mes del año
    // seleccionado, promediado con el mismo criterio que overallSuccessPct
    // (suma de asistencia real / suma de asistencia esperada, no un
    // promedio simple de porcentajes — así un mes con una sola actividad
    // chica no pesa igual que uno con varias grandes). `pct: null` cuando
    // el mes no tiene ninguna actividad evaluada todavía, para que el
    // frontend pueda mostrar un hueco en vez de un 0% engañoso.
    const monthlyAttendance = Array.from({ length: 12 }, (_, i) => {
      const monthNum = i + 1;
      const monthPrefix = `${year}-${String(monthNum).padStart(2, '0')}`;
      const monthItems = withPct.filter((x) => x.date.startsWith(monthPrefix));
      if (!monthItems.length) return { month: monthNum, pct: null, count: 0 };
      const expSum = monthItems.reduce((s, x) => s + x.expectedAttendance, 0);
      const actSum = monthItems.reduce((s, x) => s + x.actualAttendance, 0);
      return { month: monthNum, pct: expSum > 0 ? Math.round((actSum / expSum) * 1000) / 10 : null, count: monthItems.length };
    });

    sendJson(res, 200, {
      year,
      years: [...yearsWithData].sort((a, b) => b - a),
      organizationId: orgId,
      isAdmin: req.user.role === 'admin',
      canPickOrganization: req.user.role === 'admin',
      evaluatedCount: evaluated.length,
      totalActivitiesInYear: events.length,
      purposeBalance,
      sinPropósito,
      overallSuccessPct,
      // Si solo hay una actividad evaluada (o todas quedaron con el mismo
      // % de éxito), "más" y "menos" exitosa naturalmente son la misma —
      // no hay nada raro en eso, no hace falta forzar que sean distintas.
      topActivity,
      bottomActivity,
      monthlyAttendance,
    });
  }));

  // Lista de organizaciones para el selector del Administrador ("Todo el
  // Barrio" vs. una organización puntual) — reutiliza isObispadoLeader solo
  // para no dejar el import sin usar si en el futuro se acota también a
  // Obispado; hoy cualquier Líder ya está acotado a su propia organización.
  router.get('/api/stats/scope-check', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    sendJson(res, 200, { isObispado: isObispadoLeader(req.user, data) });
  }));

  // "Rachas y Logros" — pestaña "Todo el tiempo": mismos 6 rankings que
  // achievements.js calcula por período (mes/trimestre/semestre/año), pero
  // sin filtrar por fecha — el histórico completo desde que existe la app.
  // Requiere datos de TODAS las organizaciones, así que — igual que el
  // Panel de Obispado — es estrictamente para el Administrador o el líder
  // de Obispado.
  router.get('/api/stats/rankings', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    if (!isObispadoLeader(req.user, data)) {
      return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado pueden ver el Panel de Rachas y Logros' });
    }
    sendJson(res, 200, allCategoryRankings(data));
  }));
}

// Compromisos: % cumplidos por persona, sobre compromisos ya RESUELTOS
// (completados o no cumplidos) — los que siguen "pending" todavía no
// tuvieron su oportunidad, así que no cuentan ni a favor ni en contra de
// nadie. Se agrupan por su propia dueDate (fecha límite/de verificación)
// para poder acotarlos a un período. Reutilizado por achievements.js.
// `range` es opcional ({start, end} ISO, ambas inclusive).
export function commitmentsRanking(data, range) {
  const inRange = (date) => !range || (date >= range.start && date <= range.end);
  const byUser = new Map();
  for (const m of data.meetings) {
    for (const c of (m.commitments || [])) {
      if (c.status !== 'completed' && c.status !== 'not_fulfilled') continue;
      if (!inRange(c.dueDate)) continue;
      const uid = Number(c.assignedToUserId);
      if (!byUser.has(uid)) byUser.set(uid, { completed: 0, notFulfilled: 0 });
      const entry = byUser.get(uid);
      if (c.status === 'completed') entry.completed += 1; else entry.notFulfilled += 1;
    }
  }
  return [...byUser.entries()]
    .map(([uid, e]) => {
      const user = data.users.find((u) => u.id === uid);
      const total = e.completed + e.notFulfilled;
      return {
        userId: uid,
        userName: user?.name || '(usuario eliminado)',
        completed: e.completed,
        notFulfilled: e.notFulfilled,
        total,
        pct: total > 0 ? Math.round((e.completed / total) * 1000) / 10 : null,
      };
    })
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.total - a.total);
}

// Entrevistas: "interviewerName" es texto libre (se autocompleta con el
// nombre de quien la agenda, ver interviews.js) — se agrupa normalizado,
// para que mayúsculas o tildes distintas no fragmenten el conteo de la
// misma persona. Solo cuentan las que se verificaron como "Se hizo" (ver el
// check ✅/❌ de interviews.js) — igual criterio que Aseo y Discursos, que
// solo suman lo efectivamente cumplido, no lo agendado. Cuando se entrevistó
// a más de una persona a la vez (matrimonio, compañerismo de ministración),
// cuenta como UNA sola entrevista realizada, no una por persona citada — se
// dedup por `groupId` (ver interviews.js). Reutilizado por achievements.js.
// `range` es opcional ({start, end} ISO, ambas inclusive) y filtra por la
// fecha de la entrevista.
export function interviewsRanking(data, range) {
  const inRange = (date) => !range || (date >= range.start && date <= range.end);
  const byInterviewer = new Map();
  const countedGroups = new Set();
  for (const iv of data.interviews) {
    if (iv.status !== 'done') continue;
    if (!inRange(iv.date)) continue;
    const norm = normalizeSearchText(iv.interviewerName);
    if (!norm) continue;
    const groupKey = `${norm}::${iv.groupId}`;
    if (countedGroups.has(groupKey)) continue;
    countedGroups.add(groupKey);
    if (!byInterviewer.has(norm)) byInterviewer.set(norm, { interviewerName: iv.interviewerName, count: 0 });
    byInterviewer.get(norm).count += 1;
  }
  return [...byInterviewer.values()].sort((a, b) => b.count - a.count);
}

// Junta los 6 rankings de Rachas y Logros en un solo objeto — usado tanto
// por "Todo el tiempo" (sin range) como por achievements.js para cada
// período (con range). Centralizar esto acá evita que ambos lados se
// desincronicen si mañana se agrega o cambia una categoría.
export function allCategoryRankings(data, range) {
  return {
    commitmentsRanking: commitmentsRanking(data, range),
    cleaningRanking: allFamiliesWithStats(data, range),
    interviewsRanking: interviewsRanking(data, range),
    talksRanking: allSpeakersWithStats(data, range),
    activitiesRanking: allActivityCreatorsWithStats(data, range),
    meetingsRanking: allMeetingCreatorsWithStats(data, range),
  };
}
