import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireAuth } from '../guard.js';

function canEditOrg(user, organizationId) {
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

export function registerEventRoutes(router) {
  // Cualquier usuario autenticado puede VER el calendario completo
  router.get('/api/events', requireAuth(async (req, res) => {
    const data = load();
    const query = req.query;
    let items = data.events;
    if (query.from) items = items.filter((e) => e.date >= query.from);
    if (query.to) items = items.filter((e) => e.date <= query.to);
    if (query.organizationId) items = items.filter((e) => String(e.organizationId) === String(query.organizationId));
    items = items
      .map((e) => withOrgInfo(e, data.organizations))
      .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
    sendJson(res, 200, items);
  }));

  router.post('/api/events', requireAuth(async (req, res, params, body) => {
    const { title, description, location, date, startTime, endTime, organizationId, involvedOrganizationIds } = body || {};
    if (!title || !date || !startTime || !organizationId) {
      return sendJson(res, 400, { error: 'Faltan campos requeridos (día, horario, descripción, organización)' });
    }
    if (!canEditOrg(req.user, organizationId)) {
      return sendJson(res, 403, { error: 'Solo el líder de la organización o un administrador puede agregar actividades aquí' });
    }
    const data0 = load();
    const cleanInvolved = normalizeInvolvedOrgIds(involvedOrganizationIds, organizationId, data0.organizations);
    const now = new Date().toISOString();
    const event = await withDb((data) => {
      const e = {
        id: nextId(data, 'events'),
        title,
        description: description || '',
        location: location || '',
        date,
        startTime,
        endTime: endTime || null,
        organizationId: Number(organizationId),
        involvedOrganizationIds: cleanInvolved,
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

  router.put('/api/events/:id', requireAuth(async (req, res, params, body) => {
    const id = Number(params.id);
    const data = load();
    const existing = data.events.find((e) => e.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Evento no encontrado' });
    const targetOrg = body.organizationId ?? existing.organizationId;
    if (!canEditOrg(req.user, existing.organizationId) || !canEditOrg(req.user, targetOrg)) {
      return sendJson(res, 403, { error: 'No tienes permiso para editar este evento' });
    }
    const updated = await withDb((d) => {
      const ev = d.events.find((e) => e.id === id);
      const finalOrgId = body.organizationId !== undefined ? Number(body.organizationId) : ev.organizationId;
      const involvedOrganizationIds = body.involvedOrganizationIds !== undefined
        ? normalizeInvolvedOrgIds(body.involvedOrganizationIds, finalOrgId, data.organizations)
        : (ev.involvedOrganizationIds || []).filter((oid) => oid !== finalOrgId);
      Object.assign(ev, {
        title: body.title ?? ev.title,
        description: body.description ?? ev.description,
        location: body.location ?? ev.location ?? '',
        date: body.date ?? ev.date,
        startTime: body.startTime ?? ev.startTime,
        endTime: body.endTime ?? ev.endTime,
        organizationId: finalOrgId,
        involvedOrganizationIds,
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
