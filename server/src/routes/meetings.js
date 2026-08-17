import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireAuth, requireRole } from '../guard.js';
import { isObispadoLeader } from './stake.js';

// Módulo "Reuniones y Consejos": un acta (reunión) agrupa uno o más
// "compromisos" (tareas con responsable y fecha límite). El compromiso vive
// anidado dentro de su acta, pero se le da un id GLOBAL (nextId
// 'commitments') para poder ubicarlo directo por id sin tener que mandar
// también el id del acta — así "Mis Asignaciones" y "Completar" quedan más
// simples del lado del cliente.

const todayISO = () => new Date().toISOString().slice(0, 10);

// Reutilizado por achievements.js para el ranking "Más actas de reunión
// registradas" de Rachas y Logros: quién ha creado más actas, agrupado por
// quién la creó (createdBy) y contado por la fecha propia del acta. `range`
// es opcional ({start, end} ISO, ambas inclusive); sin rango, es el total
// histórico.
export function allMeetingCreatorsWithStats(data, range) {
  const inRange = (date) => !range || (date >= range.start && date <= range.end);
  const byUser = new Map();
  for (const m of data.meetings) {
    if (!m.createdBy || !inRange(m.date)) continue;
    if (!byUser.has(m.createdBy)) byUser.set(m.createdBy, []);
    byUser.get(m.createdBy).push(m);
  }
  return [...byUser.entries()].map(([userId, items]) => {
    const user = data.users.find((u) => u.id === Number(userId));
    return {
      userId: Number(userId),
      userName: user?.name || '(usuario eliminado)',
      count: items.length,
      lastDate: items.map((m) => m.date).sort().slice(-1)[0],
    };
  }).sort((a, b) => b.count - a.count);
}

// A quién puede asignársele un compromiso, según quién esté armando el
// acta: el líder de Obispado (o el Administrador) puede repartir
// compromisos entre CUALQUIER líder del barrio (o el propio Administrador);
// un líder común solo puede asignar a líderes de su misma organización (en
// la práctica, generalmente a sí mismo, salvo que existan varios líderes en
// esa organización).
export function assignableUsersFor(user, data) {
  const privileged = isObispadoLeader(user, data);
  const pool = privileged
    ? data.users.filter((u) => u.role === 'leader' || u.role === 'admin')
    : data.users.filter((u) => u.role === 'leader' && Number(u.organizationId) === Number(user.organizationId));
  return pool
    .map((u) => ({ id: u.id, name: u.name, role: u.role, organizationId: u.organizationId }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

function findMeetingWithCommitment(data, commitmentId) {
  for (const m of data.meetings) {
    const c = (m.commitments || []).find((x) => x.id === commitmentId);
    if (c) return { meeting: m, commitment: c };
  }
  return null;
}

function userName(data, id) {
  return data.users.find((u) => u.id === Number(id))?.name || '(usuario eliminado)';
}

function withCommitmentInfo(c, data) {
  const isOverdue = c.status === 'pending' && !!c.dueDate && c.dueDate < todayISO();
  return {
    ...c,
    assignedToName: userName(data, c.assignedToUserId),
    isOverdue,
    displayStatus: c.status === 'pending' ? (isOverdue ? 'overdue' : 'pending') : c.status,
  };
}

function withMeetingInfo(m, data) {
  const org = data.organizations.find((o) => o.id === Number(m.organizationId));
  return {
    ...m,
    organizationName: org?.name || (m.organizationId ? '' : 'Administración'),
    createdByName: userName(data, m.createdBy),
    commitments: (m.commitments || []).map((c) => withCommitmentInfo(c, data)),
  };
}

// Puede editar el acta (agregar compromisos, archivar): quien la creó, o un
// Administrador — igual que el resto de módulos del barrio, un
// Administrador siempre puede intervenir.
function canEditMeeting(user, meeting) {
  return user.role === 'admin' || Number(user.id) === Number(meeting.createdBy);
}

// Visibilidad de las actas: por ahora, cada organización ve solo las
// suyas — igual que en Entrevistas — salvo el líder de Obispado (o el
// Administrador), que sí ve las actas de todas las organizaciones, para
// tener panorama completo desde el Obispado. Esto no afecta "Mis
// Asignaciones": los compromisos que te asignaron siguen apareciendo ahí
// sin importar de qué organización sea el acta que los generó.
// Exportada (con este nombre, distinto del canSeeMeeting de events.js que
// resuelve otra cosa: si una REUNIÓN PRIVADA del calendario es visible) para
// que search.js reutilice la misma regla de privacidad de las actas.
export function canSeeMeetingRecord(user, meeting, data) {
  if (isObispadoLeader(user, data)) return true;
  return Number(meeting.organizationId) === Number(user.organizationId);
}

function validCommitmentInput(raw, assignableIds) {
  const description = String(raw?.description || '').trim();
  const dueDate = String(raw?.dueDate || '').trim();
  const assignedToUserId = Number(raw?.assignedToUserId);
  if (!description) return { error: 'Falta la descripción del compromiso' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return { error: 'Falta la fecha límite / de verificación del compromiso' };
  if (!Number.isFinite(assignedToUserId) || !assignableIds.has(assignedToUserId)) {
    return { error: 'El responsable elegido no es válido para quien está creando el acta' };
  }
  return { value: { description, dueDate, assignedToUserId } };
}

export function registerMeetingRoutes(router) {
  // Quién puede asignarse un compromiso al armar (o completar) un acta —
  // depende de si quien pregunta es líder de Obispado/Administrador o un
  // líder común. El cliente arma el selector "Responsable" con esta lista.
  router.get('/api/meetings/assignable-users', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    sendJson(res, 200, assignableUsersFor(req.user, data));
  }));

  // Listado de actas — cada organización ve las suyas (como el libro de
  // actas propio); el líder de Obispado y el Administrador ven las de
  // todas las organizaciones. Igual que en Entrevistas, es el servidor el
  // que aplica el filtro, no algo solo visual. Quien la ve puede no poder
  // editarla — eso lo decide canEditMeeting (solo quien la creó, o Admin).
  router.get('/api/meetings', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    const status = req.query.status;
    let items = isObispadoLeader(req.user, data)
      ? data.meetings
      : data.meetings.filter((m) => Number(m.organizationId) === Number(req.user.organizationId));
    if (status === 'active' || status === 'archived') items = items.filter((m) => m.status === status);
    items = items.map((m) => withMeetingInfo(m, data)).sort((a, b) => (b.date + String(b.id)).localeCompare(a.date + String(a.id)));
    sendJson(res, 200, items);
  }));

  router.get('/api/meetings/:id', requireRole(['admin', 'leader'], async (req, res, params) => {
    const id = Number(params.id);
    const data = load();
    const meeting = data.meetings.find((m) => m.id === id);
    if (!meeting) return sendJson(res, 404, { error: 'Acta no encontrada' });
    if (!canSeeMeetingRecord(req.user, meeting, data)) {
      return sendJson(res, 403, { error: 'No puedes ver las actas de otra organización' });
    }
    sendJson(res, 200, withMeetingInfo(meeting, data));
  }));

  // Crea el acta y, opcionalmente, sus primeros compromisos "al vuelo" (se
  // pueden seguir agregando después mientras el acta esté activa).
  router.post('/api/meetings', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const title = String(body?.title || '').trim();
    const date = String(body?.date || '').trim();
    if (!title) return sendJson(res, 400, { error: 'Falta el título del acta (ej: Consejo de Barrio)' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Falta la fecha de la reunión' });

    const data0 = load();
    const assignableIds = new Set(assignableUsersFor(req.user, data0).map((u) => u.id));
    const rawCommitments = Array.isArray(body?.commitments) ? body.commitments : [];
    const commitmentsInput = [];
    for (const raw of rawCommitments) {
      const check = validCommitmentInput(raw, assignableIds);
      if (check.error) return sendJson(res, 400, { error: check.error });
      commitmentsInput.push(check.value);
    }

    const now = new Date().toISOString();
    const meeting = await withDb((data) => {
      const commitments = commitmentsInput.map((c) => ({
        id: nextId(data, 'commitments'),
        ...c,
        status: 'pending',
        completedAt: null,
        completionComment: '',
      }));
      const m = {
        id: nextId(data, 'meetings'),
        title,
        date,
        organizationId: req.user.organizationId || null,
        status: 'active',
        createdBy: req.user.id,
        createdAt: now,
        archivedAt: null,
        commitments,
      };
      data.meetings.push(m);
      return m;
    });
    const data = load();
    sendJson(res, 201, withMeetingInfo(data.meetings.find((m) => m.id === meeting.id), data));
  }));

  // Agrega un compromiso más a un acta ya creada, mientras siga activa.
  router.post('/api/meetings/:id/commitments', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    const meeting = data0.meetings.find((m) => m.id === id);
    if (!meeting) return sendJson(res, 404, { error: 'Acta no encontrada' });
    if (!canEditMeeting(req.user, meeting)) return sendJson(res, 403, { error: 'Solo quien creó el acta (o un Administrador) puede agregar compromisos' });
    if (meeting.status !== 'active') return sendJson(res, 400, { error: 'Esta acta ya está archivada — no se le pueden agregar más compromisos' });
    const assignableIds = new Set(assignableUsersFor(req.user, data0).map((u) => u.id));
    const check = validCommitmentInput(body, assignableIds);
    if (check.error) return sendJson(res, 400, { error: check.error });

    await withDb((data) => {
      const m = data.meetings.find((x) => x.id === id);
      m.commitments.push({ id: nextId(data, 'commitments'), ...check.value, status: 'pending', completedAt: null, completionComment: '' });
    });
    const data = load();
    sendJson(res, 201, withMeetingInfo(data.meetings.find((m) => m.id === id), data));
  }));

  // El responsable marca su propio compromiso como completado, dejando un
  // comentario breve — no lo puede completar otra persona en su nombre
  // (ni siquiera quien armó el acta), para que el comentario sea confiable.
  router.put('/api/commitments/:id/complete', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    const found = findMeetingWithCommitment(data0, id);
    if (!found) return sendJson(res, 404, { error: 'Compromiso no encontrado' });
    if (Number(found.commitment.assignedToUserId) !== Number(req.user.id)) {
      return sendJson(res, 403, { error: 'Solo la persona responsable puede marcar este compromiso como completado' });
    }
    if (found.meeting.status !== 'active') {
      return sendJson(res, 400, { error: 'El acta de este compromiso ya fue archivada' });
    }
    if (found.commitment.status === 'completed') {
      return sendJson(res, 400, { error: 'Este compromiso ya estaba marcado como completado' });
    }
    const comment = String(body?.comment || '').trim();
    await withDb((data) => {
      const f = findMeetingWithCommitment(data, id);
      Object.assign(f.commitment, { status: 'completed', completedAt: new Date().toISOString(), completionComment: comment });
    });
    const data = load();
    const f2 = findMeetingWithCommitment(data, id);
    sendJson(res, 200, withCommitmentInfo(f2.commitment, data));
  }));

  // "Verificar y Archivar": cierra el acta. Cualquier compromiso que haya
  // quedado pendiente pasa a "no cumplida" — desaparece de "Mis
  // Asignaciones" de quien lo tenía (que ya solo pide compromisos con
  // status 'pending') y queda documentado en el acta histórica.
  router.put('/api/meetings/:id/archive', requireRole(['admin', 'leader'], async (req, res, params) => {
    const id = Number(params.id);
    const data0 = load();
    const meeting = data0.meetings.find((m) => m.id === id);
    if (!meeting) return sendJson(res, 404, { error: 'Acta no encontrada' });
    if (!canEditMeeting(req.user, meeting)) return sendJson(res, 403, { error: 'Solo quien creó el acta (o un Administrador) puede archivarla' });
    if (meeting.status === 'archived') return sendJson(res, 400, { error: 'Esta acta ya estaba archivada' });
    await withDb((data) => {
      const m = data.meetings.find((x) => x.id === id);
      m.status = 'archived';
      m.archivedAt = new Date().toISOString();
      m.commitments.forEach((c) => { if (c.status === 'pending') c.status = 'not_fulfilled'; });
    });
    const data = load();
    sendJson(res, 200, withMeetingInfo(data.meetings.find((m) => m.id === id), data));
  }));

  // Panel personal "Mis Asignaciones": solo los compromisos que siguen
  // pendientes (los completados ya no hace falta revisarlos, y los que
  // quedaron "no cumplida" al archivar el acta ya no son accionables).
  router.get('/api/my-assignments', requireAuth(async (req, res) => {
    const data = load();
    const mine = [];
    for (const m of data.meetings) {
      for (const c of (m.commitments || [])) {
        if (Number(c.assignedToUserId) !== Number(req.user.id)) continue;
        if (c.status !== 'pending') continue;
        mine.push({ ...withCommitmentInfo(c, data), meetingId: m.id, meetingTitle: m.title });
      }
    }
    mine.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const pendingCount = mine.filter((c) => c.displayStatus === 'pending').length;
    const overdueCount = mine.filter((c) => c.displayStatus === 'overdue').length;
    sendJson(res, 200, { commitments: mine, pendingCount, overdueCount, total: mine.length });
  }));
}
