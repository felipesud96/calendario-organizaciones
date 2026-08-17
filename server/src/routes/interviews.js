import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireAuth } from '../guard.js';
import { sendCancellationEmail, sendRescheduleEmail } from '../notifications.js';

function canScheduleOrg(user, organizationId) {
  if (user.role === 'admin') return true;
  if (user.role === 'leader' && Number(user.organizationId) === Number(organizationId)) return true;
  return false;
}

// Las entrevistas son información privada de los miembros: el perfil Miembro
// no las ve en absoluto, y cada líder solo ve las de su propia organización,
// salvo el líder de Obispado, que sí puede ver las de todas las organizaciones.
// Exportado para search.js — la búsqueda global reutiliza EXACTAMENTE esta
// misma regla de privacidad en vez de duplicarla, para no arriesgar que la
// búsqueda muestre una entrevista que la persona no debería poder ver.
export function orgSeesAllInterviews(user, data) {
  if (user.role === 'admin') return true;
  if (user.role === 'leader') {
    const org = data.organizations.find((o) => o.id === Number(user.organizationId));
    return !!org && org.name === 'Obispado';
  }
  return false;
}

function orgAllowsInterviews(data, organizationId) {
  const org = data.organizations.find((o) => o.id === Number(organizationId));
  return !!org && !!org.allowsInterviews;
}

function normalizeSearchText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// Igual criterio que speakerKey en talks.js y familyId en cleaning.js: dos
// entrevistas son "de la misma persona" si comparten memberUserId (miembro
// registrado), o si no lo tienen, si el nombre escrito coincide (sin
// importar mayúsculas ni tildes) — así el historial "cuántas veces se ha
// entrevistado" no se fragmenta por variaciones menores del nombre.
function interviewMemberKey(iv) {
  return iv.memberUserId ? `u:${iv.memberUserId}` : `n:${normalizeSearchText(iv.memberName)}`;
}

// Solo cuentan las entrevistas ya verificadas como "Se hizo" — igual
// espíritu que familyStats (Aseo) y speakerStats (Discursos), que solo
// suman lo efectivamente cumplido, no lo agendado.
function memberInterviewStats(data, iv) {
  const key = interviewMemberKey(iv);
  const done = data.interviews.filter((i) => interviewMemberKey(i) === key && i.status === 'done');
  const timesInterviewed = done.length;
  const lastInterviewDate = done.length ? done.map((i) => i.date).sort().slice(-1)[0] : null;
  return { timesInterviewed, lastInterviewDate };
}

function withOrgInfo(item, orgs, data) {
  const org = orgs.find((o) => o.id === item.organizationId);
  return {
    ...item,
    // compatibilidad con entrevistas guardadas antes del check de
    // verificación (ver migración en db.js — en teoría ya vienen con
    // status, este fallback es solo una red de seguridad extra).
    status: item.status || 'scheduled',
    comment: item.comment || '',
    organizationName: org?.name || '',
    organizationColor: org?.color || '#999999',
    ...(data ? memberInterviewStats(data, item) : {}),
  };
}

// Si el líder eligió a un usuario ya registrado (en vez de escribir el
// nombre a mano), guardamos su id para que la entrevista le aparezca en su
// propio "Mis Actividades". Si el id no existe, se ignora (queda como si
// se hubiera escrito el nombre manualmente).
function normalizeMemberUserId(raw, users) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const id = Number(raw);
  if (!Number.isFinite(id)) return null;
  return users.some((u) => u.id === id) ? id : null;
}

export function registerInterviewRoutes(router) {
  // Cualquier usuario autenticado puede VER las entrevistas agendadas
  router.get('/api/interviews', requireAuth(async (req, res) => {
    const data = load();
    const user = req.user;
    // El parámetro "status" es opcional y no afecta a nadie que no lo pida
    // explícitamente (por ejemplo "Mis Actividades" sigue trayendo todo, sin
    // importar si ya se marcó o no): "scheduled" trae solo las pendientes de
    // verificar (la pestaña principal de Entrevistas), "history" trae solo
    // las ya marcadas ✅/❌ (el historial), y si no se manda, trae todas.
    const query = req.query;
    const applyStatusFilter = (items) => {
      if (query.status === 'scheduled') return items.filter((i) => (i.status || 'scheduled') === 'scheduled');
      if (query.status === 'history') return items.filter((i) => i.status && i.status !== 'scheduled');
      return items;
    };
    if (user.role === 'member') {
      // Las entrevistas son privadas: el perfil Miembro no ve las de los
      // demás, pero sí debe ver la suya propia (cuando el líder la agendó
      // eligiéndolo de la lista de usuarios registrados) para que le
      // aparezca en su "Mis Actividades".
      const own = applyStatusFilter(data.interviews.filter((i) => Number(i.memberUserId) === Number(user.id)))
        .map((i) => withOrgInfo(i, data.organizations, data))
        .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
      return sendJson(res, 200, own);
    }
    let items = data.interviews;
    if (!orgSeesAllInterviews(user, data)) {
      // Además de las entrevistas que agenda su propia organización, un
      // líder también debe ver aquellas en las que ÉL es el entrevistado,
      // aunque las haya agendado otra organización — por ejemplo, si el
      // líder de Obispado entrevista al líder de Cuórum de Élderes, este
      // último debe poder verla (aunque no la haya agendado su organización).
      items = items.filter((i) => Number(i.organizationId) === Number(user.organizationId) || Number(i.memberUserId) === Number(user.id));
    }
    if (query.from) items = items.filter((i) => i.date >= query.from);
    if (query.to) items = items.filter((i) => i.date <= query.to);
    if (query.organizationId) items = items.filter((i) => String(i.organizationId) === String(query.organizationId));
    items = applyStatusFilter(items)
      .map((i) => withOrgInfo(i, data.organizations, data))
      // El historial se ordena del más reciente al más antiguo (lo último
      // marcado primero); la lista de pendientes, de la más próxima/atrasada
      // en adelante — igual criterio que antes.
      .sort((a, b) => query.status === 'history'
        ? (b.markedAt || '').localeCompare(a.markedAt || '') || b.date.localeCompare(a.date)
        : (a.date + a.startTime).localeCompare(b.date + b.startTime));
    sendJson(res, 200, items);
  }));

  // "¿Está ocupada esta sala a esta hora?" — para el aviso de choque al
  // agendar una ACTIVIDAD (o entrevista) de cualquier organización. A
  // propósito NO reutiliza el filtro de privacidad de arriba
  // (orgSeesAllInterviews): cualquier líder debe poder saber que una sala
  // está ocupada por una entrevista de otra organización para no chocar con
  // ella, sin necesidad de ver el listado completo de esa organización. Por
  // eso esta respuesta solo trae lugar/sala/horario/organización — nunca el
  // nombre del miembro, del entrevistador, ni la descripción (eso sigue
  // siendo privado, ver GET /api/interviews de arriba).
  router.get('/api/interviews/room-occupancy', requireAuth(async (req, res) => {
    const data = load();
    const query = req.query;
    let items = data.interviews.filter((i) => !!i.location);
    if (query.date) items = items.filter((i) => i.date === query.date);
    if (query.from) items = items.filter((i) => i.date >= query.from);
    if (query.to) items = items.filter((i) => i.date <= query.to);
    const result = items.map((i) => {
      const org = data.organizations.find((o) => o.id === Number(i.organizationId));
      return {
        id: i.id,
        organizationId: i.organizationId,
        organizationName: org?.name || '',
        organizationColor: org?.color || '#999999',
        date: i.date,
        startTime: i.startTime,
        endTime: i.endTime,
        location: i.location,
        sala: i.sala || '',
      };
    });
    sendJson(res, 200, result);
  }));

  router.post('/api/interviews', requireAuth(async (req, res, params, body) => {
    const {
      memberName, memberPhone, memberEmail, description, location, sala, date, startTime, endTime, organizationId,
      interviewerName, interviewerEmail, interviewerPhone, memberUserId,
    } = body || {};
    if (!memberName || !date || !startTime || !organizationId) {
      return sendJson(res, 400, { error: 'Faltan campos requeridos (miembro, día, horario, organización)' });
    }
    const data = load();
    if (!orgAllowsInterviews(data, organizationId)) {
      return sendJson(res, 400, { error: 'Esta organización no agenda entrevistas' });
    }
    if (!canScheduleOrg(req.user, organizationId)) {
      return sendJson(res, 403, { error: 'Solo el líder de la organización o un administrador puede agendar entrevistas' });
    }
    const now = new Date().toISOString();
    const interview = await withDb((d) => {
      const i = {
        id: nextId(d, 'interviews'),
        memberName,
        memberUserId: normalizeMemberUserId(memberUserId, data.users) || null,
        memberPhone: memberPhone || '',
        memberEmail: memberEmail || '',
        description: description || '',
        location: location || '',
        // Igual que en las actividades: la sala puntual solo aplica cuando
        // el lugar es "Casa Capilla" o "Capilla" (son dos edificios
        // distintos, cada uno con su propio listado de salas).
        sala: ['Casa Capilla', 'Capilla'].includes(location) ? (sala || '') : '',
        interviewerName: interviewerName || '',
        interviewerEmail: interviewerEmail || '',
        interviewerPhone: interviewerPhone || '',
        date,
        startTime,
        endTime: endTime || null,
        organizationId: Number(organizationId),
        scheduledBy: req.user.id,
        reminderSent: false,
        // Pendiente de verificar hasta que alguien marque ✅/❌ — ver
        // PUT /api/interviews/:id/mark más abajo.
        status: 'scheduled',
        comment: '',
        markedAt: null,
        markedBy: null,
        createdAt: now,
        updatedAt: now,
      };
      d.interviews.push(i);
      return i;
    });
    sendJson(res, 201, withOrgInfo(interview, data.organizations, data));
  }));

  router.put('/api/interviews/:id', requireAuth(async (req, res, params, body) => {
    const id = Number(params.id);
    const data = load();
    const existing = data.interviews.find((i) => i.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Entrevista no encontrada' });
    if (!canScheduleOrg(req.user, existing.organizationId)) {
      return sendJson(res, 403, { error: 'No tienes permiso para editar esta entrevista' });
    }
    // se guarda la fecha/hora previas para poder avisar "antes → ahora" si
    // cambian, antes de que withDb las sobrescriba.
    const previousSchedule = { date: existing.date, startTime: existing.startTime };
    const updated = await withDb((d) => {
      const iv = d.interviews.find((i) => i.id === id);
      const newDate = body.date ?? iv.date;
      const newStartTime = body.startTime ?? iv.startTime;
      const newInterviewerEmail = body.interviewerEmail ?? iv.interviewerEmail ?? '';
      const newMemberEmail = body.memberEmail ?? iv.memberEmail ?? '';
      const dateOrTimeChanged = newDate !== iv.date || newStartTime !== iv.startTime;
      // si cambia la fecha/hora o algún email de contacto, el recordatorio
      // (si ya se había enviado) debe poder volver a dispararse.
      const contactChanged = newInterviewerEmail !== (iv.interviewerEmail || '') || newMemberEmail !== (iv.memberEmail || '');
      const memberUserId = normalizeMemberUserId(body.memberUserId, d.users);
      const finalLocation = body.location ?? iv.location ?? '';
      Object.assign(iv, {
        memberName: body.memberName ?? iv.memberName,
        memberUserId: memberUserId !== undefined ? memberUserId : (iv.memberUserId ?? null),
        memberPhone: body.memberPhone ?? iv.memberPhone,
        memberEmail: newMemberEmail,
        description: body.description ?? iv.description,
        location: finalLocation,
        sala: ['Casa Capilla', 'Capilla'].includes(finalLocation) ? (body.sala !== undefined ? (body.sala || '') : (iv.sala || '')) : '',
        interviewerName: body.interviewerName ?? iv.interviewerName ?? '',
        interviewerEmail: newInterviewerEmail,
        interviewerPhone: body.interviewerPhone ?? iv.interviewerPhone ?? '',
        date: newDate,
        startTime: newStartTime,
        endTime: body.endTime ?? iv.endTime,
        reminderSent: (dateOrTimeChanged || contactChanged) ? false : (iv.reminderSent ?? false),
        updatedAt: new Date().toISOString(),
      });
      return iv;
    });
    if (previousSchedule.date !== updated.date || previousSchedule.startTime !== updated.startTime) {
      // se avisa en segundo plano; no se bloquea la respuesta por el envío del correo.
      sendRescheduleEmail(updated, previousSchedule);
    }
    sendJson(res, 200, withOrgInfo(updated, data.organizations, data));
  }));

  // Check de verificación: ¿se logró hacer la entrevista o no? Al marcar
  // "done" o "not_done" la entrevista sale de la pestaña principal (que solo
  // muestra "scheduled") y pasa al historial — con un comentario opcional
  // (ej. "se hizo todo muy bien, el hermano está buscando trabajo, pero está
  // con ánimo" o "se canceló porque el hermano está enfermo"). Volver a
  // marcar "scheduled" la devuelve a pendiente (por si se marcó por error).
  router.put('/api/interviews/:id/mark', requireAuth(async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    const existing = data0.interviews.find((i) => i.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Entrevista no encontrada' });
    if (!canScheduleOrg(req.user, existing.organizationId)) {
      return sendJson(res, 403, { error: 'No tienes permiso para marcar esta entrevista' });
    }
    const status = body?.status;
    if (!['done', 'not_done', 'scheduled'].includes(status)) return sendJson(res, 400, { error: 'Estado inválido' });
    const comment = String(body?.comment || '').trim();
    await withDb((d) => {
      const iv = d.interviews.find((i) => i.id === id);
      iv.status = status;
      iv.comment = status === 'scheduled' ? '' : comment;
      iv.markedAt = status === 'scheduled' ? null : new Date().toISOString();
      iv.markedBy = status === 'scheduled' ? null : req.user.id;
    });
    const data = load();
    sendJson(res, 200, withOrgInfo(data.interviews.find((i) => i.id === id), data.organizations, data));
  }));

  // Eliminar de verdad (sin dejar registro histórico) — para corregir un
  // error al agendar (ej. duplicada). Si la entrevista sí se agendó bien
  // pero no se pudo hacer, conviene usar el check ❌ (arriba) en vez de
  // eliminarla, para que quede el motivo en el historial.
  router.delete('/api/interviews/:id', requireAuth(async (req, res, params) => {
    const id = Number(params.id);
    const data = load();
    const existing = data.interviews.find((i) => i.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Entrevista no encontrada' });
    if (!canScheduleOrg(req.user, existing.organizationId)) {
      return sendJson(res, 403, { error: 'No tienes permiso para eliminar esta entrevista' });
    }
    await withDb((d) => {
      d.interviews = d.interviews.filter((i) => i.id !== id);
    });
    // se avisa en segundo plano; no se bloquea la respuesta por el envío del correo.
    sendCancellationEmail(existing);
    sendJson(res, 200, { ok: true });
  }));
}
