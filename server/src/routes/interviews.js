import { sendJson } from '../router.js';
import { load, withDb, nextId, interviewEligibility } from '../db.js';
import { requireAuth } from '../guard.js';
import { sendCancellationEmail, sendRescheduleEmail } from '../notifications.js';

// Con quién se puede agendar una entrevista, según el Manual General: un
// hombre adulto con Cuórum de Élderes o con el Obispado; una mujer adulta
// con Sociedad de Socorro o con el Obispado; un joven o una joven solo con
// el Obispado (el Obispo y sus consejeros pueden entrevistar a cualquiera,
// sin restricción — ver interviewEligibility en db.js). Aplica tanto a las
// solicitudes de entrevista (interview-requests.js) como acá, cuando el
// líder agenda a mano. Solo se puede validar si el nombre está vinculado a
// una cuenta registrada (memberUserId) y esa cuenta ya completó su perfil —
// un nombre escrito a mano, o un miembro cuyo perfil todavía está
// incompleto, no se puede validar y se permite igual que siempre.
function checkInterviewEligibility(data, organizationId, memberUserId) {
  if (!memberUserId) return null;
  const org = data.organizations.find((o) => o.id === Number(organizationId));
  const member = data.users.find((u) => u.id === Number(memberUserId));
  if (!org || !member) return null;
  const eligible = interviewEligibility(org.name, member);
  if (eligible === false) {
    return `Esta entrevista es de ${org.name} y ${member.name} no corresponde según su perfil (sexo/edad) — según el Manual General, agenda con el Obispado en su lugar.`;
  }
  return null;
}

// Cuando se entrevista a más de una persona a la vez (matrimonio,
// compañerismo de ministración), CADA persona del grupo debe corresponder
// individualmente a la organización — a propósito no basta con que una sola
// califique: por ejemplo, el presidente de Cuórum de Élderes no puede
// entrevistar junto a un matrimonio, porque la esposa por sí sola no
// corresponde a esa organización (solo el Obispado puede entrevistar a
// cualquier persona sin restricción, así que un matrimonio o un
// compañerismo mixto siempre puede agendarse con el Obispado).
function checkGroupEligibility(data, organizationId, members) {
  for (const m of members) {
    const err = checkInterviewEligibility(data, organizationId, m.memberUserId);
    if (err) return err;
  }
  return null;
}

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

// "Juan Pérez", "Juan y María Pérez", "Juan, María y Pedro Pérez" — mismo
// criterio de unión de nombres en toda la app (español, con "y" antes del
// último en vez de una coma).
export function joinNames(names) {
  const list = names.filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  if (list.length === 2) return `${list[0]} y ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} y ${list[list.length - 1]}`;
}

// Punto de ampliación "más de una persona a la vez": cada persona citada
// sigue viviendo en su propia fila de `interviews` (para que "veces
// entrevistado", el vínculo con su propia "Mis Actividades", y sus propios
// recordatorios por email sigan siendo por persona, sin mezclarse) — pero
// todas las filas de la misma reunión comparten un `groupId`, y de cara al
// líder/administrador se presentan juntas como UNA sola tarjeta ("Juan y
// María Pérez"), que se edita/marca/elimina como una unidad. Una entrevista
// de una sola persona es, para este código, simplemente "un grupo de 1" —
// no hay ningún caso especial.
function groupInterviews(rows, orgs, data) {
  const byGroup = new Map();
  for (const iv of rows) {
    if (!byGroup.has(iv.groupId)) byGroup.set(iv.groupId, []);
    byGroup.get(iv.groupId).push(iv);
  }
  const groups = [];
  for (const [groupId, groupRowsRaw] of byGroup) {
    const groupRows = [...groupRowsRaw].sort((a, b) => a.id - b.id);
    const first = groupRows[0];
    const org = orgs.find((o) => o.id === first.organizationId);
    const members = groupRows.map((iv) => ({
      id: iv.id,
      memberName: iv.memberName,
      memberUserId: iv.memberUserId,
      memberPhone: iv.memberPhone,
      memberEmail: iv.memberEmail,
      ...(data ? memberInterviewStats(data, iv) : {}),
    }));
    groups.push({
      // `id` = `groupId`: se deja como alias a propósito para que cualquier
      // código (cliente o futuro) que siga esperando un solo "id" por
      // entrevista (como toda la vida) apunte automáticamente al grupo
      // completo — editar/marcar/eliminar por "id" ya edita/marca/elimina a
      // TODAS las personas citadas juntas, sin tener que tocar esas rutas.
      id: groupId,
      groupId,
      ids: groupRows.map((iv) => iv.id),
      members,
      memberNames: joinNames(members.map((m) => m.memberName)),
      // compatibilidad: quien todavía espera un solo memberName/memberUserId
      // (por ejemplo, "Mis Actividades" en calendar.js, que sigue siendo por
      // fila individual y no pasa por acá) sigue encontrando el de la
      // primera persona del grupo.
      memberName: first.memberName,
      memberUserId: first.memberUserId,
      memberPhone: first.memberPhone,
      memberEmail: first.memberEmail,
      timesInterviewed: members[0]?.timesInterviewed,
      lastInterviewDate: members[0]?.lastInterviewDate,
      description: first.description,
      location: first.location,
      sala: first.sala,
      interviewerName: first.interviewerName,
      interviewerEmail: first.interviewerEmail,
      interviewerPhone: first.interviewerPhone,
      date: first.date,
      startTime: first.startTime,
      endTime: first.endTime,
      organizationId: first.organizationId,
      organizationName: org?.name || '',
      organizationColor: org?.color || '#999999',
      status: first.status || 'scheduled',
      comment: first.comment || '',
      markedAt: first.markedAt,
      markedBy: first.markedBy,
      scheduledBy: first.scheduledBy,
      createdAt: first.createdAt,
      updatedAt: groupRows.map((iv) => iv.updatedAt).sort().slice(-1)[0],
    });
  }
  return groups;
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

// Acepta tanto `body.members` (arreglo — matrimonio, compañerismo de
// ministración) como los campos sueltos de siempre (`memberName`,
// `memberUserId`, ...) para no romper a nadie que todavía mande el formato
// de una sola persona. Descarta filas sin nombre y evita citar dos veces a
// la misma persona dentro del mismo grupo (por vínculo de cuenta, o por
// nombre si no está vinculada).
function normalizeMembersInput(body, users) {
  const raw = Array.isArray(body?.members) && body.members.length
    ? body.members
    : (body?.memberName ? [{ memberName: body.memberName, memberUserId: body.memberUserId, memberPhone: body.memberPhone, memberEmail: body.memberEmail }] : []);
  const seen = new Set();
  const result = [];
  for (const m of raw) {
    const memberName = String(m?.memberName || '').trim();
    if (!memberName) continue;
    const memberUserId = normalizeMemberUserId(m?.memberUserId, users) || null;
    const key = memberUserId ? `u:${memberUserId}` : `n:${normalizeSearchText(memberName)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      memberName,
      memberUserId,
      memberPhone: m?.memberPhone || '',
      memberEmail: m?.memberEmail || '',
    });
  }
  return result;
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
      const ownRows = applyStatusFilter(data.interviews.filter((i) => Number(i.memberUserId) === Number(user.id)));
      const groups = groupInterviews(ownRows, data.organizations, data)
        .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
      return sendJson(res, 200, groups);
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
    items = applyStatusFilter(items);
    const groups = groupInterviews(items, data.organizations, data)
      // El historial se ordena del más reciente al más antiguo (lo último
      // marcado primero); la lista de pendientes, de la más próxima/atrasada
      // en adelante — igual criterio que antes.
      .sort((a, b) => query.status === 'history'
        ? (b.markedAt || '').localeCompare(a.markedAt || '') || b.date.localeCompare(a.date)
        : (a.date + a.startTime).localeCompare(b.date + b.startTime));
    sendJson(res, 200, groups);
  }));

  // "¿Está ocupada esta sala a esta hora?" — para el aviso de choque al
  // agendar una ACTIVIDAD (o entrevista) de cualquier organización. A
  // propósito NO reutiliza el filtro de privacidad de arriba
  // (orgSeesAllInterviews): cualquier líder debe poder saber que una sala
  // está ocupada por una entrevista de otra organización para no chocar con
  // ella, sin necesidad de ver el listado completo de esa organización. Por
  // eso esta respuesta solo trae lugar/sala/horario/organización — nunca el
  // nombre del miembro, del entrevistador, ni la descripción (eso sigue
  // siendo privado, ver GET /api/interviews de arriba). Una entrevista
  // grupal solo ocupa la sala una vez (no una vez por persona citada).
  router.get('/api/interviews/room-occupancy', requireAuth(async (req, res) => {
    const data = load();
    const query = req.query;
    let items = data.interviews.filter((i) => !!i.location);
    if (query.date) items = items.filter((i) => i.date === query.date);
    if (query.from) items = items.filter((i) => i.date >= query.from);
    if (query.to) items = items.filter((i) => i.date <= query.to);
    const seenGroups = new Set();
    const result = [];
    for (const i of items) {
      if (seenGroups.has(i.groupId)) continue;
      seenGroups.add(i.groupId);
      const org = data.organizations.find((o) => o.id === Number(i.organizationId));
      result.push({
        id: i.groupId,
        organizationId: i.organizationId,
        organizationName: org?.name || '',
        organizationColor: org?.color || '#999999',
        date: i.date,
        startTime: i.startTime,
        endTime: i.endTime,
        location: i.location,
        sala: i.sala || '',
      });
    }
    sendJson(res, 200, result);
  }));

  router.post('/api/interviews', requireAuth(async (req, res, params, body) => {
    const {
      description, location, sala, date, startTime, endTime, organizationId,
      interviewerName, interviewerEmail, interviewerPhone,
    } = body || {};
    const data = load();
    const members = normalizeMembersInput(body, data.users);
    if (!members.length || !date || !startTime || !organizationId) {
      return sendJson(res, 400, { error: 'Faltan campos requeridos (al menos una persona, día, horario, organización)' });
    }
    if (!orgAllowsInterviews(data, organizationId)) {
      return sendJson(res, 400, { error: 'Esta organización no agenda entrevistas' });
    }
    if (!canScheduleOrg(req.user, organizationId)) {
      return sendJson(res, 403, { error: 'Solo el líder de la organización o un administrador puede agendar entrevistas' });
    }
    const eligibilityError = checkGroupEligibility(data, organizationId, members);
    if (eligibilityError) return sendJson(res, 400, { error: eligibilityError });
    const now = new Date().toISOString();
    const createdRows = await withDb((d) => {
      const finalLocation = location || '';
      // Igual que en las actividades: la sala puntual solo aplica cuando el
      // lugar es "Casa Capilla" o "Capilla" (son dos edificios distintos,
      // cada uno con su propio listado de salas).
      const finalSala = ['Casa Capilla', 'Capilla'].includes(finalLocation) ? (sala || '') : '';
      const rows = [];
      let groupId = null;
      for (const m of members) {
        const id = nextId(d, 'interviews');
        if (groupId === null) groupId = id;
        const iv = {
          id,
          groupId,
          memberName: m.memberName,
          memberUserId: m.memberUserId,
          memberPhone: m.memberPhone,
          memberEmail: m.memberEmail,
          description: description || '',
          location: finalLocation,
          sala: finalSala,
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
        d.interviews.push(iv);
        rows.push(iv);
      }
      return rows;
    });
    const data2 = load();
    const [group] = groupInterviews(createdRows, data2.organizations, data2);
    sendJson(res, 201, group);
  }));

  // :id acá es el `groupId` — el identificador de la reunión completa (una
  // persona, o varias citadas juntas), no de una fila puntual. Editar
  // reemplaza la lista de personas del grupo: a quien ya estaba y sigue
  // (mismo memberUserId, o mismo nombre si no está vinculado) se le
  // actualiza su fila conservando su estado/historial; a quien se agrega se
  // le crea una fila nueva; a quien se saca del grupo se le elimina su fila
  // (y se le avisa por correo que esa parte se canceló, si tenía email).
  router.put('/api/interviews/:id', requireAuth(async (req, res, params, body) => {
    const groupId = Number(params.id);
    const data = load();
    const existingRows = data.interviews.filter((i) => i.groupId === groupId);
    if (!existingRows.length) return sendJson(res, 404, { error: 'Entrevista no encontrada' });
    const first = existingRows[0];
    if (!canScheduleOrg(req.user, first.organizationId)) {
      return sendJson(res, 403, { error: 'No tienes permiso para editar esta entrevista' });
    }
    const nextOrganizationId = body.organizationId !== undefined ? Number(body.organizationId) : first.organizationId;
    const members = (body.members !== undefined || body.memberName !== undefined)
      ? normalizeMembersInput(body, data.users)
      : existingRows.map((iv) => ({ memberName: iv.memberName, memberUserId: iv.memberUserId, memberPhone: iv.memberPhone, memberEmail: iv.memberEmail }));
    if (!members.length) return sendJson(res, 400, { error: 'La entrevista necesita al menos una persona' });
    const eligibilityError = checkGroupEligibility(data, nextOrganizationId, members);
    if (eligibilityError) return sendJson(res, 400, { error: eligibilityError });

    // se guarda la fecha/hora previas para poder avisar "antes → ahora" si
    // cambian, antes de que withDb las sobrescriba.
    const previousSchedule = { date: first.date, startTime: first.startTime };
    const { updatedRows, removedRows } = await withDb((d) => {
      const rows = d.interviews.filter((i) => i.groupId === groupId);
      const finalLocation = body.location !== undefined ? (body.location || '') : (rows[0].location || '');
      const finalSala = ['Casa Capilla', 'Capilla'].includes(finalLocation)
        ? (body.sala !== undefined ? (body.sala || '') : (rows[0].sala || ''))
        : '';
      const sharedPatch = {
        description: body.description !== undefined ? (body.description || '') : rows[0].description,
        location: finalLocation,
        sala: finalSala,
        interviewerName: body.interviewerName !== undefined ? (body.interviewerName || '') : (rows[0].interviewerName || ''),
        interviewerEmail: body.interviewerEmail !== undefined ? (body.interviewerEmail || '') : (rows[0].interviewerEmail || ''),
        interviewerPhone: body.interviewerPhone !== undefined ? (body.interviewerPhone || '') : (rows[0].interviewerPhone || ''),
        date: body.date !== undefined ? body.date : rows[0].date,
        startTime: body.startTime !== undefined ? body.startTime : rows[0].startTime,
        endTime: body.endTime !== undefined ? (body.endTime || null) : rows[0].endTime,
        organizationId: nextOrganizationId,
      };
      const dateOrTimeChanged = sharedPatch.date !== rows[0].date || sharedPatch.startTime !== rows[0].startTime;
      const interviewerContactChanged = sharedPatch.interviewerEmail !== (rows[0].interviewerEmail || '');
      const usedIds = new Set();
      const updated = [];
      for (const m of members) {
        let row = null;
        if (m.memberUserId) {
          row = rows.find((r) => !usedIds.has(r.id) && Number(r.memberUserId) === Number(m.memberUserId));
        }
        if (!row) {
          const norm = normalizeSearchText(m.memberName);
          row = rows.find((r) => !usedIds.has(r.id) && !r.memberUserId && normalizeSearchText(r.memberName) === norm);
        }
        if (row) {
          usedIds.add(row.id);
          const memberContactChanged = (m.memberEmail || '') !== (row.memberEmail || '');
          Object.assign(row, sharedPatch, {
            memberName: m.memberName,
            memberUserId: m.memberUserId,
            memberPhone: m.memberPhone,
            memberEmail: m.memberEmail,
            reminderSent: (dateOrTimeChanged || interviewerContactChanged || memberContactChanged) ? false : row.reminderSent,
            updatedAt: new Date().toISOString(),
          });
          updated.push(row);
        } else {
          const iv = {
            id: nextId(d, 'interviews'),
            groupId,
            memberName: m.memberName,
            memberUserId: m.memberUserId,
            memberPhone: m.memberPhone,
            memberEmail: m.memberEmail,
            ...sharedPatch,
            scheduledBy: req.user.id,
            reminderSent: false,
            status: rows[0].status || 'scheduled',
            comment: rows[0].comment || '',
            markedAt: rows[0].markedAt ?? null,
            markedBy: rows[0].markedBy ?? null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          d.interviews.push(iv);
          updated.push(iv);
        }
      }
      const removed = rows.filter((r) => !usedIds.has(r.id));
      if (removed.length) {
        const removedIds = new Set(removed.map((r) => r.id));
        d.interviews = d.interviews.filter((i) => !removedIds.has(i.id));
      }
      return { updatedRows: updated, removedRows: removed };
    });
    if (previousSchedule.date !== updatedRows[0].date || previousSchedule.startTime !== updatedRows[0].startTime) {
      // se avisa en segundo plano; no se bloquea la respuesta por el envío del correo.
      for (const row of updatedRows) sendRescheduleEmail(row, previousSchedule);
    }
    // a quien se sacó del grupo se le avisa que esa parte quedó cancelada.
    for (const row of removedRows) sendCancellationEmail(row);
    const data2 = load();
    const rows2 = data2.interviews.filter((i) => i.groupId === groupId);
    const [group] = groupInterviews(rows2, data2.organizations, data2);
    sendJson(res, 200, group);
  }));

  // Check de verificación: ¿se logró hacer la entrevista o no? Al marcar
  // "done" o "not_done" TODAS las personas del grupo salen juntas de la
  // pestaña principal (que solo muestra "scheduled") y pasan al historial —
  // con un comentario opcional (ej. "se hizo todo muy bien, el hermano está
  // buscando trabajo, pero está con ánimo" o "se canceló porque el hermano
  // está enfermo"). Volver a marcar "scheduled" las devuelve a pendiente
  // (por si se marcó por error).
  router.put('/api/interviews/:id/mark', requireAuth(async (req, res, params, body) => {
    const groupId = Number(params.id);
    const data0 = load();
    const existingRows = data0.interviews.filter((i) => i.groupId === groupId);
    if (!existingRows.length) return sendJson(res, 404, { error: 'Entrevista no encontrada' });
    if (!canScheduleOrg(req.user, existingRows[0].organizationId)) {
      return sendJson(res, 403, { error: 'No tienes permiso para marcar esta entrevista' });
    }
    const status = body?.status;
    if (!['done', 'not_done', 'scheduled'].includes(status)) return sendJson(res, 400, { error: 'Estado inválido' });
    const comment = String(body?.comment || '').trim();
    await withDb((d) => {
      const rows = d.interviews.filter((i) => i.groupId === groupId);
      for (const iv of rows) {
        iv.status = status;
        iv.comment = status === 'scheduled' ? '' : comment;
        iv.markedAt = status === 'scheduled' ? null : new Date().toISOString();
        iv.markedBy = status === 'scheduled' ? null : req.user.id;
      }
    });
    const data = load();
    const rows = data.interviews.filter((i) => i.groupId === groupId);
    const [group] = groupInterviews(rows, data.organizations, data);
    sendJson(res, 200, group);
  }));

  // Eliminar de verdad (sin dejar registro histórico) — para corregir un
  // error al agendar (ej. duplicada). Elimina TODAS las personas del grupo a
  // la vez (es una sola reunión). Si la entrevista sí se agendó bien pero no
  // se pudo hacer, conviene usar el check ❌ (arriba) en vez de eliminarla,
  // para que quede el motivo en el historial.
  router.delete('/api/interviews/:id', requireAuth(async (req, res, params) => {
    const groupId = Number(params.id);
    const data = load();
    const existingRows = data.interviews.filter((i) => i.groupId === groupId);
    if (!existingRows.length) return sendJson(res, 404, { error: 'Entrevista no encontrada' });
    if (!canScheduleOrg(req.user, existingRows[0].organizationId)) {
      return sendJson(res, 403, { error: 'No tienes permiso para eliminar esta entrevista' });
    }
    await withDb((d) => {
      d.interviews = d.interviews.filter((i) => i.groupId !== groupId);
    });
    // se avisa en segundo plano; no se bloquea la respuesta por el envío del correo.
    for (const iv of existingRows) sendCancellationEmail(iv);
    sendJson(res, 200, { ok: true });
  }));
}
