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
function orgSeesAllInterviews(user, data) {
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

function withOrgInfo(item, orgs) {
  const org = orgs.find((o) => o.id === item.organizationId);
  return { ...item, organizationName: org?.name || '', organizationColor: org?.color || '#999999' };
}

export function registerInterviewRoutes(router) {
  // Cualquier usuario autenticado puede VER las entrevistas agendadas
  router.get('/api/interviews', requireAuth(async (req, res) => {
    const data = load();
    const user = req.user;
    if (user.role === 'member') {
      // Las entrevistas son privadas: el perfil Miembro no accede a ninguna.
      return sendJson(res, 200, []);
    }
    const query = req.query;
    let items = data.interviews;
    if (!orgSeesAllInterviews(user, data)) {
      items = items.filter((i) => Number(i.organizationId) === Number(user.organizationId));
    }
    if (query.from) items = items.filter((i) => i.date >= query.from);
    if (query.to) items = items.filter((i) => i.date <= query.to);
    if (query.organizationId) items = items.filter((i) => String(i.organizationId) === String(query.organizationId));
    items = items
      .map((i) => withOrgInfo(i, data.organizations))
      .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
    sendJson(res, 200, items);
  }));

  router.post('/api/interviews', requireAuth(async (req, res, params, body) => {
    const {
      memberName, memberPhone, memberEmail, description, location, date, startTime, endTime, organizationId,
      interviewerName, interviewerEmail, interviewerPhone,
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
        memberPhone: memberPhone || '',
        memberEmail: memberEmail || '',
        description: description || '',
        location: location || '',
        interviewerName: interviewerName || '',
        interviewerEmail: interviewerEmail || '',
        interviewerPhone: interviewerPhone || '',
        date,
        startTime,
        endTime: endTime || null,
        organizationId: Number(organizationId),
        scheduledBy: req.user.id,
        reminderSent: false,
        createdAt: now,
        updatedAt: now,
      };
      d.interviews.push(i);
      return i;
    });
    sendJson(res, 201, withOrgInfo(interview, data.organizations));
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
      Object.assign(iv, {
        memberName: body.memberName ?? iv.memberName,
        memberPhone: body.memberPhone ?? iv.memberPhone,
        memberEmail: newMemberEmail,
        description: body.description ?? iv.description,
        location: body.location ?? iv.location ?? '',
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
    sendJson(res, 200, withOrgInfo(updated, data.organizations));
  }));

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
