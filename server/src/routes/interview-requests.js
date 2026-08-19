import { sendJson } from '../router.js';
import { load, withDb, nextId, interviewEligibility, interviewAvailabilityMatches, timesOverlap, callingLabel } from '../db.js';
import { requireAuth, requireRole } from '../guard.js';

// Punto 4 (ampliación) — ventana de 6 semanas hacia adelante en la que se
// ofrecen fechas disponibles y se buscan choques de horario con entrevistas
// ya agendadas para el mismo líder.
const AVAILABILITY_WINDOW_DAYS = 42;
function isoDatePlusDays(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Entrevistas YA agendadas (status scheduled) para este líder específico en
// esta organización, dentro de las próximas 6 semanas — para que el cliente
// no ofrezca como "disponible" un día/horario que en realidad ya está
// ocupado. Se relaciona por nombre (interviewerName es un campo de texto
// libre, no hay un interviewerUserId) — funciona bien mientras el nombre se
// escriba igual que el del líder, que es lo que hace el flujo normal de la
// app (se precompleta solo).
function busyRangesFor(data, organizationId, leaderName) {
  if (!leaderName) return [];
  const todayIso = isoDatePlusDays(0);
  const limitIso = isoDatePlusDays(AVAILABILITY_WINDOW_DAYS);
  return data.interviews
    .filter((iv) => iv.status === 'scheduled' && Number(iv.organizationId) === Number(organizationId)
      && iv.interviewerName === leaderName && iv.date >= todayIso && iv.date <= limitIso)
    .map((iv) => ({ date: iv.date, startTime: iv.startTime, endTime: iv.endTime || null }));
}
function hasSchedulingConflict(data, organizationId, leaderName, date, startTime, endTime) {
  return busyRangesFor(data, organizationId, leaderName)
    .some((b) => b.date === date && timesOverlap(startTime, endTime, b.startTime, b.endTime));
}

// Punto 4 — Auto-agendamiento de entrevistas, rediseñado como solicitud +
// confirmación: en vez de que el líder deje horarios abiertos para que
// cualquiera reserve, el propio miembro (o líder) pide una entrevista
// proponiendo fecha, hora y un motivo opcional, eligiendo la organización
// que le corresponde según el Manual General (ver interviewEligibility en
// db.js). La solicitud le llega a CUALQUIERA de los líderes de esa
// organización (el presidente o cualquiera de sus consejeros) — o siempre al
// Obispado, que puede decidir cualquier solicitud — quien la confirma
// (pudiendo ajustar la fecha/hora propuesta) o la rechaza con un comentario.
// Al confirmarla se crea la entrevista real en `interviews`, igual que
// siempre.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isObispadoLeader(user, data) {
  if (user.role === 'admin') return true;
  if (user.role !== 'leader') return false;
  const org = data.organizations.find((o) => o.id === Number(user.organizationId));
  return !!org && org.name === 'Obispado';
}

// Quién puede confirmar/rechazar una solicitud de esta organización: el
// Administrador, cualquier líder de esa misma organización (el presidente o
// sus consejeros — no hay un "responsable único"), o cualquier líder de
// Obispado (que puede decidir la de cualquier organización).
function canDecideFor(user, data, organizationId) {
  if (user.role === 'admin') return true;
  if (user.role !== 'leader') return false;
  if (Number(user.organizationId) === Number(organizationId)) return true;
  return isObispadoLeader(user, data);
}

function orgAllowsInterviews(data, organizationId) {
  const org = data.organizations.find((o) => o.id === Number(organizationId));
  return !!org && !!org.allowsInterviews;
}

function withRequestInfo(reqItem, data) {
  const org = data.organizations.find((o) => o.id === Number(reqItem.organizationId));
  const decidedByUser = reqItem.decidedBy ? data.users.find((u) => u.id === Number(reqItem.decidedBy)) : null;
  return {
    ...reqItem,
    organizationName: org?.name || '',
    organizationColor: org?.color || '#999999',
    decidedByName: decidedByUser ? decidedByUser.name : null,
  };
}

function withInterviewOrgInfo(interview, data) {
  const org = data.organizations.find((o) => o.id === Number(interview.organizationId));
  return { ...interview, organizationName: org?.name || '', organizationColor: org?.color || '#999999' };
}

export function registerInterviewRequestRoutes(router) {
  // Organizaciones con las que ESTE usuario puede pedir una entrevista, según
  // el Manual General — junto con los nombres de sus líderes actuales, para
  // que quede claro a quién le va a llegar la solicitud ("el presidente o
  // cualquiera de sus consejeros"). Si el perfil todavía está incompleto
  // (falta fecha de nacimiento o sexo), solo se puede pedir con el Obispado
  // (sin restricción), y se avisa con profileIncomplete.
  router.get('/api/interview-requests/orgs', requireAuth(async (req, res) => {
    const data = load();
    const orgs = data.organizations
      .filter((o) => o.allowsInterviews)
      .filter((o) => interviewEligibility(o.name, req.user) === true)
      .map((o) => {
        // El Secretario/Secretaria de la organización es un líder (edita
        // actividades, actas, etc.) pero no entrevista según el Manual
        // General — por eso queda fuera de a quién se le puede pedir una
        // entrevista, aunque siga siendo un líder normal en el resto de la
        // app. Si no tiene `calling` declarado (cuenta migrada, o una
        // organización sin esta distinción) igual se ofrece, para no perder
        // a nadie de la lista por un dato que todavía no se llenó.
        const interviewingLeaders = data.users.filter((u) => u.role === 'leader' && Number(u.organizationId) === o.id && u.calling !== 'Secretario');
        return {
          id: o.id,
          name: o.name,
          color: o.color,
          leaderNames: interviewingLeaders.map((u) => u.name),
          // Punto 4 (ampliación): además del nombre, cada líder trae su
          // agenda semanal declarada (si tiene) para que el cliente pueda
          // ofrecer "con quién" y, si eligió a alguien con disponibilidad
          // declarada, solo dejarlo proponer fechas dentro de esos
          // días/horas — excluyendo además las que ya están ocupadas por
          // una entrevista agendada (`busy`). Un líder sin ventanas
          // declaradas simplemente no restringe nada (se sigue pudiendo
          // pedir con fecha/hora libre, como antes de esta función).
          leaders: interviewingLeaders.map((u) => ({
            id: u.id,
            name: u.name,
            isPresident: !!u.isPresident,
            calling: u.calling || null,
            callingLabel: callingLabel(o.name, u.calling),
            availability: u.interviewAvailability || [],
            busy: busyRangesFor(data, o.id, u.name),
          })),
        };
      });
    sendJson(res, 200, { orgs, profileIncomplete: !req.user.birthDate || !req.user.sex });
  }));

  router.post('/api/interview-requests', requireAuth(async (req, res, params, body) => {
    const { organizationId, date, startTime, endTime, note, targetLeaderUserId } = body || {};
    if (!organizationId || !date || !startTime) {
      return sendJson(res, 400, { error: 'Faltan campos requeridos (organización, día, horario)' });
    }
    if (!DATE_RE.test(String(date))) return sendJson(res, 400, { error: 'Fecha inválida' });
    const data0 = load();
    if (!orgAllowsInterviews(data0, organizationId)) {
      return sendJson(res, 400, { error: 'Esta organización no agenda entrevistas' });
    }
    const org = data0.organizations.find((o) => o.id === Number(organizationId));
    const eligible = interviewEligibility(org?.name, req.user);
    if (eligible === null) {
      return sendJson(res, 400, { error: 'Completa tu fecha de nacimiento y sexo en "Mi Perfil" antes de solicitar una entrevista' });
    }
    if (eligible === false) {
      return sendJson(res, 403, { error: `Esta entrevista es de ${org?.name || 'esa organización'} y no corresponde con tu perfil — revisa "Mi Perfil" o solicita con el Obispado` });
    }
    // Punto 4 (ampliación): si el miembro eligió un líder específico (p.ej.
    // "presidente del quórum"), validamos que sea de esa organización y — si
    // ese líder declaró una agenda semanal — que la fecha/hora propuesta caiga
    // dentro de alguno de sus días/horas disponibles. Un líder sin agenda
    // declarada no restringe nada (fecha/hora libre, como antes).
    let targetLeader = null;
    if (targetLeaderUserId) {
      targetLeader = data0.users.find((u) => u.id === Number(targetLeaderUserId) && u.role === 'leader'
        && Number(u.organizationId) === Number(organizationId));
      if (!targetLeader) return sendJson(res, 400, { error: 'Líder inválido para esa organización' });
      if ((targetLeader.interviewAvailability || []).length > 0
        && !interviewAvailabilityMatches(targetLeader.interviewAvailability, date, startTime)) {
        return sendJson(res, 400, { error: `${targetLeader.name} no atiende entrevistas ese día/horario — elige uno de sus horarios disponibles` });
      }
      if (hasSchedulingConflict(data0, organizationId, targetLeader.name, date, startTime, endTime)) {
        return sendJson(res, 400, { error: `${targetLeader.name} ya tiene una entrevista agendada ese horario — elige otro` });
      }
    }
    const now = new Date().toISOString();
    const reqItem = await withDb((d) => {
      const r = {
        id: nextId(d, 'interviewRequests'),
        memberUserId: req.user.id,
        memberName: req.user.name,
        organizationId: Number(organizationId),
        targetLeaderUserId: targetLeader ? targetLeader.id : null,
        targetLeaderName: targetLeader ? targetLeader.name : null,
        date,
        startTime,
        endTime: endTime || null,
        note: String(note || '').trim(),
        status: 'pending',
        createdAt: now,
        decidedBy: null,
        decidedAt: null,
        decisionComment: '',
        resultingInterviewId: null,
      };
      d.interviewRequests.push(r);
      return r;
    });
    const data = load();
    sendJson(res, 201, withRequestInfo(reqItem, data));
  }));

  // mine=1: mis propias solicitudes (cualquier rol), para hacerles
  // seguimiento en "Mis Actividades". Sin ese parámetro: la bandeja de un
  // líder/admin para decidir — su propia organización, o todas si es líder
  // de Obispado o Administrador.
  router.get('/api/interview-requests', requireAuth(async (req, res) => {
    const data = load();
    if (req.query.mine === '1') {
      const items = data.interviewRequests
        .filter((r) => Number(r.memberUserId) === Number(req.user.id))
        .map((r) => withRequestInfo(r, data))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return sendJson(res, 200, items);
    }
    if (req.user.role === 'member') return sendJson(res, 200, []);
    let items = isObispadoLeader(req.user, data)
      ? data.interviewRequests
      : data.interviewRequests.filter((r) => Number(r.organizationId) === Number(req.user.organizationId));
    if (req.query.status) items = items.filter((r) => r.status === req.query.status);
    items = items.map((r) => withRequestInfo(r, data)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    sendJson(res, 200, items);
  }));

  router.put('/api/interview-requests/:id/confirm', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    const reqItem = data0.interviewRequests.find((r) => r.id === id);
    if (!reqItem) return sendJson(res, 404, { error: 'Solicitud no encontrada' });
    if (!canDecideFor(req.user, data0, reqItem.organizationId)) {
      return sendJson(res, 403, { error: 'No tienes permiso para confirmar esta solicitud' });
    }
    if (reqItem.status !== 'pending') return sendJson(res, 400, { error: 'Esta solicitud ya fue decidida' });
    const date = body?.date || reqItem.date;
    const startTime = body?.startTime || reqItem.startTime;
    if (!DATE_RE.test(String(date))) return sendJson(res, 400, { error: 'Fecha inválida' });
    const endTime = body?.endTime !== undefined ? (body.endTime || null) : reqItem.endTime;
    const location = body?.location || '';
    const sala = ['Casa Capilla', 'Capilla'].includes(location) ? (body?.sala || '') : '';
    const now = new Date().toISOString();
    const interview = await withDb((d) => {
      const r = d.interviewRequests.find((x) => x.id === id);
      const newId = nextId(d, 'interviews');
      const iv = {
        id: newId,
        // una solicitud siempre es de UNA sola persona (quien la pidió) —
        // "groupId" queda igual a su propio id, como cualquier entrevista de
        // una sola persona (ver groupInterviews() en interviews.js). Si hace
        // falta sumar a alguien más (por ejemplo, su cónyuge), el líder puede
        // editarla después desde Entrevistas y agregar otra persona al grupo.
        groupId: newId,
        memberName: r.memberName,
        memberUserId: r.memberUserId,
        memberPhone: '',
        memberEmail: '',
        description: r.note || '',
        location,
        sala,
        interviewerName: body?.interviewerName || r.targetLeaderName || '',
        interviewerEmail: body?.interviewerEmail || '',
        interviewerPhone: body?.interviewerPhone || '',
        date,
        startTime,
        endTime,
        organizationId: r.organizationId,
        scheduledBy: req.user.id,
        reminderSent: false,
        status: 'scheduled',
        comment: '',
        markedAt: null,
        markedBy: null,
        createdAt: now,
        updatedAt: now,
      };
      d.interviews.push(iv);
      Object.assign(r, { status: 'confirmed', decidedBy: req.user.id, decidedAt: now, resultingInterviewId: iv.id });
      return iv;
    });
    const data = load();
    sendJson(res, 201, {
      interview: withInterviewOrgInfo(interview, data),
      request: withRequestInfo(data.interviewRequests.find((r) => r.id === id), data),
    });
  }));

  router.put('/api/interview-requests/:id/reject', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    const reqItem = data0.interviewRequests.find((r) => r.id === id);
    if (!reqItem) return sendJson(res, 404, { error: 'Solicitud no encontrada' });
    if (!canDecideFor(req.user, data0, reqItem.organizationId)) {
      return sendJson(res, 403, { error: 'No tienes permiso para rechazar esta solicitud' });
    }
    if (reqItem.status !== 'pending') return sendJson(res, 400, { error: 'Esta solicitud ya fue decidida' });
    const now = new Date().toISOString();
    await withDb((d) => {
      const r = d.interviewRequests.find((x) => x.id === id);
      Object.assign(r, { status: 'rejected', decidedBy: req.user.id, decidedAt: now, decisionComment: String(body?.comment || '').trim() });
    });
    const data = load();
    sendJson(res, 200, withRequestInfo(data.interviewRequests.find((r) => r.id === id), data));
  }));

  // Retirar una solicitud propia mientras siga pendiente (ej. si se
  // equivocó en la fecha), o descartarla ya decidida — quien la pidió, o un
  // líder/admin con permiso sobre esa organización.
  router.delete('/api/interview-requests/:id', requireAuth(async (req, res, params) => {
    const id = Number(params.id);
    const data0 = load();
    const reqItem = data0.interviewRequests.find((r) => r.id === id);
    if (!reqItem) return sendJson(res, 404, { error: 'Solicitud no encontrada' });
    const isOwner = Number(reqItem.memberUserId) === Number(req.user.id);
    if (!isOwner && !canDecideFor(req.user, data0, reqItem.organizationId)) {
      return sendJson(res, 403, { error: 'No tienes permiso para eliminar esta solicitud' });
    }
    if (isOwner && !canDecideFor(req.user, data0, reqItem.organizationId) && reqItem.status !== 'pending') {
      return sendJson(res, 400, { error: 'Solo se puede retirar una solicitud todavía pendiente' });
    }
    await withDb((d) => { d.interviewRequests = d.interviewRequests.filter((r) => r.id !== id); });
    sendJson(res, 200, { ok: true });
  }));
}
