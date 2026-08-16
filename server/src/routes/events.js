import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireAuth } from '../guard.js';
import { findStakeConflicts } from '../stakeCalendar.js';
import { isObispadoLeader } from './stake.js';

// Mensaje de error cuando una actividad de organización o de todo el Barrio
// choca con una actividad de Estaca de las que SÍ bloquean (conferencias,
// festivales, capacitaciones, etc. — no las puramente informativas, ver
// stakeCalendar.js → isBlockingStakeEvent). No se puede "pasar por alto"
// libremente como el aviso de choque entre organizaciones: solo el líder de
// Obispado (o el Administrador) puede autorizarlo igual, mandando
// `overrideStakeConflict: true` en el body (ver más abajo).
function stakeConflictError(conflicts) {
  const list = conflicts.map((c) => `"${c.title}"${c.startTime ? ` (${c.startTime}${c.endTime ? '–' + c.endTime : ''})` : ' (todo el día)'}`).join(', ');
  return `Choca con ${conflicts.length > 1 ? 'actividades de Estaca' : 'una actividad de Estaca'} (tienen prioridad) — ${list}. Requiere autorización del líder de Obispado antes de agendarse.`;
}

// Devuelve la respuesta 409 para un choque con Estaca, salvo que quien pide
// tenga permiso (líder de Obispado o Administrador) Y haya mandado la
// confirmación explícita `overrideStakeConflict: true` — en ese caso no
// bloquea, deja seguir.
function blockedByStake(conflicts, body, user, data) {
  if (!conflicts.length) return null;
  if (body?.overrideStakeConflict && isObispadoLeader(user, data)) return null;
  return { error: stakeConflictError(conflicts), stakeConflicts: conflicts, canOverride: isObispadoLeader(user, data) };
}

// Categorías de "Propósito" de una actividad — alimentan el balance del año
// del módulo Estadísticas (ver routes/stats.js). Es un campo obligatorio al
// crear una actividad nueva; las actividades creadas antes de que existiera
// este campo simplemente quedan sin propósito (purpose: null) y no se
// cuentan en ese balance.
export const PURPOSE_OPTIONS = ['Espiritual', 'Físico', 'Académico', 'Social', 'Servicio'];

export function canEditOrg(user, organizationId) {
  if (user.role === 'admin') return true;
  if (user.role === 'leader' && Number(user.organizationId) === Number(organizationId)) return true;
  return false;
}

function withOrgInfo(item, orgs) {
  const org = orgs.find((o) => o.id === item.organizationId);
  const involvedIds = Array.isArray(item.involvedOrganizationIds) ? item.involvedOrganizationIds : [];
  const involvedOrganizations = involvedIds
    .map((id) => orgs.find((o) => o.id === id))
    .filter(Boolean)
    .map((o) => ({ id: o.id, name: o.name, color: o.color }));
  return { ...item, organizationName: org?.name || '', organizationColor: org?.color || '#999999', involvedOrganizations };
}

// Limpia la lista de "otras organizaciones involucradas": solo IDs de
// organizaciones que existen de verdad, sin duplicados, y sin incluir a la
// organización principal (no puede estar "involucrada" consigo misma).
function normalizeInvolvedOrgIds(raw, primaryOrgId, orgs) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const validIds = new Set(orgs.map((o) => o.id));
  const primary = Number(primaryOrgId);
  const ids = arr.map(Number).filter((id) => Number.isFinite(id) && id !== primary && validIds.has(id));
  return [...new Set(ids)];
}

// Las "Reuniones" (a diferencia de las "Actividades") son privadas: solo las
// pueden ver los líderes (y el administrador) de las organizaciones
// incluidas en la reunión — la principal, las "involucradas" (reunión en
// conjunto), o todas si es "de todo el Barrio".
export function canSeeMeeting(user, item) {
  if (!item.isMeeting) return true;
  if (user.role === 'admin') return true;
  if (user.role !== 'leader') return false;
  if (item.isWardActivity) return true;
  const myOrg = Number(user.organizationId);
  if (myOrg === Number(item.organizationId)) return true;
  const involved = Array.isArray(item.involvedOrganizationIds) ? item.involvedOrganizationIds : [];
  return involved.map(Number).includes(myOrg);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function buildEventFields(body, orgs) {
  const { title, description, location, sala, startTime, endTime, organizationId, involvedOrganizationIds, isWardActivity, isMeeting, purpose } = body || {};
  const wardWide = !!isWardActivity;
  // Si es "de todo el Barrio" no hace falta guardar la lista de
  // organizaciones involucradas: se asume que participan todas.
  const cleanInvolved = wardWide ? [] : normalizeInvolvedOrgIds(involvedOrganizationIds, organizationId, orgs);
  return {
    title,
    description: description || '',
    location: location || '',
    // "Sala" (la sala/espacio puntual dentro del lugar) solo tiene sentido
    // cuando el lugar es "Casa Capilla" o "Capilla" — son dos edificios
    // distintos, cada uno con su propio listado de salas (ver
    // ROOMS_BY_LOCATION en app.js). Para cualquier otro lugar se ignora,
    // así no queda una sala "huérfana" mostrando un dato sin sentido (ej.
    // "Estacionamiento · Sala 1").
    sala: ['Casa Capilla', 'Capilla'].includes(location) ? (sala || '') : '',
    startTime,
    endTime: endTime || null,
    organizationId: Number(organizationId),
    involvedOrganizationIds: cleanInvolved,
    isWardActivity: wardWide,
    isMeeting: !!isMeeting,
    purpose: purpose || null,
  };
}

export function registerEventRoutes(router) {
  // Cualquier usuario autenticado puede VER el calendario, pero las
  // "Reuniones" solo se devuelven a quien tenga permiso de verlas (ver
  // canSeeMeeting): así ni el calendario general ni "Mis Actividades" las
  // filtran de más — el servidor ya no las entrega a quien no corresponde.
  router.get('/api/events', requireAuth(async (req, res) => {
    const data = load();
    const query = req.query;
    let items = data.events;
    if (query.from) items = items.filter((e) => e.date >= query.from);
    if (query.to) items = items.filter((e) => e.date <= query.to);
    if (query.organizationId) items = items.filter((e) => String(e.organizationId) === String(query.organizationId));
    items = items
      .filter((e) => canSeeMeeting(req.user, e))
      .map((e) => withOrgInfo(e, data.organizations))
      .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
    sendJson(res, 200, items);
  }));

  router.post('/api/events', requireAuth(async (req, res, params, body) => {
    const { title, date, startTime, organizationId, purpose } = body || {};
    if (!title || !date || !startTime || !organizationId) {
      return sendJson(res, 400, { error: 'Faltan campos requeridos (día, horario, descripción, organización)' });
    }
    if (!PURPOSE_OPTIONS.includes(purpose)) {
      return sendJson(res, 400, { error: 'Falta el propósito de la actividad (Espiritual, Físico, Académico, Social o Servicio)' });
    }
    if (!canEditOrg(req.user, organizationId)) {
      return sendJson(res, 403, { error: 'Solo el líder de la organización o un administrador puede agregar actividades aquí' });
    }
    const data0 = load();
    const stakeConflicts = findStakeConflicts(data0, { date, startTime, endTime: body.endTime });
    const stakeBlock = blockedByStake(stakeConflicts, body, req.user, data0);
    if (stakeBlock) return sendJson(res, 409, stakeBlock);
    const fields = buildEventFields(body, data0.organizations);
    const now = new Date().toISOString();
    const event = await withDb((data) => {
      const e = {
        id: nextId(data, 'events'),
        ...fields,
        date,
        createdBy: req.user.id,
        createdAt: now,
        updatedAt: now,
      };
      data.events.push(e);
      return e;
    });
    const data = load();
    sendJson(res, 201, withOrgInfo(event, data.organizations));
  }));

  // Crea varias ocurrencias de una misma actividad/reunión de una sola vez
  // (repetición semanal o un listado de fechas específicas elegidas a
  // mano). Cada ocurrencia queda como un evento independiente — se puede
  // editar o eliminar una fecha puntual sin afectar a las demás — pero
  // comparten un "recurrenceGroupId" por si en el futuro se quiere
  // gestionarlas en conjunto.
  router.post('/api/events/recurring', requireAuth(async (req, res, params, body) => {
    const { title, dates, startTime, organizationId, purpose } = body || {};
    if (!title || !startTime || !organizationId) {
      return sendJson(res, 400, { error: 'Faltan campos requeridos (horario, descripción, organización)' });
    }
    if (!PURPOSE_OPTIONS.includes(purpose)) {
      return sendJson(res, 400, { error: 'Falta el propósito de la actividad (Espiritual, Físico, Académico, Social o Servicio)' });
    }
    if (!Array.isArray(dates) || dates.length === 0) {
      return sendJson(res, 400, { error: 'Debes indicar al menos una fecha' });
    }
    const cleanDates = [...new Set(dates.filter((d) => DATE_RE.test(String(d))))].sort();
    if (!cleanDates.length) {
      return sendJson(res, 400, { error: 'Las fechas indicadas no son válidas' });
    }
    if (!canEditOrg(req.user, organizationId)) {
      return sendJson(res, 403, { error: 'Solo el líder de la organización o un administrador puede agregar actividades aquí' });
    }
    const data0 = load();
    // Se revisa CADA fecha del lote (no solo la primera, a diferencia del
    // aviso "suave" del cliente): si cualquiera choca con Estaca, se rechaza
    // el lote completo para no dejar una repetición creada a medias — salvo
    // que el líder de Obispado (o Administrador) haya autorizado igual.
    for (const d of cleanDates) {
      const conflicts = findStakeConflicts(data0, { date: d, startTime, endTime: body.endTime });
      const stakeBlock = blockedByStake(conflicts, body, req.user, data0);
      if (stakeBlock) return sendJson(res, 409, { ...stakeBlock, error: `${stakeBlock.error} (fecha: ${d})`, conflictDate: d });
    }
    const fields = buildEventFields(body, data0.organizations);
    const now = new Date().toISOString();
    const recurrenceGroupId = `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const created = await withDb((data) => {
      return cleanDates.map((date) => {
        const e = {
          id: nextId(data, 'events'),
          ...fields,
          date,
          recurrenceGroupId,
          createdBy: req.user.id,
          createdAt: now,
          updatedAt: now,
        };
        data.events.push(e);
        return e;
      });
    });
    const data = load();
    sendJson(res, 201, created.map((e) => withOrgInfo(e, data.organizations)));
  }));

  router.put('/api/events/:id', requireAuth(async (req, res, params, body) => {
    const id = Number(params.id);
    const data = load();
    const existing = data.events.find((e) => e.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Evento no encontrado' });
    const targetOrg = body.organizationId ?? existing.organizationId;
    if (!canEditOrg(req.user, existing.organizationId) || !canEditOrg(req.user, targetOrg)) {
      return sendJson(res, 403, { error: 'No tienes permiso para editar este evento' });
    }
    const finalDate = body.date ?? existing.date;
    const finalStartTime = body.startTime ?? existing.startTime;
    const finalEndTime = body.endTime ?? existing.endTime;
    const stakeConflicts = findStakeConflicts(data, { date: finalDate, startTime: finalStartTime, endTime: finalEndTime });
    const stakeBlock = blockedByStake(stakeConflicts, body, req.user, data);
    if (stakeBlock) return sendJson(res, 409, stakeBlock);
    const updated = await withDb((d) => {
      const ev = d.events.find((e) => e.id === id);
      const finalOrgId = body.organizationId !== undefined ? Number(body.organizationId) : ev.organizationId;
      const isWardActivity = body.isWardActivity !== undefined ? !!body.isWardActivity : !!ev.isWardActivity;
      const isMeeting = body.isMeeting !== undefined ? !!body.isMeeting : !!ev.isMeeting;
      // Si es "de todo el Barrio" no hace falta guardar la lista de
      // organizaciones involucradas: se asume que participan todas.
      const involvedOrganizationIds = isWardActivity
        ? []
        : (body.involvedOrganizationIds !== undefined
          ? normalizeInvolvedOrgIds(body.involvedOrganizationIds, finalOrgId, data.organizations)
          : (ev.involvedOrganizationIds || []).filter((oid) => oid !== finalOrgId));
      const finalLocation = body.location ?? ev.location ?? '';
      Object.assign(ev, {
        title: body.title ?? ev.title,
        description: body.description ?? ev.description,
        location: finalLocation,
        // Igual que al crear: la sala solo aplica cuando el lugar es "Casa
        // Capilla" o "Capilla" — si cambian el lugar a otro, la sala
        // anterior se limpia.
        sala: ['Casa Capilla', 'Capilla'].includes(finalLocation) ? (body.sala !== undefined ? (body.sala || '') : (ev.sala || '')) : '',
        date: body.date ?? ev.date,
        startTime: body.startTime ?? ev.startTime,
        endTime: body.endTime ?? ev.endTime,
        organizationId: finalOrgId,
        involvedOrganizationIds,
        isWardActivity,
        isMeeting,
        purpose: PURPOSE_OPTIONS.includes(body.purpose) ? body.purpose : ev.purpose ?? null,
        updatedAt: new Date().toISOString(),
      });
      return ev;
    });
    sendJson(res, 200, withOrgInfo(updated, data.organizations));
  }));

  router.delete('/api/events/:id', requireAuth(async (req, res, params) => {
    const id = Number(params.id);
    const data = load();
    const existing = data.events.find((e) => e.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Evento no encontrado' });
    if (!canEditOrg(req.user, existing.organizationId)) {
      return sendJson(res, 403, { error: 'No tienes permiso para eliminar este evento' });
    }
    await withDb((d) => {
      d.events = d.events.filter((e) => e.id !== id);
    });
    sendJson(res, 200, { ok: true });
  }));
}
