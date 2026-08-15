import { sendJson } from '../router.js';
import { load, withDb } from '../db.js';
import { hashPassword, verifyPassword, createSession, destroySession, publicUser } from '../auth.js';
import { requireAuth } from '../guard.js';

export function registerAuthRoutes(router) {
  router.post('/api/auth/login', async (req, res, params, body) => {
    const { email, password } = body || {};
    if (!email || !password) {
      return sendJson(res, 400, { error: 'Email y contraseña requeridos' });
    }
    const data = load();
    const user = data.users.find((u) => u.email === String(email).toLowerCase().trim());
    if (!user || !verifyPassword(password, user.passwordHash)) {
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
}

export { hashPassword };
