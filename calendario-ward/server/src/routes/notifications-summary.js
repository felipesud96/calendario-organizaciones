import { sendJson } from '../router.js';
import { load } from '../db.js';
import { requireAuth } from '../guard.js';
import { isObispadoLeader } from './stake.js';
import { computeBishopricOverview } from './dashboard.js';
import { pendingEvaluationsFor } from './stats.js';

// Módulo "Campana de notificaciones": junta en un solo lugar los avisos que
// antes solo vivían en pantallas sueltas (o, en el caso de los compromisos
// pendientes, en un modal de una sola vez al iniciar sesión) — reutilizando
// EXACTAMENTE los mismos cálculos que ya usan sus propias pestañas
// (computeBishopricOverview, pendingEvaluationsFor), para no duplicar
// lógica ni arriesgar que un número no calce entre la campana y la pantalla
// real. No es "en vivo" (no hay websockets ni push) — el cliente la vuelve a
// pedir cada vez que se abre, lo cual es más que suficiente para el ritmo de
// uso de una app de barrio.

export function registerNotificationsSummaryRoutes(router) {
  router.get('/api/notifications/summary', requireAuth(async (req, res) => {
    const data = load();
    const user = req.user;
    const items = [];

    // Compromisos pendientes propios — cualquier perfil (en la práctica,
    // solo Líder/Administrador llegan a tener alguno, porque solo a ellos
    // se les puede asignar un compromiso).
    const mine = [];
    for (const m of data.meetings) {
      for (const c of (m.commitments || [])) {
        if (Number(c.assignedToUserId) === Number(user.id) && c.status === 'pending') mine.push(c);
      }
    }
    if (mine.length > 0) {
      items.push({
        key: 'myCommitments', icon: '🔔', count: mine.length,
        label: `Compromiso${mine.length === 1 ? '' : 's'} pendiente${mine.length === 1 ? '' : 's'}`,
        view: 'meetings', subtab: 'mine',
      });
    }

    if (user.role === 'admin' || user.role === 'leader') {
      // Actividades por evaluar de la propia organización (o de todo el
      // Barrio para el Administrador) — mismo alcance que la Bandeja de
      // Evaluación.
      const orgId = user.role === 'admin' ? null : Number(user.organizationId);
      const pending = pendingEvaluationsFor(user, data, orgId);
      if (pending.length > 0) {
        items.push({
          key: 'pendingEvaluations', icon: '📝', count: pending.length,
          label: `Actividad${pending.length === 1 ? '' : 'es'} por evaluar`,
          view: 'stats', subtab: 'pending',
        });
      }
      // Solicitudes de entrevista por confirmar (Punto 4) — la propia
      // organización, o todas si es líder de Obispado/Administrador (mismo
      // alcance que la bandeja de Entrevistas → Solicitudes).
      const pendingRequests = data.interviewRequests.filter((r) => r.status === 'pending'
        && (isObispadoLeader(user, data) || Number(r.organizationId) === Number(user.organizationId)));
      if (pendingRequests.length > 0) {
        items.push({
          key: 'pendingInterviewRequests', icon: '📥', count: pendingRequests.length,
          label: `Solicitud${pendingRequests.length === 1 ? '' : 'es'} de entrevista por confirmar`,
          view: 'interviews', subtab: 'requests',
        });
      }
    }

    if (isObispadoLeader(user, data)) {
      // Panorama de todo el Barrio — mismo cálculo que el Panel de
      // Obispado, así los números siempre calzan entre la campana y esa
      // pantalla.
      const overview = computeBishopricOverview(data);
      if (overview.overdueCommitments.length > 0) {
        items.push({
          key: 'overdueCommitments', icon: '⏰', count: overview.overdueCommitments.length,
          label: `Compromiso${overview.overdueCommitments.length === 1 ? '' : 's'} atrasado${overview.overdueCommitments.length === 1 ? '' : 's'} en el Barrio`,
          view: 'bishopricPanel',
        });
      }
      if (overview.cleaningPending.length > 0) {
        items.push({
          key: 'cleaningPending', icon: '🧹', count: overview.cleaningPending.length,
          label: `Turno${overview.cleaningPending.length === 1 ? '' : 's'} de aseo sin confirmar`,
          view: 'cleaning', subtab: 'cleaning',
        });
      }
      if (overview.upcomingInterviews.length > 0) {
        items.push({
          key: 'upcomingInterviews', icon: '👤', count: overview.upcomingInterviews.length,
          label: `Entrevista${overview.upcomingInterviews.length === 1 ? '' : 's'} esta semana`,
          view: 'interviews',
        });
      }
    }

    const total = items.reduce((sum, it) => sum + it.count, 0);
    sendJson(res, 200, { total, items });
  }));
}
