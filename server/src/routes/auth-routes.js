import { sendJson } from '../router.js';
import { load, withDb, resolveCallingAndPresident, unmarkOtherPresidents, PRESIDENT_ORGS } from '../db.js';
import { hashPassword, verifyPassword, createSession, destroySession, publicUser } from '../auth.js';
import { requireAuth, requireRole } from '../guard.js';

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

  // "Mi Perfil": cualquier usuario autenticado edita sus propios datos —
  // fecha de nacimiento, sexo, teléfono y foto de perfil (el cliente ya la
  // manda comprimida como data URI en base64, ver wireProfilePhotoInput()
  // en app.js). La fecha de nacimiento y el sexo son necesarios para saber
  // con quién se puede agendar una entrevista (ver interviewEligibility()
  // en db.js) — por eso el cliente insiste en pedirlos si faltan, aunque
  // este endpoint en sí no los exige (para no bloquear, por ejemplo, que
  // alguien solo quiera actualizar su foto).
  router.put('/api/auth/me/profile', requireAuth(async (req, res, params, body) => {
    if (body?.sex !== undefined && body.sex !== null && body.sex !== 'M' && body.sex !== 'F') {
      return sendJson(res, 400, { error: 'Sexo inválido' });
    }
    if (body?.birthDate) {
      const d = new Date(`${body.birthDate}T00:00:00`);
      if (Number.isNaN(d.getTime()) || d > new Date()) {
        return sendJson(res, 400, { error: 'Fecha de nacimiento inválida' });
      }
    }
    const updated = await withDb((d) => {
      const u = d.users.find((x) => x.id === req.user.id);
      if (body?.birthDate !== undefined) u.birthDate = body.birthDate || null;
      if (body?.sex !== undefined) u.sex = body.sex || null;
      if (body?.phone !== undefined) u.phone = body.phone || null;
      if (body?.profilePhoto !== undefined) u.profilePhoto = body.profilePhoto || null;
      return u;
    });
    const data = load();
    const org = updated.organizationId ? data.organizations.find((o) => o.id === updated.organizationId) : null;
    sendJson(res, 200, { ...publicUser(updated), organization: org || null });
  }));

  // Agenda semanal de entrevistas (Punto 4, ampliación): un líder declara en
  // qué días/horas de la semana recibe entrevistas normalmente (p. ej.
  // martes y jueves de 20:00 a 22:00). Cualquier Líder o Administrador puede
  // declarar la suya propia — no hace falta ser "el presidente": la
  // presidencia entera puede compartir la responsabilidad de entrevistar,
  // igual que ya pasa al confirmar solicitudes (ver canDecideFor() en
  // interview-requests.js). Reemplaza la lista completa cada vez, más simple
  // que ir agregando/quitando una por una.
  router.put('/api/auth/me/availability', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const raw = Array.isArray(body?.windows) ? body.windows : [];
    const windows = [];
    for (const w of raw) {
      const weekday = Number(w?.weekday);
      const startTime = String(w?.startTime || '');
      const endTime = String(w?.endTime || '');
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        return sendJson(res, 400, { error: 'Día de la semana inválido' });
      }
      if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || startTime >= endTime) {
        return sendJson(res, 400, { error: 'Rango de horas inválido' });
      }
      windows.push({ weekday, startTime, endTime });
    }
    const updated = await withDb((d) => {
      const u = d.users.find((x) => x.id === req.user.id);
      u.interviewAvailability = windows;
      return u;
    });
    const data = load();
    const org = updated.organizationId ? data.organizations.find((o) => o.id === updated.organizationId) : null;
    sendJson(res, 200, { ...publicUser(updated), organization: org || null });
  }));

  // Punto 8 (ampliación): en Obispado, Cuórum de Élderes y Sociedad de
  // Socorro, cualquier líder puede declarar su propio llamamiento
  // (Presidente/Obispo, Consejero o Secretario) — sobre todo pensado para
  // cuentas que ya existían antes de que este campo existiera: el popup
  // obligatorio de "completa tu perfil" lo pide junto con la fecha de
  // nacimiento y el sexo cuando corresponde (ver maybeShowMandatoryProfileModal
  // en el cliente). Igual que con el checkbox "★ Presidente" de siempre,
  // declararse Presidente/Obispo desmarca automáticamente a quien lo fuera
  // antes en esa misma organización — el Administrador puede corregirlo
  // después desde Administración → Usuarios si alguien se equivocó.
  router.put('/api/auth/me/calling', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const data0 = load();
    const org = req.user.organizationId ? data0.organizations.find((o) => o.id === Number(req.user.organizationId)) : null;
    if (!org || !PRESIDENT_ORGS.includes(org.name)) {
      return sendJson(res, 400, { error: 'Tu organización no distingue Presidente/Consejero/Secretario' });
    }
    const { calling, isPresident } = resolveCallingAndPresident(data0, {
      organizationId: req.user.organizationId, role: req.user.role, callingInput: body?.calling, isPresidentInput: false,
    });
    if (!calling) return sendJson(res, 400, { error: 'Llamamiento inválido' });
    const updated = await withDb((d) => {
      const u = d.users.find((x) => x.id === req.user.id);
      u.calling = calling;
      u.isPresident = isPresident;
      if (isPresident) unmarkOtherPresidents(d, u.organizationId, u.id);
      return u;
    });
    const data = load();
    const org2 = updated.organizationId ? data.organizations.find((o) => o.id === updated.organizationId) : null;
    sendJson(res, 200, { ...publicUser(updated), organization: org2 || null });
  }));
}

export { hashPassword };
