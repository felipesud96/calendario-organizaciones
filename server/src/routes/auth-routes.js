import { sendJson } from '../router.js';
import { load, withDb } from '../db.js';
import { hashPassword, verifyPassword, createSession, destroySession, publicUser } from '../auth.js';
import { requireAuth } from '../guard.js';

export function registerAuthRoutes(router) {
  router.post('/api/auth/login', async (req, res, params, body) => {
    const { email, password } = body || {};
    if (!email || !password) {
      return sendJson(res, 400, { error: 'Usuario y contraseña requeridos' });
    }
    const data = load();
    const normalizedEmail = String(email).toLowerCase().trim();
    const user = data.users.find((u) => u.email === normalizedEmail);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      const pending = data.registrationRequests.some((r) => r.email === normalizedEmail);
      if (pending) {
        return sendJson(res, 403, { error: 'Tu solicitud de cuenta está pendiente de aprobación del administrador todavía.' });
      }
      return sendJson(res, 401, { error: 'Credenciales inválidas' });
    }
    const token = await createSession(user.id);
    const org = user.organizationId
      ? data.organizations.find((o) => o.id === user.organizationId)
      : null;
    sendJson(res, 200, { token, user: { ...publicUser(user), organization: org || null } });
  });

  router.post('/api/auth/logout', requireAuth(async (req, res) => {
    await destroySession(req.token);
    sendJson(res, 200, { ok: true });
  }));

  router.get('/api/auth/me', requireAuth(async (req, res) => {
    const data = load();
    const org = req.user.organizationId
      ? data.organizations.find((o) => o.id === req.user.organizationId)
      : null;
    sendJson(res, 200, { ...publicUser(req.user), organization: org || null });
  }));

  // Auto-servicio: cualquier usuario autenticado (típicamente un Miembro)
  // elige qué organizaciones le interesa ver en "Mis Actividades" (por
  // ejemplo, la del cuórum al que pertenece más las de sus hijos). No
  // requiere permiso de administrador porque cada quien edita solo su
  // propia preferencia.
  router.put('/api/auth/me/followed-organizations', requireAuth(async (req, res, params, body) => {
    const data0 = load();
    const validIds = new Set(data0.organizations.map((o) => o.id));
    const raw = body?.followedOrganizationIds;
    const arr = Array.isArray(raw) ? raw : (raw !== undefined && raw !== null ? [raw] : []);
    const followedOrganizationIds = [...new Set(arr.map(Number).filter((id) => Number.isFinite(id) && validIds.has(id)))];
    const updated = await withDb((d) => {
      const u = d.users.find((x) => x.id === req.user.id);
      u.followedOrganizationIds = followedOrganizationIds;
      return u;
    });
    const data = load();
    const org = updated.organizationId ? data.organizations.find((o) => o.id === updated.organizationId) : null;
    sendJson(res, 200, { ...publicUser(updated), organization: org || null });
  }));
}

export { hashPassword };
