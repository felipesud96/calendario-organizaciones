import { sendJson } from '../router.js';
import { load, withDb } from '../db.js';
import { requireRole } from '../guard.js';
import { isObispadoLeader, keyLeadersForMinistering } from './stake.js';
import { currentQuarter, quarterLabel, quarterOf } from '../quarter.js';
import { allCategoryRefs, summaryFor } from './budget.js';
import { lastMeetingDateOfType } from './meetings.js';

// Módulo "Panel de Obispado": un resumen de una sola pantalla que junta lo
// más urgente de TODAS las organizaciones — compromisos atrasados, turnos
// de aseo sin confirmar, entrevistas próximas y el presupuesto del
// trimestre — para no tener que entrar módulo por módulo a armarse una
// idea general. Estrictamente para el Administrador o el líder de
// Obispado, igual que Aseo del Edificio (isObispadoLeader).

const todayISO = () => new Date().toISOString().slice(0, 10);

function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Extraído a su propia función (en vez de vivir solo dentro del handler de
// la ruta) para que notifications.js pueda reutilizar EXACTAMENTE el mismo
// cálculo al armar la campana de notificaciones del líder de Obispado /
// Administrador, sin duplicar esta lógica.
export function computeBishopricOverview(data) {
    const today = todayISO();
    const weekEnd = addDaysISO(7);

    // Compromisos atrasados: actas activas, compromisos "pending" cuya
    // fecha límite ya pasó — de TODAS las organizaciones (ver
    // meetings.js/canSeeMeeting, que por su parte SÍ acota el listado de
    // actas por organización; acá es intencional que no se acote, porque
    // este panel es justo el panorama completo que solo Obispado/Admin ven).
    const overdueCommitments = [];
    for (const m of data.meetings) {
      if (m.status !== 'active') continue;
      const org = data.organizations.find((o) => o.id === Number(m.organizationId));
      for (const c of (m.commitments || [])) {
        if (c.status !== 'pending' || !c.dueDate || c.dueDate >= today) continue;
        const assignee = data.users.find((u) => u.id === Number(c.assignedToUserId));
        overdueCommitments.push({
          commitmentId: c.id,
          meetingId: m.id,
          meetingTitle: m.title,
          organizationName: org?.name || 'Administración',
          description: c.description,
          dueDate: c.dueDate,
          assignedToName: assignee?.name || '(usuario eliminado)',
          // El cliente lo usa para saber si quien ve el panel es justo el
          // responsable de este compromiso — en ese caso (y solo en ese
          // caso) le muestra el botón "✅ Completar" directamente en la
          // tarjeta, sin tener que entrar a Reuniones y Consejos.
          assignedToUserId: c.assignedToUserId ?? null,
        });
      }
    }
    overdueCommitments.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const overdueByOrg = {};
    overdueCommitments.forEach((c) => { overdueByOrg[c.organizationName] = (overdueByOrg[c.organizationName] || 0) + 1; });

    // Turnos de aseo ya pasados de fecha que siguen "scheduled" — ni "Sí
    // fue" ni "No fue" — o sea, a alguien se le olvidó confirmar.
    const cleaningPending = data.cleaningShifts
      .filter((s) => s.status === 'scheduled' && s.date < today)
      .map((s) => ({ id: s.id, date: s.date, familyName: s.familyName }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Entrevistas de los próximos 7 días, de todas las organizaciones —
    // quien ve este panel (Obispado/Admin) ya tiene panorama completo de
    // entrevistas de todas formas (ver interviews.js/orgSeesAllInterviews).
    // Solo las que todavía están "pendientes de verificar" (sin marcar
    // ✅/❌ todavía) — las ya marcadas no necesitan atención y viven en el
    // historial de Entrevistas.
    const upcomingInterviews = data.interviews
      .filter((iv) => iv.date >= today && iv.date <= weekEnd && (iv.status || 'scheduled') === 'scheduled')
      .map((iv) => {
        const org = data.organizations.find((o) => o.id === Number(iv.organizationId));
        return {
          id: iv.id,
          date: iv.date,
          startTime: iv.startTime,
          memberName: iv.memberName,
          interviewerName: iv.interviewerName,
          organizationName: org?.name || '',
        };
      })
      .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));

    // Actividades de los próximos 7 días (de todo el barrio) — solo un
    // conteo, para tener una idea de cuán cargada viene la semana.
    const activitiesThisWeek = data.events.filter((e) => e.date >= today && e.date <= weekEnd).length;

    // Presupuesto del trimestre actual, resumido (reutiliza la misma lógica
    // que el módulo Presupuesto, para no duplicar el cálculo de saldo).
    const quarter = currentQuarter();
    const categorySummaries = allCategoryRefs(data).map((ref) => summaryFor(data, quarter, ref));
    const totalAssigned = categorySummaries.reduce((s, c) => s + c.assigned, 0);
    const totalSpent = categorySummaries.reduce((s, c) => s + c.spent, 0);

    // Punto 10: aviso si pasó más tiempo del que el Obispo definió (por
    // defecto 7 días) desde el último Consejo de Barrio registrado — la
    // frecuencia es configurable, ver PUT /api/ward-settings.
    const councilFrequencyDays = data.wardSettings?.councilFrequencyDays || 7;
    const lastCouncilDate = lastMeetingDateOfType(data, 'consejo_barrio');
    const daysSinceCouncil = lastCouncilDate ? Math.floor((Date.parse(today) - Date.parse(lastCouncilDate)) / 86400000) : null;
    const wardCouncil = {
      frequencyDays: councilFrequencyDays,
      lastDate: lastCouncilDate,
      daysSinceLast: daysSinceCouncil,
      overdue: lastCouncilDate ? daysSinceCouncil > councilFrequencyDays : true,
    };

    // Punto 8: la Coordinación de Ministración debe darse al menos una vez
    // por trimestre (Manual General 7.1.1.1) — se avisa si la última
    // registrada no cae dentro del trimestre en curso, dirigido a las tres
    // personas que el manual identifica (no "un líder" cualquiera de esas
    // organizaciones — ver isPresident en users.js).
    const lastMinisteringDate = lastMeetingDateOfType(data, 'coordinacion_ministracion');
    const ministeringCoordination = {
      quarter,
      quarterLabel: quarterLabel(quarter),
      lastDate: lastMinisteringDate,
      overdue: !lastMinisteringDate || quarterOf(lastMinisteringDate) !== quarter,
      keyLeaders: keyLeadersForMinistering(data),
    };

    return {
      generatedAt: new Date().toISOString(),
      overdueCommitments,
      overdueByOrg,
      cleaningPending,
      upcomingInterviews,
      activitiesThisWeek,
      budget: {
        quarter,
        quarterLabel: quarterLabel(quarter),
        totalAssigned,
        totalSpent,
        totalBalance: totalAssigned - totalSpent,
      },
      wardCouncil,
      ministeringCoordination,
    };
}

export function registerDashboardRoutes(router) {
  router.get('/api/dashboard/overview', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    if (!isObispadoLeader(req.user, data)) {
      return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado pueden ver el Panel de Obispado' });
    }
    sendJson(res, 200, computeBishopricOverview(data));
  }));

  // Punto 10: el Obispo define (y puede ir editando) cada cuántos días
  // espera tener un Consejo de Barrio — no queda fijo en el código.
  router.put('/api/ward-settings', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const data0 = load();
    if (!isObispadoLeader(req.user, data0)) {
      return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado pueden cambiar esta configuración' });
    }
    const days = Number(body?.councilFrequencyDays);
    if (!Number.isFinite(days) || days < 1 || days > 90) {
      return sendJson(res, 400, { error: 'La frecuencia debe ser un número de días entre 1 y 90' });
    }
    await withDb((data) => {
      data.wardSettings = { ...data.wardSettings, councilFrequencyDays: Math.round(days) };
    });
    sendJson(res, 200, load().wardSettings);
  }));
}
