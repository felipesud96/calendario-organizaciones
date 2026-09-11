import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireAuth, requireRole } from '../guard.js';

// Corrección (revisión de código): este archivo no validaba nada — se podía
// crear una organización sin nombre ni color, con el mismo nombre que otra
// ya existente (rompiendo cualquier código que busque una organización POR
// NOMBRE, como isObispadoLeader o WELFARE_COMMITTEE_ORGS), con un color que
// no es un valor CSS válido, o incluso vaciar el nombre de una organización
// ya existente con `PUT { name: '' }` (el `??` de antes no protegía contra
// un string vacío, solo contra null/undefined).
//
// Además, estas tres organizaciones se identifican por su NOMBRE (no por un
// id fijo ni un enum) en varias partes del servidor para decidir permisos
// especiales — ver isObispadoLeader (organizations.js/interviews.js/
// welfare.js/meetings.js/budget.js), WELFARE_COMMITTEE_ORGS en welfare.js, y
// PRESIDENT_ORGS en db.js. Renombrarlas o eliminarlas rompería esos permisos
// en silencio para todo el Barrio (nadie volvería a tener acceso a
// Presupuesto, Bienestar, etc. como Obispado), así que se protegen aparte.
const PROTECTED_ORG_NAMES = ['Obispado', 'Cuórum de Élderes', 'Sociedad de Socorro'];

// Único formato de color que usa el cliente: valor CSS hex de 3 o 6 dígitos
// (#abc o #aabbcc), siempre interpolado directo como background/color.
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}){1,2}$/;

function normalizeOrgName(s) {
  return String(s || '').trim();
}

function sameName(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

export function registerOrganizationRoutes(router) {
  router.get('/api/organizations', requireAuth(async (req, res) => {
    const data = load();
    const orgs = [...data.organizations].sort((a, b) => a.name.localeCompare(b.name, 'es'));
    sendJson(res, 200, orgs);
  }));

  router.post('/api/organizations', requireRole(['admin'], async (req, res, params, body) => {
    const name = normalizeOrgName(body?.name);
    const color = String(body?.color || '').trim();
    if (!name || !color) return sendJson(res, 400, { error: 'Nombre y color requeridos' });
    if (!HEX_COLOR_RE.test(color)) {
      return sendJson(res, 400, { error: 'El color debe ser un hex válido (ej. #4f8ef7)' });
    }
    const data0 = load();
    if (data0.organizations.some((o) => sameName(o.name, name))) {
      return sendJson(res, 409, { error: 'Ya existe una organización con ese nombre' });
    }
    const allowsInterviews = !!body?.allowsInterviews;
    // Se revalida la unicidad del nombre adentro de withDb (que sí
    // serializa) por si dos creaciones casi simultáneas usaron el mismo
    // nombre — mismo patrón de corrección ya aplicado en budget.js/
    // welfare.js/registration.js/users.js.
    const org = await withDb((data) => {
      if (data.organizations.some((o) => sameName(o.name, name))) return null;
      const o = { id: nextId(data, 'organizations'), name, color, allowsInterviews };
      data.organizations.push(o);
      return o;
    });
    if (!org) return sendJson(res, 409, { error: 'Ya existe una organización con ese nombre' });
    sendJson(res, 201, org);
  }));

  router.put('/api/organizations/:id', requireRole(['admin'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    const existing = data0.organizations.find((o) => o.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Organización no encontrada' });
    const name = body?.name !== undefined ? normalizeOrgName(body.name) : existing.name;
    if (!name) return sendJson(res, 400, { error: 'El nombre no puede quedar vacío' });
    const color = body?.color !== undefined ? String(body.color).trim() : existing.color;
    if (!color) return sendJson(res, 400, { error: 'El color no puede quedar vacío' });
    if (!HEX_COLOR_RE.test(color)) {
      return sendJson(res, 400, { error: 'El color debe ser un hex válido (ej. #4f8ef7)' });
    }
    if (!sameName(name, existing.name) && data0.organizations.some((o) => o.id !== id && sameName(o.name, name))) {
      return sendJson(res, 409, { error: 'Ya existe una organización con ese nombre' });
    }
    if (PROTECTED_ORG_NAMES.includes(existing.name) && name !== existing.name) {
      return sendJson(res, 400, { error: `"${existing.name}" es un nombre especial que usa el sistema para asignar permisos — no se puede renombrar` });
    }
    const allowsInterviews = body?.allowsInterviews !== undefined ? !!body.allowsInterviews : existing.allowsInterviews;
    const updated = await withDb((data) => {
      const org = data.organizations.find((o) => o.id === id);
      if (!org) return null;
      if (!sameName(name, org.name) && data.organizations.some((o) => o.id !== id && sameName(o.name, name))) {
        return null;
      }
      Object.assign(org, { name, color, allowsInterviews });
      return org;
    });
    if (!updated) return sendJson(res, 409, { error: 'Ya existe una organización con ese nombre' });
    sendJson(res, 200, updated);
  }));

  router.delete('/api/organizations/:id', requireRole(['admin'], async (req, res, params) => {
    const id = Number(params.id);
    const data0 = load();
    const existing = data0.organizations.find((o) => o.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Organización no encontrada' });
    if (PROTECTED_ORG_NAMES.includes(existing.name)) {
      return sendJson(res, 400, { error: `"${existing.name}" es una organización especial que usa el sistema para asignar permisos — no se puede eliminar` });
    }
    await withDb((data) => {
      data.organizations = data.organizations.filter((o) => o.id !== id);
    });
    sendJson(res, 200, { ok: true });
  }));
}
