import { sendJson } from '../router.js';
import { load, withDb, nextId, timesOverlap } from '../db.js';
import { requireAuth } from '../guard.js';
import { findStakeConflicts } from '../stakeCalendar.js';
import { isObispadoLeader } from './stake.js';
import { notifEnabled, pushEnabledFor, sendEventConflictWhatsApp, sendEventConflictPush } from '../notifications.js';
import { buildIcsCalendar } from '../ics.js';

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

// Punto 13 (Manual General 20.7.1): "Debe haber al menos dos adultos
// presentes" en cualquier actividad con jóvenes o niños. Para las
// organizaciones de Mujeres Jóvenes, Hombres Jóvenes y Primaria, la app
// exige el nombre de al menos dos adultos supervisores antes de poder
// guardar la actividad — no es solo un recordatorio, es un campo obligatorio.
export const SUPERVISION_REQUIRED_ORG_NAMES = ['Hombres Jóvenes', 'Mujeres Jóvenes', 'Primaria'];

export function orgRequiresSupervisingAdults(orgs, organizationId) {
  const org = orgs.find((o) => o.id === Number(organizationId));
  return !!org && SUPERVISION_REQUIRED_ORG_NAMES.includes(org.name);
}

function cleanSupervisingAdults(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return [...new Set(arr.map((n) => String(n || '').trim()).filter(Boolean))];
}

export function canEditOrg(user, organizationId) {
  if (user.role === 'admin') return true;
  if (user.role === 'leader' && Number(user.organizationId) === Number(organizationId)) return true;
  return false;
}

// Reutilizado por achievements.js para el ranking "Más actividades
// registradas" de Rachas y Logros: quién ha creado más actividades (o
// reuniones privadas del calendario), agrupado por quién la creó
// (createdBy) y contado por la fecha propia de la actividad — así el
// período agrupa "lo que pasó en el trimestre", no "cuándo se tipeó en el
// sistema". `range` es opcional ({start, end} ISO, ambas inclusive); sin
// rango, es el total histórico.
export function allActivityCreatorsWithStats(data, range) {
  const inRange = (date) => !range || (date >= range.start && date <= range.end);
  const byUser = new Map();
  for (const e of data.events) {
    if (!e.createdBy || !inRange(e.date)) continue;
    if (!byUser.has(e.createdBy)) byUser.set(e.createdBy, []);
    byUser.get(e.createdBy).push(e);
  }
  return [...byUser.entries()].map(([userId, items]) => {
    const user = data.users.find((u) => u.id === Number(userId));
    return {
      userId: Number(userId),
      userName: user?.name || '(usuario eliminado)',
      count: items.length,
      lastDate: items.map((e) => e.date).sort().slice(-1)[0],
    };
  }).sort((a, b) => b.count - a.count);
}

// El detalle de quién respondió no se manda al cliente (mantiene el payload
// liviano, que viaja en cada carga de calendario) — solo el conteo de "Voy"
// y, si se pasa el id de quien pregunta, su propia respuesta. `rsvps` en sí
// (el arreglo crudo) se descarta del objeto que se manda.
function withOrgInfo(item, orgs, currentUserId) {
  const org = orgs.find((o) => o.id === item.organizationId);
  const involvedIds = Array.isArray(item.involvedOrganizationIds) ? item.involvedOrganizationIds : [];
  const involvedOrganizations = involvedIds
    .map((id) => orgs.find((o) => o.id === id))
    .filter(Boolean)
    .map((o) => ({ id: o.id, name: o.name, color: o.color }));
  const rsvps = Array.isArray(item.rsvps) ? item.rsvps : [];
  const rsvpYes = rsvps.filter((r) => r.response === 'yes').length;
  const rsvpNo = rsvps.filter((r) => r.response === 'no').length;
  const myRsvp = currentUserId ? (rsvps.find((r) => Number(r.userId) === Number(currentUserId))?.response || null) : null;
  const { rsvps: _omit, ...rest } = item;
  return { ...rest, organizationName: org?.name || '', organizationColor: org?.color || '#999999', involvedOrganizations, rsvpYes, rsvpNo, myRsvp };
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

// ------------------------------------------------------------------------
// Choque "suave" entre organizaciones (Task nacida de una pregunta directa
// del usuario): a diferencia del choque con Estaca (findStakeConflicts, que
// SÍ bloquea salvo autorización del líder de Obispado), dos actividades de
// distintas organizaciones del propio Barrio pueden chocar en horario y/o
// lugar sin que nada lo impida — el cliente ya avisa de esto a quien está
// agendando (ver findConflictingActivities en app.js), pero antes de esto
// quien había agendado PRIMERO nunca se enteraba de que alguien agendó
// encima. Estas funciones reproducen exactamente el mismo criterio que usa
// el cliente (mismo org = no choca; igual horario O igual lugar = choca),
// pero del lado del servidor, para poder avisarle al dueño de la actividad
// más antigua.
function normalizeLocationForConflict(loc) { return String(loc || '').trim().toLowerCase(); }

function placesConflictServer(aLoc, aSala, bLoc, bSala) {
  if (!aLoc || !bLoc) return false;
  if (normalizeLocationForConflict(aLoc) !== normalizeLocationForConflict(bLoc)) return false;
  if (aSala && bSala && normalizeLocationForConflict(aSala) !== normalizeLocationForConflict(bSala)) return false;
  return true;
}

function orgSetForConflict(item) {
  const ids = [Number(item.organizationId)];
  if (Array.isArray(item.involvedOrganizationIds)) ids.push(...item.involvedOrganizationIds.map(Number));
  return ids;
}

// Todas las demás actividades del mismo día que chocan (horario o lugar) con
// `event` y son de una organización distinta (sin ninguna en común).
function findOrgConflictsForEvent(data, event) {
  return data.events.filter((other) => {
    if (other.id === event.id) return false;
    if (other.date !== event.date) return false;
    const eventOrgs = orgSetForConflict(event);
    const otherOrgs = orgSetForConflict(other);
    if (eventOrgs.some((id) => otherOrgs.includes(id))) return false;
    const timeConflict = timesOverlap(event.startTime, event.endTime, other.startTime, other.endTime);
    const placeConflict = placesConflictServer(event.location, event.sala, other.location, other.sala);
    return timeConflict || placeConflict;
  });
}

// De esos choques, cuáles son MÁS ANTIGUOS que `event` (fueron creados
// primero) — es decir, para `event` (recién creado/editado), quiénes son
// los "dueños originales" a los que hay que avisar.
function findOlderConflicts(data, event) {
  return findOrgConflictsForEvent(data, event)
    .filter((other) => new Date(other.createdAt).getTime() < new Date(event.createdAt).getTime());
}

// De esos choques, cuáles son MÁS NUEVOS que `event` — para saber si una
// actividad propia (`event`, la más antigua) tiene hoy un choque sin avisar,
// usado por la campana de notificaciones (ver notifications-summary.js).
export function findNewerConflicts(data, event) {
  return findOrgConflictsForEvent(data, event)
    .filter((other) => new Date(other.createdAt).getTime() > new Date(event.createdAt).getTime());
}

// Actividades propias (como creador), aún futuras, que quedaron con un
// choque de otra organización sin que su dueño se haya enterado — para la
// campana de notificaciones. Se recalcula cada vez (igual que el resto de
// los avisos de la campana): si la actividad más nueva se edita o se borra y
// deja de chocar, el aviso desaparece solo, sin necesidad de "marcarlo como
// visto".
export function conflictingEventsOwnedBy(data, userId) {
  const todayIso = new Date().toISOString().slice(0, 10);
  return data.events
    .filter((ev) => Number(ev.createdBy) === Number(userId) && ev.date >= todayIso)
    .map((ev) => ({ event: ev, conflicts: findNewerConflicts(data, ev) }))
    .filter((x) => x.conflicts.length > 0);
}

// Avisa por WhatsApp (inmediato, no espera al recordatorio por cron) al
// dueño de cada actividad más antigua con la que `event` choca — salvo que
// sea la misma persona quien la creó (ej. el Administrador agendando dos
// organizaciones distintas) o que haya apagado este tipo de aviso desde "Mi
// Perfil" (notificationPrefs.eventConflicts). Nunca lanza hacia arriba ni
// retrasa la respuesta al usuario que está guardando: se llama sin `await`
// desde el handler de la ruta.
async function notifyOriginalOwnersOfConflict(data, event, creatorUserId) {
  const olderConflicts = findOlderConflicts(data, event);
  if (!olderConflicts.length) return;
  const orgName = data.organizations.find((o) => o.id === Number(event.organizationId))?.name || 'otra organización';
  for (const older of olderConflicts) {
    if (Number(older.createdBy) === Number(creatorUserId)) continue;
    const owner = data.users.find((u) => u.id === Number(older.createdBy));
    if (!owner || !notifEnabled(owner, 'eventConflicts')) continue;
    try {
      await sendEventConflictWhatsApp(older, event, orgName, owner);
      // Punto 39: mismo criterio de gateo que el WhatsApp de arriba (el
      // `continue` de más arriba ya exige notifEnabled(owner,
      // 'eventConflicts')) más el interruptor maestro de push.
      if (pushEnabledFor(owner, 'eventConflicts')) await sendEventConflictPush(older, event, orgName, owner);
    } catch (err) {
      console.error('[eventos] error avisando choque de horario:', err.message);
    }
  }
}

function buildEventFields(body, orgs) {
  const { title, description, location, sala, startTime, endTime, organizationId, involvedOrganizationIds, isWardActivity, isMeeting, purpose, supervisingAdults } = body || {};
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
    supervisingAdults: cleanSupervisingAdults(supervisingAdults),
  };
}

// Valida el Punto 13 contra el estado FINAL del evento (después de aplicar
// el body sobre lo existente, si corresponde) — se llama tanto al crear
// como al editar, porque una actividad puede pasar a ser de una de estas
// tres organizaciones recién al editarla.
function supervisingAdultsError(orgs, organizationId, supervisingAdults) {
  if (!orgRequiresSupervisingAdults(orgs, organizationId)) return null;
  const clean = cleanSupervisingAdults(supervisingAdults);
  if (clean.length < 2) {
    const org = orgs.find((o) => o.id === Number(organizationId));
    return `Las actividades de ${org?.name || 'esta organización'} requieren los nombres de al menos dos adultos supervisores (Manual General 20.7.1)`;
  }
  return null;
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
      .map((e) => withOrgInfo(e, data.organizations, req.user.id))
      .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
    sendJson(res, 200, items);
  }));

  // Punto 31: descarga el archivo .ics de UNA sola actividad (o reunión, si
  // quien pide puede verla — ver canSeeMeeting), para agregarla al
  // calendario personal del dispositivo con un solo botón — a diferencia
  // del feed de "Mis Actividades" (calendar.js), que es una SUSCRIPCIÓN
  // completa y pública por token, este endpoint SÍ requiere sesión (igual
  // que la descarga de respaldos, ver admin/backups) porque es una
  // descarga puntual dentro de la app, no un enlace para pegar en otra app
  // de calendario.
  router.get('/api/events/:id/ics', requireAuth(async (req, res, params) => {
    const id = Number(params.id);
    const data = load();
    const event = data.events.find((e) => e.id === id);
    if (!event) return sendJson(res, 404, { error: 'Actividad no encontrada' });
    if (!canSeeMeeting(req.user, event)) return sendJson(res, 403, { error: 'No puedes ver esta actividad' });
    const org = data.organizations.find((o) => o.id === Number(event.organizationId));
    const item = {
      id: event.id,
      kind: 'event',
      date: event.date,
      startTime: event.startTime,
      endTime: event.endTime,
      summary: `${event.isMeeting ? '🔒 ' : event.isWardActivity ? '🏘️ ' : ''}${event.title}`,
      location: event.location || '',
      description: event.description || '',
      organizationName: org?.name || '',
    };
    const ics = buildIcsCalendar([item], event.title);
    const safeName = event.title.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'actividad';
    res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeName}.ics"`,
      'Cache-Control': 'no-cache, no-store',
    });
    res.end(ics);
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
    const supervisionError = supervisingAdultsError(data0.organizations, organizationId, body?.supervisingAdults);
    if (supervisionError) return sendJson(res, 400, { error: supervisionError });
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
    sendJson(res, 201, withOrgInfo(event, data.organizations, req.user.id));
    notifyOriginalOwnersOfConflict(data, event, req.user.id);
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
    const supervisionError = supervisingAdultsError(data0.organizations, organizationId, body?.supervisingAdults);
    if (supervisionError) return sendJson(res, 400, { error: supervisionError });
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
    sendJson(res, 201, created.map((e) => withOrgInfo(e, data.organizations, req.user.id)));
    for (const e of created) notifyOriginalOwnersOfConflict(data, e, req.user.id);
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
    const finalSupervisingAdults = body.supervisingAdults !== undefined ? body.supervisingAdults : existing.supervisingAdults;
    const supervisionError = supervisingAdultsError(data.organizations, targetOrg, finalSupervisingAdults);
    if (supervisionError) return sendJson(res, 400, { error: supervisionError });
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
        supervisingAdults: body.supervisingAdults !== undefined ? cleanSupervisingAdults(body.supervisingAdults) : (ev.supervisingAdults || []),
        updatedAt: new Date().toISOString(),
      });
      return ev;
    });
    sendJson(res, 200, withOrgInfo(updated, data.organizations, req.user.id));
    notifyOriginalOwnersOfConflict(load(), updated, req.user.id);
  }));

  // Confirmación de asistencia (RSVP) por el propio usuario — "Voy" / "No
  // puedo" — solo tiene sentido para Actividades (no para Reuniones
  // privadas, que no son un evento al que un miembro "asista"). Volver a
  // llamar con la misma respuesta no hace nada raro (queda igual); mandar
  // `response: null` retira la respuesta.
  router.post('/api/events/:id/rsvp', requireAuth(async (req, res, params, body) => {
    const id = Number(params.id);
    const response = body?.response;
    if (response !== 'yes' && response !== 'no' && response !== null) {
      return sendJson(res, 400, { error: 'Respuesta inválida (debe ser "yes", "no", o null para quitarla)' });
    }
    const data0 = load();
    const existing = data0.events.find((e) => e.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Actividad no encontrada' });
    if (existing.isMeeting) return sendJson(res, 400, { error: 'No aplica confirmar asistencia a una reunión privada' });
    if (!canSeeMeeting(req.user, existing)) return sendJson(res, 403, { error: 'No puedes ver esta actividad' });
    const updated = await withDb((data) => {
      const ev = data.events.find((e) => e.id === id);
      const rsvps = Array.isArray(ev.rsvps) ? ev.rsvps : (ev.rsvps = []);
      const idx = rsvps.findIndex((r) => Number(r.userId) === Number(req.user.id));
      if (response === null) {
        if (idx !== -1) rsvps.splice(idx, 1);
      } else if (idx !== -1) {
        rsvps[idx] = { userId: req.user.id, response, respondedAt: new Date().toISOString() };
      } else {
        rsvps.push({ userId: req.user.id, response, respondedAt: new Date().toISOString() });
      }
      return ev;
    });
    const data = load();
    sendJson(res, 200, withOrgInfo(updated, data.organizations, req.user.id));
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
