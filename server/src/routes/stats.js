import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireRole } from '../guard.js';
import { canEditOrg, PURPOSE_OPTIONS } from './events.js';
import { isObispadoLeader } from './stake.js';

// Módulo "Estadísticas": evalúa actividades ya pasadas (asistencia
// esperada/real + feedback) y arma un panel resumen por organización — el
// balance del año según "Propósito", el % de éxito de asistencia, y un
// ranking de la actividad más y menos exitosa.

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
  return { ...ev, organizationName: org?.name || '', organizationColor: org?.color || '#999999' };
}

export function registerStatsRoutes(router) {
  // Bandeja de evaluación: actividades que ya pasaron de fecha y todavía no
  // tienen evaluación guardada. Al guardar una evaluación desaparecen de acá
  // (ver POST /api/stats/evaluations).
  router.get('/api/stats/pending-evaluations', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    const orgId = scopeOrganizationId(req);
    const today = todayISO();
    let items = data.events.filter((e) => e.date < today && !evaluationForEvent(data, e.id));
    if (orgId !== null) items = items.filter((e) => Number(e.organizationId) === orgId);
    items = items.map((e) => withEventInfo(e, data)).sort((a, b) => a.date.localeCompare(b.date));
    sendJson(res, 200, items);
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
}
