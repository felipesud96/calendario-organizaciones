import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireRole } from '../guard.js';
import { hashPassword, publicUser } from '../auth.js';

const VALID_ROLES = ['admin', 'leader', 'member'];

export function registerUserRoutes(router) {
  router.get('/api/users', requireRole(['admin'], async (req, res) => {
    const data = load();
    const users = data.users
      .map((u) => {
        const org = data.organizations.find((o) => o.id === u.organizationId);
        return { ...publicUser(u), organizationName: org?.name || null };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    sendJson(res, 200, users);
  }));

  router.post('/api/users', requireRole(['admin'], async (req, res, params, body) => {
    const { name, email, password, role, organizationId, phone } = body || {};
    if (!name || !email || !password || !role) {
      return sendJson(res, 400, { error: 'Nombre, usuario, contraseña y rol son requeridos' });
    }
    if (!VALID_ROLES.includes(role)) {
      return sendJson(res, 400, { error: 'Rol inválido' });
    }
    if (role === 'leader' && !organizationId) {
      return sendJson(res, 400, { error: 'Los líderes deben pertenecer a una organización' });
    }
    const normalizedEmail = String(email).toLowerCase().trim();
    const data = load();
    if (data.users.some((u) => u.email === normalizedEmail)) {
      return sendJson(res, 409, { error: 'Ya existe un usuario con ese nombre de usuario' });
    }
    const user = await withDb((d) => {
      const u = {
        id: nextId(d, 'users'),
        name,
        email: normalizedEmail,
        passwordHash: hashPassword(password),
        role,
        organizationId: organizationId ? Number(organizationId) : null,
        phone: phone || null,
        createdAt: new Date().toISOString(),
      };
      d.users.push(u);
      return u;
    });
    sendJson(res, 201, publicUser(user));
  }));

  router.put('/api/users/:id', requireRole(['admin'], async (req, res, params, body) => {
    const id = Number(params.id);
    const existing = load().users.find((u) => u.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Usuario no encontrado' });
    if (body.role && !VALID_ROLES.includes(body.role)) {
      return sendJson(res, 400, { error: 'Rol inválido' });
    }
    const updated = await withDb((d) => {
      const u = d.users.find((x) => x.id === id);
      Object.assign(u, {
        name: body.name ?? u.name,
        email: body.email ? String(body.email).toLowerCase().trim() : u.email,
        role: body.role ?? u.role,
        organizationId: body.organizationId !== undefined ? (body.organizationId ? Number(body.organizationId) : null) : u.organizationId,
        phone: body.phone ?? u.phone,
      });
      if (body.password) u.passwordHash = hashPassword(body.password);
      return u;
    });
    sendJson(res, 200, publicUser(updated));
  }));

  router.delete('/api/users/:id', requireRole(['admin'], async (req, res, params) => {
    const id = Number(params.id);
    if (id === req.user.id) {
      return sendJson(res, 400, { error: 'No puedes eliminar tu propio usuario' });
    }
    await withDb((d) => {
      d.users = d.users.filter((u) => u.id !== id);
    });
    sendJson(res, 200, { ok: true });
  }));
}
