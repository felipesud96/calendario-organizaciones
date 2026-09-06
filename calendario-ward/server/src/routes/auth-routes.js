import crypto from 'crypto';
import { sendJson } from '../router.js';
import { load, withDb, resolveCallingAndPresident, unmarkOtherPresidents, PRESIDENT_ORGS } from '../db.js';
import { hashPassword, verifyPassword, createSession, destroySession, publicUser } from '../auth.js';
import { requireAuth, requireRole } from '../guard.js';
import { sendWhatsApp, normalizeWhatsAppPhone, canSendWhatsApp } from '../whatsapp.js';

// ---------------- Recuperación de contraseña, self-service por WhatsApp ----------------
// Pedido explícito del Obispado: que una persona pueda recuperar su propia
// contraseña sin depender de que un Administrador se la restablezca a mano
// (lo que ya existe en Administración → Usuarios y sigue funcionando igual
// como respaldo). Se eligió WhatsApp y no correo porque acá el "Usuario" de
// login casi nunca es un correo real (puede ser algo como
// "sociedad.socorro", ver openUserModal en el cliente) y, además, el correo
// (Gmail) puede estar sin configurar en el servidor — ver email.js. WhatsApp
// usa el mismo CallMeBot que ya usa esta app para recordatorios: solo sirve
// para quien YA vinculó su teléfono + clave en "Mi Perfil" mientras todavía
// tenía acceso (ver whatsapp.js) — quien nunca lo vinculó sigue sin más
// alternativa que pedirle a un Administrador que se la restablezca.
const PASSWORD_RESET_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutos
const PASSWORD_RESET_MAX_ATTEMPTS = 5;

function maskPhoneForDisplay(rawPhone) {
  const digits = normalizeWhatsAppPhone(rawPhone);
  return digits.length >= 4 ? `••• ${digits.slice(-4)}` : '•••';
}

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
      // Notificaciones por WhatsApp (CallMeBot) — cada persona activa y
      // guarda su propia clave desde acá, ver whatsapp.js.
      if (body?.whatsappPhone !== undefined) u.whatsappPhone = String(body.whatsappPhone || '').trim() || null;
      if (body?.whatsappApiKey !== undefined) u.whatsappApiKey = String(body.whatsappApiKey || '').trim() || null;
      return u;
    });
    const data = load();
    const org = updated.organizationId ? data.organizations.find((o) => o.id === updated.organizationId) : null;
    sendJson(res, 200, { ...publicUser(updated), organization: org || null });
  }));

  // Manda un WhatsApp de prueba con lo que la persona tenga guardado en ese
  // momento en su perfil — para que sepa de inmediato si su teléfono/clave
  // de CallMeBot quedaron bien puestos, sin tener que esperar a la próxima
  // entrevista o compromiso de verdad.
  router.post('/api/auth/me/whatsapp-test', requireAuth(async (req, res) => {
    const data = load();
    const user = data.users.find((u) => u.id === req.user.id);
    if (!user?.whatsappPhone || !user?.whatsappApiKey) {
      return sendJson(res, 400, { error: 'Primero guarda tu teléfono y tu clave de CallMeBot' });
    }
    try {
      await sendWhatsApp({
        phone: normalizeWhatsAppPhone(user.whatsappPhone),
        apikey: user.whatsappApiKey,
        text: '✅ ¡Tu WhatsApp quedó conectado a OrganizaSion! Aquí llegarán tus avisos de entrevistas y compromisos.',
      });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: `No se pudo enviar: ${err.message}` });
    }
  }));

  // Paso 1 de la recuperación: pide un código de 6 dígitos y lo manda por
  // WhatsApp — SIN requerir sesión (justamente porque la persona no puede
  // entrar). Nunca revela si el "usuario" que escribieron existe o no de
  // forma distinta a como ya lo hace /auth/login (que tampoco lo distingue
  // de una contraseña incorrecta), salvo por el mensaje explícito de "esta
  // cuenta no tiene WhatsApp vinculado", que es información que la propia
  // persona (dueña de la cuenta) necesita para saber que debe pedirle a un
  // Administrador que se la restablezca en vez de seguir esperando un
  // mensaje que nunca va a llegar.
  router.post('/api/auth/request-password-reset', async (req, res, params, body) => {
    const normalizedEmail = String(body?.email || '').toLowerCase().trim();
    if (!normalizedEmail) return sendJson(res, 400, { error: 'Escribe tu usuario' });
    const data0 = load();
    const user = data0.users.find((u) => u.email === normalizedEmail);
    if (!user) return sendJson(res, 404, { error: 'No encontramos ninguna cuenta con ese usuario' });
    if (!canSendWhatsApp(user)) {
      return sendJson(res, 400, { error: 'Esta cuenta no tiene un WhatsApp vinculado — pide a un Administrador que te restablezca la contraseña desde Administración → Usuarios' });
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    try {
      await sendWhatsApp({
        phone: normalizeWhatsAppPhone(user.whatsappPhone),
        apikey: user.whatsappApiKey,
        text: `Tu código para recuperar tu contraseña en OrganizaSion es: ${code}\nVence en 10 minutos. Si no lo pediste tú, ignora este mensaje.`,
      });
    } catch (err) {
      return sendJson(res, 400, { error: `No se pudo enviar el código por WhatsApp: ${err.message}` });
    }
    await withDb((data) => {
      const u = data.users.find((x) => x.id === user.id);
      u.passwordReset = { code, expiresAt: Date.now() + PASSWORD_RESET_CODE_TTL_MS, attempts: 0 };
    });
    sendJson(res, 200, { ok: true, maskedPhone: maskPhoneForDisplay(user.whatsappPhone) });
  });

  // Paso 2: valida el código y define la contraseña nueva. Igual que arriba,
  // sin sesión. `attempts` limita los intentos de adivinar el código dentro
  // de su ventana de 10 minutos; al agotarse (o vencer el código) hay que
  // volver a pedir uno nuevo desde el paso 1.
  router.post('/api/auth/reset-password', async (req, res, params, body) => {
    const normalizedEmail = String(body?.email || '').toLowerCase().trim();
    const code = String(body?.code || '').trim();
    const newPassword = String(body?.newPassword || '');
    if (!normalizedEmail || !code) return sendJson(res, 400, { error: 'Faltan datos' });
    if (newPassword.length < 6) return sendJson(res, 400, { error: 'La contraseña debe tener al menos 6 caracteres' });
    const data0 = load();
    const user = data0.users.find((u) => u.email === normalizedEmail);
    if (!user || !user.passwordReset) {
      return sendJson(res, 400, { error: 'Primero solicita un código por WhatsApp' });
    }
    if (Date.now() > user.passwordReset.expiresAt) {
      await withDb((data) => { data.users.find((x) => x.id === user.id).passwordReset = null; });
      return sendJson(res, 400, { error: 'El código venció — solicita uno nuevo' });
    }
    if (user.passwordReset.attempts >= PASSWORD_RESET_MAX_ATTEMPTS) {
      await withDb((data) => { data.users.find((x) => x.id === user.id).passwordReset = null; });
      return sendJson(res, 400, { error: 'Demasiados intentos — solicita un código nuevo' });
    }
    if (user.passwordReset.code !== code) {
      await withDb((data) => { data.users.find((x) => x.id === user.id).passwordReset.attempts += 1; });
      return sendJson(res, 400, { error: 'Código incorrecto' });
    }
    await withDb((data) => {
      const u = data.users.find((x) => x.id === user.id);
      u.passwordHash = hashPassword(newPassword);
      u.passwordReset = null;
    });
    // Igual que al iniciar sesión normal: entrega un token de una vez, para
    // que la persona quede adentro de la app sin tener que volver a escribir
    // la contraseña recién elegida.
    const token = await createSession(user.id);
    const data = load();
    const org = user.organizationId ? data.organizations.find((o) => o.id === user.organizationId) : null;
    const freshUser = data.users.find((u) => u.id === user.id);
    sendJson(res, 200, { token, user: { ...publicUser(freshUser), organization: org || null } });
  });

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
