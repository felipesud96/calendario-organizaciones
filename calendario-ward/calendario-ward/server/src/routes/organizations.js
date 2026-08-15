import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireAuth, requireRole } from '../guard.js';

export function registerOrganizationRoutes(router) {
  router.get('/api/organizations', requireAuth(async (req, res) => {
    const data = load();
    const orgs = [...data.organizations].sort((a, b) => a.name.localeCompare(b.name, 'es'));
    sendJson(res, 200, orgs);
  }));

  router.post('/api/organizations', requireRole(['admin'], async (req, res, params, body) => {
    const { name, color, allowsInterviews } = body || {};
    if (!name || !color) return sendJson(res, 400, { error: 'Nombre y color requeridos' });
    const org = await withDb((data) => {
      const o = { id: nextId(data, 'organizations'), name, color, allowsInterviews: !!allowsInterviews };
      data.organizations.push(o);
      return o;
    });
    sendJson(res, 201, org);
  }));

  router.put('/api/organizations/:id', requireRole(['admin'], async (req, res, params, body) => {
    const id = Number(params.id);
    const updated = await withDb((data) => {
      const org = data.organizations.find((o) => o.id === id);
      if (!org) return null;
      Object.assign(org, {
        name: body.name ?? org.name,
        color: body.color ?? org.color,
        allowsInterviews: body.allowsInterviews ?? org.allowsInterviews,
      });
      return org;
    });
    if (!updated) return sendJson(res, 404, { error: 'Organización no encontrada' });
    sendJson(res, 200, updated);
  }));

  router.delete('/api/organizations/:id', requireRole(['admin'], async (req, res, params) => {
    const id = Number(params.id);
    await withDb((data) => {
      data.organizations = data.organizations.filter((o) => o.id !== id);
    });
    sendJson(res, 200, { ok: true });
  }));
}
