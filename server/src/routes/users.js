import { sendJson } from '../router.js';
import { load, withDb, nextId, resolveCallingAndPresident, unmarkOtherPresidents } from '../db.js';
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

  // Listado liviano (solo id/nombre/organización) para que un líder pueda
  // elegir, al agendar una entrevista, a un miembro ya registrado en el
  // sistema en vez de escribir su nombre a mano.
  router.get('/api/users/directory', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    const users = data.users
      .map((u) => ({ id: u.id, name: u.name, role: u.role, organizationId: u.organizationId }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    sendJson(res, 200, users);
  }));

  router.post('/api/users', requireRole(['admin'], async (req, res, params, body) => {
    const { name, email, password, role, organizationId, phone, birthDate, sex } = body || {};
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
    const { calling, isPresident } = resolveCallingAndPresident(data, {
      organizationId, role, callingInput: body.calling, isPresidentInput: body.isPresident,
    });
    const user = await withDb((d) => {
      const u = {
        id: nextId(d, 'users'),
        name,
        email: normalizedEmail,
        passwordHash: hashPassword(password),
        role,
        organizationId: organizationId ? Number(organizationId) : null,
        phone: phone || null,
        birthDate: birthDate || null,
        sex: (sex === 'M' || sex === 'F') ? sex : null,
        profilePhoto: null,
        isPresident,
        calling,
        interviewAvailability: [],
        createdAt: new Date().toISOString(),
      };
      if (isPresident) unmarkOtherPresidents(d, u.organizationId, u.id);
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
        birthDate: body.birthDate !== undefined ? (body.birthDate || null) : u.birthDate,
        sex: body.sex !== undefined ? ((body.sex === 'M' || body.sex === 'F') ? body.sex : null) : u.sex,
      });
      if (body.password) u.passwordHash = hashPassword(body.password);
      // Solo un líder puede ser presidente, y solo tiene sentido si sigue
      // perteneciendo a una organización; cambiar de rol u organización lo
      // desmarca automáticamente. En las tres organizaciones con llamamiento
      // (Obispado, Cuórum de Élderes, Sociedad de Socorro) `calling` manda
      // sobre `isPresident` — se recalculan juntos cada vez que cambia el
      // rol, la organización, el llamamiento, o (fuera de esas tres
      // organizaciones) el checkbox clásico.
      if (body.calling !== undefined || body.isPresident !== undefined || body.role !== undefined || body.organizationId !== undefined) {
        const { calling, isPresident } = resolveCallingAndPresident(d, {
          organizationId: u.organizationId,
          role: u.role,
          callingInput: body.calling !== undefined ? body.calling : u.calling,
          isPresidentInput: body.isPresident !== undefined ? body.isPresident : u.isPresident,
        });
        u.calling = calling;
        u.isPresident = isPresident;
        if (u.isPresident) unmarkOtherPresidents(d, u.organizationId, u.id);
      }
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
