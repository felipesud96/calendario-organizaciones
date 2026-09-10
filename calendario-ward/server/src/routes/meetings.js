import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireAuth, requireRole } from '../guard.js';
import { isObispadoLeader } from './stake.js';

// Punto 7 y 8: además del acta genérica, un acta puede marcarse de un tipo
// especial — "Consejo de Barrio" (para el aviso de frecuencia del Punto 10)
// o "Coordinación de Ministración" (la reunión trimestral del Punto 8) —
// reservados a quien preside esas reuniones (el Obispado). Un líder común
// solo puede crear actas de tipo "general" (ej. presidencia de su propia
// organización).
export const MEETING_TYPES = ['general', 'consejo_barrio', 'coordinacion_ministracion'];
const OBISPADO_ONLY_TYPES = ['consejo_barrio', 'coordinacion_ministracion'];

// Fecha del acta más reciente de un tipo dado (cualquier estado, activa o
// archivada — lo que importa es que la reunión haya ocurrido) — reutilizado
// por dashboard.js para los avisos de "Consejo de Barrio atrasado" y
// "Coordinación de Ministración pendiente este trimestre".
export function lastMeetingDateOfType(data, type) {
  const dates = data.meetings.filter((m) => m.type === type).map((m) => m.date).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

// Punto 18 (idea de UX basada en el Manual General): el acta del consejo
// inmediatamente ANTERIOR a una fecha dada, del mismo tipo — usado por
// reminders.js para avisar, unos días antes de la próxima reunión ya
// agendada como agenda (ver Punto 7 más abajo), qué compromisos de la
// reunión pasada siguen sin resolverse.
export function previousMeetingOfType(data, type, beforeDate) {
  const candidates = data.meetings.filter((m) => m.type === type && m.date < beforeDate);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.date.localeCompare(a.date))[0];
}

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
// Los tres llamamientos de apoyo al Obispado (Punto 28/29/30) también
// pueden recibir un compromiso directo desde un acta (ej. "el Secretario de
// Barrio actualiza el directorio") — no son "líder", pero sí asisten a las
// reuniones del Obispado y son una mayordomía válida a la que asignar algo.
const STAFF_ROLES = ['executive_secretary', 'ward_clerk', 'financial_clerk'];

export function assignableUsersFor(user, data) {
  // El Secretario de Barrio arma las actas de Consejo de Barrio, donde
  // participan TODAS las organizaciones (no solo Obispado) — así que, igual
  // que un líder de Obispado, debe poder repartir compromisos entre
  // cualquier presidencia del Barrio, no solo entre el propio Obispado.
  const privileged = isObispadoLeader(user, data) || user.role === 'ward_clerk';
  const pool = privileged
    ? data.users.filter((u) => u.role === 'leader' || u.role === 'admin' || STAFF_ROLES.includes(u.role))
    : data.users.filter((u) => u.role === 'leader' && Number(u.organizationId) === Number(user.organizationId));
  return pool
    .map((u) => ({ id: u.id, name: u.name, role: u.role, organizationId: u.organizationId }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

// Exportada para que welfare.js pueda ubicar y completar el compromiso de
// evaluación mensual de un caso de Bienestar por su id global, con el mismo
// mecanismo que ya usa este archivo para /api/commitments/:id/complete —
// sin duplicar la búsqueda.
export function findMeetingWithCommitment(data, commitmentId) {
  for (const m of data.meetings) {
    const c = (m.commitments || []).find((x) => x.id === commitmentId);
    if (c) return { meeting: m, commitment: c };
  }
  return null;
}

function userName(data, id) {
  return data.users.find((u) => u.id === Number(id))?.name || '(usuario eliminado)';
}

// Punto 9: un acta completa marcada confidencial, o un compromiso puntual
// marcado confidencial, oculta su contenido a cualquiera que no sea el
// Obispado/Administrador, quien creó el acta, o (solo para el compromiso)
// la persona responsable — igual que el manual pide para asuntos de
// confidencialidad de consejo (4.4.6) y de entrevistas (31.3).
export function canSeeMeetingFullContent(user, meeting, data) {
  if (!meeting.confidential) return true;
  if (isObispadoLeader(user, data)) return true;
  return Number(user.id) === Number(meeting.createdBy);
}

function commitmentVisibleFully(user, meeting, commitment, data) {
  if (isObispadoLeader(user, data)) return true;
  if (Number(user.id) === Number(meeting.createdBy)) return true;
  if (Number(user.id) === Number(commitment.assignedToUserId)) return true;
  return !meeting.confidential && !commitment.confidential;
}

function withCommitmentInfo(c, data, meeting, viewer) {
  const isOverdue = c.status === 'pending' && !!c.dueDate && c.dueDate < todayISO();
  const visible = !viewer || !meeting || commitmentVisibleFully(viewer, meeting, c, data);
  return {
    ...c,
    description: visible ? c.description : '(Compromiso confidencial)',
    completionComment: visible ? c.completionComment : '',
    assignedToName: userName(data, c.assignedToUserId),
    isOverdue,
    displayStatus: c.status === 'pending' ? (isOverdue ? 'overdue' : 'pending') : c.status,
    redacted: !visible,
  };
}

function withMeetingInfo(m, data, viewer) {
  const org = data.organizations.find((o) => o.id === Number(m.organizationId));
  const fullAccess = !viewer || canSeeMeetingFullContent(viewer, m, data);
  return {
    ...m,
    organizationName: org?.name || (m.organizationId ? '' : 'Administración'),
    createdByName: userName(data, m.createdBy),
    agendaItems: (m.agendaItems || []).map((a) => (fullAccess ? a : { id: a.id, topic: '(Tema confidencial)', presenter: '', ...EMPTY_AGENDA_ITEM_NOTES })),
    commitments: (m.commitments || []).map((c) => withCommitmentInfo(c, data, m, viewer)),
    contentRedacted: !fullAccess,
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

// Punto 16 (idea de UX basada en el Manual General): un tema de agenda de
// Consejo de Barrio no se completa con una sola nota libre — sigue el
// patrón de consejo del Manual (18.2 y 4.3): necesidad detectada → análisis
// → acuerdo tomado → seguimiento asignado. `notes` se mantiene para actas
// de tipo "general" que no siguen ningún patrón especial.
//
// Punto 64: Coordinación de Ministración NO usa el mismo patrón de 4 campos
// que Consejo de Barrio — es una reunión más operativa (Manual General
// 21.2), así que sigue su propio patrón de 3 campos: ¿quién necesita
// ayuda? → ¿qué se hará? → ¿quién lo hará?. Todos los campos (de ambos
// patrones) viven en el mismo objeto — el servidor los acepta y los guarda
// sin distinguir por tipo de acta; es el CLIENTE el que decide, según
// `meeting.type`, cuál subconjunto mostrar/editar (ver isCouncilMeetingType
// / meetingAgendaFields en app.js). Todos empiezan vacíos y solo se
// completan después (PUT), nunca al crear el tema.
const EMPTY_AGENDA_ITEM_NOTES = {
  notes: '', necesidad: '', analisis: '', acuerdo: '', seguimiento: '',
  quienNecesita: '', queSeHara: '', quienLoHara: '',
};

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
  router.get('/api/meetings/assignable-users', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res) => {
    const data = load();
    sendJson(res, 200, assignableUsersFor(req.user, data));
  }));

  // Punto 18 (auto-generador de agenda): a diferencia del recordatorio por
  // correo de checkCouncilPrepReminders (reminders.js), que solo AVISA que
  // quedaron compromisos pendientes del consejo anterior, esto deja armar
  // la agenda del acta NUEVA con esos mismos compromisos como temas de
  // seguimiento concretos, ni bien se elige el tipo en "Nueva acta" — mismo
  // criterio de "pendiente" (pending o not_fulfilled) que ya usa ese
  // recordatorio, para que nunca se vean distintos. Mismo público que ese
  // recordatorio (Obispado o Secretario de Barrio, sin filtrar por
  // confidencialidad) — ya es el precedente de este mismo archivo.
  router.get('/api/meetings/pending-from-previous', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res) => {
    const data = load();
    const type = req.query.type;
    if (!MEETING_TYPES.includes(type)) return sendJson(res, 400, { error: 'Tipo de acta inválido' });
    if (OBISPADO_ONLY_TYPES.includes(type) && !isObispadoLeader(req.user, data) && req.user.role !== 'ward_clerk') {
      return sendJson(res, 403, { error: 'Solo el Obispado (o el Secretario de Barrio) puede ver esto para Consejo de Barrio o Coordinación de Ministración' });
    }
    const beforeDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayISO();
    const previous = previousMeetingOfType(data, type, beforeDate);
    if (!previous) return sendJson(res, 200, { previousMeeting: null, pending: [] });
    const pending = (previous.commitments || [])
      .filter((c) => c.status === 'pending' || c.status === 'not_fulfilled')
      .map((c) => ({
        id: c.id,
        description: c.description,
        dueDate: c.dueDate,
        status: c.status,
        assignedToName: userName(data, c.assignedToUserId),
      }));
    sendJson(res, 200, { previousMeeting: { id: previous.id, title: previous.title, date: previous.date }, pending });
  }));

  // Listado de actas — cada organización ve las suyas (como el libro de
  // actas propio); el líder de Obispado y el Administrador ven las de
  // todas las organizaciones. Igual que en Entrevistas, es el servidor el
  // que aplica el filtro, no algo solo visual. Quien la ve puede no poder
  // editarla — eso lo decide canEditMeeting (solo quien la creó, o Admin).
  router.get('/api/meetings', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res) => {
    const data = load();
    const status = req.query.status;
    let items = isObispadoLeader(req.user, data)
      ? data.meetings
      : data.meetings.filter((m) => Number(m.organizationId) === Number(req.user.organizationId));
    if (status === 'active' || status === 'archived') items = items.filter((m) => m.status === status);
    items = items.map((m) => withMeetingInfo(m, data, req.user)).sort((a, b) => (b.date + String(b.id)).localeCompare(a.date + String(a.id)));
    sendJson(res, 200, items);
  }));

  router.get('/api/meetings/:id', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res, params) => {
    const id = Number(params.id);
    const data = load();
    const meeting = data.meetings.find((m) => m.id === id);
    if (!meeting) return sendJson(res, 404, { error: 'Acta no encontrada' });
    if (!canSeeMeetingRecord(req.user, meeting, data)) {
      return sendJson(res, 403, { error: 'No puedes ver las actas de otra organización' });
    }
    sendJson(res, 200, withMeetingInfo(meeting, data, req.user));
  }));

  // Crea el acta — puede nacer solo como AGENDA (Punto 7: temas a tratar y
  // quién los presenta, antes de que la reunión ocurra) y, opcionalmente,
  // sus primeros compromisos "al vuelo" (se pueden seguir agregando después
  // mientras el acta esté activa, igual que antes).
  router.post('/api/meetings', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res, params, body) => {
    const title = String(body?.title || '').trim();
    const date = String(body?.date || '').trim();
    if (!title) return sendJson(res, 400, { error: 'Falta el título del acta (ej: Consejo de Barrio)' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Falta la fecha de la reunión' });

    const data0 = load();
    const requestedType = MEETING_TYPES.includes(body?.type) ? body.type : 'general';
    // Punto 29: el Secretario de Barrio SÍ puede registrar estos dos tipos —
    // es justamente su mayordomía — aunque no sea él mismo un líder de
    // Obispado.
    if (OBISPADO_ONLY_TYPES.includes(requestedType) && !isObispadoLeader(req.user, data0) && req.user.role !== 'ward_clerk') {
      return sendJson(res, 403, { error: 'Solo el Obispado (o el Secretario de Barrio) puede registrar un Consejo de Barrio o una Coordinación de Ministración' });
    }
    const assignableIds = new Set(assignableUsersFor(req.user, data0).map((u) => u.id));
    const rawCommitments = Array.isArray(body?.commitments) ? body.commitments : [];
    const commitmentsInput = [];
    for (const raw of rawCommitments) {
      const check = validCommitmentInput(raw, assignableIds);
      if (check.error) return sendJson(res, 400, { error: check.error });
      commitmentsInput.push(check.value);
    }
    const rawAgendaItems = Array.isArray(body?.agendaItems) ? body.agendaItems : [];
    const agendaItemsInput = [];
    for (const raw of rawAgendaItems) {
      const topic = String(raw?.topic || '').trim();
      if (!topic) return sendJson(res, 400, { error: 'Cada tema de la agenda necesita un título' });
      agendaItemsInput.push({ topic, presenter: String(raw?.presenter || '').trim(), ...EMPTY_AGENDA_ITEM_NOTES });
    }

    const now = new Date().toISOString();
    const meeting = await withDb((data) => {
      const commitments = commitmentsInput.map((c) => ({
        id: nextId(data, 'commitments'),
        ...c,
        confidential: false,
        status: 'pending',
        completedAt: null,
        completionComment: '',
        whatsappDueTodaySent: false,
      }));
      const agendaItems = agendaItemsInput.map((a) => ({ id: nextId(data, 'agendaItems'), ...a }));
      const m = {
        id: nextId(data, 'meetings'),
        title,
        date,
        type: requestedType,
        confidential: !!body?.confidential,
        organizationId: req.user.organizationId || null,
        status: 'active',
        createdBy: req.user.id,
        createdAt: now,
        archivedAt: null,
        agendaItems,
        commitments,
        // Punto 18: para no reenviar el mismo recordatorio de compromisos
        // pendientes en cada ciclo de 15 minutos de reminders.js.
        councilPrepReminderSent: false,
      };
      data.meetings.push(m);
      return m;
    });
    const data = load();
    sendJson(res, 201, withMeetingInfo(data.meetings.find((m) => m.id === meeting.id), data, req.user));
  }));

  // Agrega un compromiso más a un acta ya creada, mientras siga activa.
  router.post('/api/meetings/:id/commitments', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res, params, body) => {
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
      m.commitments.push({ id: nextId(data, 'commitments'), ...check.value, confidential: !!body?.confidential, status: 'pending', completedAt: null, completionComment: '', whatsappDueTodaySent: false });
    });
    const data = load();
    sendJson(res, 201, withMeetingInfo(data.meetings.find((m) => m.id === id), data, req.user));
  }));

  // Punto 7 — agenda previa: agregar un tema más (antes o durante la
  // reunión), y luego completar sus notas/decisión una vez tratado. Mismo
  // permiso que agregar compromisos: quien creó el acta, o Administrador.
  router.post('/api/meetings/:id/agenda-items', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    const meeting = data0.meetings.find((m) => m.id === id);
    if (!meeting) return sendJson(res, 404, { error: 'Acta no encontrada' });
    if (!canEditMeeting(req.user, meeting)) return sendJson(res, 403, { error: 'Solo quien creó el acta (o un Administrador) puede editar la agenda' });
    if (meeting.status !== 'active') return sendJson(res, 400, { error: 'Esta acta ya está archivada' });
    const topic = String(body?.topic || '').trim();
    if (!topic) return sendJson(res, 400, { error: 'Falta el título del tema' });
    await withDb((data) => {
      const m = data.meetings.find((x) => x.id === id);
      m.agendaItems = m.agendaItems || [];
      m.agendaItems.push({ id: nextId(data, 'agendaItems'), topic, presenter: String(body?.presenter || '').trim(), ...EMPTY_AGENDA_ITEM_NOTES });
    });
    const data = load();
    sendJson(res, 201, withMeetingInfo(data.meetings.find((m) => m.id === id), data, req.user));
  }));

  // Completar (o editar) un tema de agenda con lo que se decidió — se usa
  // durante o después de la reunión, sobre la misma agenda armada antes.
  router.put('/api/meetings/:id/agenda-items/:itemId', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res, params, body) => {
    const id = Number(params.id);
    const itemId = Number(params.itemId);
    const data0 = load();
    const meeting = data0.meetings.find((m) => m.id === id);
    if (!meeting) return sendJson(res, 404, { error: 'Acta no encontrada' });
    if (!canEditMeeting(req.user, meeting)) return sendJson(res, 403, { error: 'Solo quien creó el acta (o un Administrador) puede editar la agenda' });
    const item = (meeting.agendaItems || []).find((a) => a.id === itemId);
    if (!item) return sendJson(res, 404, { error: 'Tema de agenda no encontrado' });
    await withDb((data) => {
      const m = data.meetings.find((x) => x.id === id);
      const it = m.agendaItems.find((a) => a.id === itemId);
      Object.assign(it, {
        topic: body?.topic !== undefined ? String(body.topic).trim() || it.topic : it.topic,
        presenter: body?.presenter !== undefined ? String(body.presenter).trim() : it.presenter,
        notes: body?.notes !== undefined ? String(body.notes).trim() : it.notes,
        // Punto 16: patrón de consejo del Manual General para Consejo de
        // Barrio / Coordinación de Ministración (necesidad → análisis →
        // acuerdo → seguimiento); igual que `notes`, se completan después.
        necesidad: body?.necesidad !== undefined ? String(body.necesidad).trim() : it.necesidad,
        analisis: body?.analisis !== undefined ? String(body.analisis).trim() : it.analisis,
        acuerdo: body?.acuerdo !== undefined ? String(body.acuerdo).trim() : it.acuerdo,
        seguimiento: body?.seguimiento !== undefined ? String(body.seguimiento).trim() : it.seguimiento,
        // Punto 64: patrón propio de Coordinación de Ministración.
        quienNecesita: body?.quienNecesita !== undefined ? String(body.quienNecesita).trim() : it.quienNecesita,
        queSeHara: body?.queSeHara !== undefined ? String(body.queSeHara).trim() : it.queSeHara,
        quienLoHara: body?.quienLoHara !== undefined ? String(body.quienLoHara).trim() : it.quienLoHara,
      });
    });
    const data = load();
    sendJson(res, 200, withMeetingInfo(data.meetings.find((m) => m.id === id), data, req.user));
  }));

  router.delete('/api/meetings/:id/agenda-items/:itemId', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res, params) => {
    const id = Number(params.id);
    const itemId = Number(params.itemId);
    const data0 = load();
    const meeting = data0.meetings.find((m) => m.id === id);
    if (!meeting) return sendJson(res, 404, { error: 'Acta no encontrada' });
    if (!canEditMeeting(req.user, meeting)) return sendJson(res, 403, { error: 'Solo quien creó el acta (o un Administrador) puede editar la agenda' });
    if (meeting.status !== 'active') return sendJson(res, 400, { error: 'Esta acta ya está archivada' });
    await withDb((data) => {
      const m = data.meetings.find((x) => x.id === id);
      m.agendaItems = (m.agendaItems || []).filter((a) => a.id !== itemId);
    });
    const data = load();
    sendJson(res, 200, withMeetingInfo(data.meetings.find((m) => m.id === id), data, req.user));
  }));

  // Marcar (o desmarcar) un acta o un compromiso puntual como confidencial —
  // Punto 9. Mismo permiso que editar el acta.
  router.put('/api/meetings/:id/confidential', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    const meeting = data0.meetings.find((m) => m.id === id);
    if (!meeting) return sendJson(res, 404, { error: 'Acta no encontrada' });
    if (!canEditMeeting(req.user, meeting)) return sendJson(res, 403, { error: 'Solo quien creó el acta (o un Administrador) puede cambiar su confidencialidad' });
    await withDb((data) => {
      data.meetings.find((x) => x.id === id).confidential = !!body?.confidential;
    });
    const data = load();
    sendJson(res, 200, withMeetingInfo(data.meetings.find((m) => m.id === id), data, req.user));
  }));

  router.put('/api/commitments/:id/confidential', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    const found = findMeetingWithCommitment(data0, id);
    if (!found) return sendJson(res, 404, { error: 'Compromiso no encontrado' });
    if (!canEditMeeting(req.user, found.meeting)) return sendJson(res, 403, { error: 'Solo quien creó el acta (o un Administrador) puede cambiar su confidencialidad' });
    await withDb((data) => {
      findMeetingWithCommitment(data, id).commitment.confidential = !!body?.confidential;
    });
    const data = load();
    const f2 = findMeetingWithCommitment(data, id);
    sendJson(res, 200, withCommitmentInfo(f2.commitment, data, f2.meeting, req.user));
  }));

  // El responsable marca su propio compromiso como completado, dejando un
  // comentario breve — no lo puede completar otra persona en su nombre
  // (ni siquiera quien armó el acta), para que el comentario sea confiable.
  router.put('/api/commitments/:id/complete', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res, params, body) => {
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
    sendJson(res, 200, withCommitmentInfo(f2.commitment, data, f2.meeting, req.user));
  }));

  // "Verificar y Archivar": cierra el acta. Cualquier compromiso que haya
  // quedado pendiente pasa a "no cumplida" — desaparece de "Mis
  // Asignaciones" de quien lo tenía (que ya solo pide compromisos con
  // status 'pending') y queda documentado en el acta histórica.
  router.put('/api/meetings/:id/archive', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res, params) => {
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
    sendJson(res, 200, withMeetingInfo(data.meetings.find((m) => m.id === id), data, req.user));
  }));

  // Panel personal "Mis Asignaciones": solo los compromisos que siguen
  // pendientes (los completados ya no hace falta revisarlos, y los que
  // quedaron "no cumplida" al archivar el acta ya no son accionables). Es
  // SIEMPRE el propio compromiso de quien pregunta, así que se ve completo
  // sin importar si el acta o el compromiso están marcados confidenciales.
  router.get('/api/my-assignments', requireAuth(async (req, res) => {
    const data = load();
    const mine = [];
    for (const m of data.meetings) {
      for (const c of (m.commitments || [])) {
        if (Number(c.assignedToUserId) !== Number(req.user.id)) continue;
        if (c.status !== 'pending') continue;
        mine.push({ ...withCommitmentInfo(c, data, m, req.user), meetingId: m.id, meetingTitle: m.title });
      }
    }
    mine.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const pendingCount = mine.filter((c) => c.displayStatus === 'pending').length;
    const overdueCount = mine.filter((c) => c.displayStatus === 'overdue').length;
    sendJson(res, 200, { commitments: mine, pendingCount, overdueCount, total: mine.length });
  }));
}
