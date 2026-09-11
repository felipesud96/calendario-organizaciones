// Autorregistro de usuarios: cualquier persona puede pedir una cuenta
// (nombre, usuario, contraseña, y el perfil que cree que le corresponde),
// pero la cuenta queda "pendiente" y no puede ingresar hasta que un
// administrador la apruebe (y de paso pueda corregir el perfil/organización
// si hace falta) desde el panel de Administración → Solicitudes.

import { sendJson } from '../router.js';
import { load, withDb, nextId, resolveCallingAndPresident, unmarkOtherPresidents, PRESIDENT_ORGS } from '../db.js';
import { requireRole } from '../guard.js';
import { hashPassword, publicUser } from '../auth.js';

// Nadie puede autoasignarse "admin" desde el formulario público.
const REQUESTABLE_ROLES = ['member', 'leader'];
const VALID_FINAL_ROLES = ['admin', 'leader', 'member'];

function withRequestOrgInfo(item, orgs) {
  const org = orgs.find((o) => o.id === item.requestedOrganizationId);
  // nunca se expone el passwordHash almacenado, ni al propio panel de admin
  const { passwordHash, ...rest } = item;
  return { ...rest, organizationName: org?.name || null };
}

export function registerRegistrationRoutes(router) {
  // Público: lista mínima de organizaciones para el selector del formulario
  // de registro (antes de iniciar sesión no hay token todavía).
  router.get('/api/public/organizations', async (req, res) => {
    const data = load();
    const orgs = [...data.organizations]
      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
      .map((o) => ({ id: o.id, name: o.name, color: o.color }));
    sendJson(res, 200, orgs);
  });

  router.post('/api/auth/register', async (req, res, params, body) => {
    const { name, email, password, requestedRole, requestedOrganizationId, phone, birthDate, sex, requestedCalling } = body || {};
    if (!name || !email || !password || !requestedRole) {
      return sendJson(res, 400, { error: 'Nombre, usuario, contraseña y perfil son requeridos' });
    }
    if (!REQUESTABLE_ROLES.includes(requestedRole)) {
      return sendJson(res, 400, { error: 'Perfil inválido' });
    }
    if (requestedRole === 'leader' && !requestedOrganizationId) {
      return sendJson(res, 400, { error: 'Selecciona qué organización vas a liderar' });
    }
    if (String(password).length < 6) {
      return sendJson(res, 400, { error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    // Punto 8 (ampliación): si va a liderar Obispado, Cuórum de Élderes o
    // Sociedad de Socorro, tiene que decir de entrada si es el
    // presidente/Obispo, un consejero o el secretario — el Administrador
    // puede corregirlo al aprobar, pero es información que ya conviene
    // pedir de una vez (igual que la fecha de nacimiento y el sexo).
    let requestedCallingValue = null;
    if (requestedRole === 'leader' && requestedOrganizationId) {
      const data0 = load();
      const org0 = data0.organizations.find((o) => o.id === Number(requestedOrganizationId));
      if (org0 && PRESIDENT_ORGS.includes(org0.name)) {
        if (!['Presidente', 'Consejero', 'Secretario'].includes(requestedCalling)) {
          return sendJson(res, 400, { error: 'Indica si es el Presidente/Obispo, un Consejero o el Secretario' });
        }
        requestedCallingValue = requestedCalling;
      }
    }
    // Punto 4 (ampliación): la fecha de nacimiento y el sexo son requeridos
    // desde el registro — se necesitan para saber con quién se puede
    // agendar una entrevista (ver interviewEligibility() en db.js).
    if (!birthDate || Number.isNaN(new Date(`${birthDate}T00:00:00`).getTime())) {
      return sendJson(res, 400, { error: 'Falta la fecha de nacimiento' });
    }
    if (sex !== 'M' && sex !== 'F') {
      return sendJson(res, 400, { error: 'Falta el sexo' });
    }
    const normalizedEmail = String(email).toLowerCase().trim();
    const data = load();
    const taken = data.users.some((u) => u.email === normalizedEmail)
      || data.registrationRequests.some((r) => r.email === normalizedEmail);
    if (taken) {
      return sendJson(res, 409, { error: 'Ese usuario ya existe o ya tiene una solicitud pendiente' });
    }
    // Corrección (revisión de código): la verificación de arriba corre sobre
    // `data`, tomada antes de entrar a withDb — dos registros casi
    // simultáneos con el mismo usuario/email podían pasar ambos esa
    // verificación y quedar dos solicitudes pendientes duplicadas (o una
    // solicitud duplicando una cuenta ya activa). Se vuelve a verificar
    // adentro del callback (que sí serializa) antes de crear la solicitud.
    const created = await withDb((d) => {
      const stillTaken = d.users.some((u) => u.email === normalizedEmail)
        || d.registrationRequests.some((r) => r.email === normalizedEmail);
      if (stillTaken) return false;
      d.registrationRequests.push({
        id: nextId(d, 'registrationRequests'),
        name,
        email: normalizedEmail,
        passwordHash: hashPassword(password),
        requestedRole,
        requestedOrganizationId: requestedOrganizationId ? Number(requestedOrganizationId) : null,
        requestedCalling: requestedCallingValue,
        phone: phone || null,
        birthDate,
        sex,
        createdAt: new Date().toISOString(),
      });
      return true;
    });
    if (!created) return sendJson(res, 409, { error: 'Ese usuario ya existe o ya tiene una solicitud pendiente' });
    sendJson(res, 201, { ok: true, message: 'Tu solicitud fue enviada. Un administrador debe aprobarla antes de que puedas ingresar.' });
  });

  router.get('/api/registration-requests', requireRole(['admin'], async (req, res) => {
    const data = load();
    const items = data.registrationRequests
      .map((r) => withRequestOrgInfo(r, data.organizations))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    sendJson(res, 200, items);
  }));

  // El admin puede aprobar tal cual, o ajustar nombre/perfil/organización
  // antes de aprobar (por si la persona se equivocó al elegir su perfil).
  router.post('/api/registration-requests/:id/approve', requireRole(['admin'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data = load();
    const reqItem = data.registrationRequests.find((r) => r.id === id);
    if (!reqItem) return sendJson(res, 404, { error: 'Solicitud no encontrada' });

    const finalRole = (body && body.role) || reqItem.requestedRole;
    if (!VALID_FINAL_ROLES.includes(finalRole)) {
      return sendJson(res, 400, { error: 'Rol inválido' });
    }
    const finalOrgId = body && body.organizationId !== undefined
      ? (body.organizationId ? Number(body.organizationId) : null)
      : reqItem.requestedOrganizationId;
    const finalName = (body && body.name) || reqItem.name;
    if (finalRole === 'leader' && !finalOrgId) {
      return sendJson(res, 400, { error: 'Los líderes deben pertenecer a una organización' });
    }
    if (data.users.some((u) => u.email === reqItem.email)) {
      await withDb((d) => { d.registrationRequests = d.registrationRequests.filter((r) => r.id !== id); });
      return sendJson(res, 409, { error: 'Ya existe un usuario activo con ese nombre de usuario; la solicitud fue descartada' });
    }
    // El Administrador puede corregir el llamamiento que la persona pidió
    // (o declarar uno si no se pidió ninguno, ej. porque cambió de
    // organización al aprobar) — misma regla que Administración → Usuarios.
    const { calling, isPresident } = resolveCallingAndPresident(data, {
      organizationId: finalRole === 'leader' ? finalOrgId : null,
      role: finalRole,
      callingInput: (body && body.calling !== undefined) ? body.calling : reqItem.requestedCalling,
      isPresidentInput: body && body.isPresident,
    });
    // Corrección (revisión de código): las dos verificaciones de arriba
    // (existe un usuario con ese email, la solicitud existe) corren sobre
    // `data`, tomada antes de entrar a withDb — dos aprobaciones casi
    // simultáneas de la misma solicitud (doble clic, o dos administradores
    // aprobando a la vez) podían pasar ambas esa verificación y crear DOS
    // cuentas de usuario para una sola solicitud. Se vuelve a verificar
    // adentro del callback antes de crear la cuenta.
    const user = await withDb((d) => {
      const stillPending = d.registrationRequests.some((r) => r.id === id);
      if (!stillPending) return null;
      if (d.users.some((u) => u.email === reqItem.email)) return null;
      const u = {
        id: nextId(d, 'users'),
        name: finalName,
        email: reqItem.email,
        passwordHash: reqItem.passwordHash,
        role: finalRole,
        organizationId: finalRole === 'leader' ? finalOrgId : null,
        phone: reqItem.phone || null,
        birthDate: reqItem.birthDate || null,
        sex: reqItem.sex || null,
        profilePhoto: null,
        isPresident,
        calling,
        interviewAvailability: [],
        whatsappPhone: null,
        whatsappApiKey: null,
        passwordReset: null,
        createdAt: new Date().toISOString(),
      };
      if (isPresident) unmarkOtherPresidents(d, u.organizationId, u.id);
      d.users.push(u);
      d.registrationRequests = d.registrationRequests.filter((r) => r.id !== id);
      return u;
    });
    if (!user) return sendJson(res, 409, { error: 'Esta solicitud ya no está disponible — puede que ya haya sido aprobada, o que ya exista una cuenta activa con ese usuario' });
    sendJson(res, 201, publicUser(user));
  }));

  router.delete('/api/registration-requests/:id', requireRole(['admin'], async (req, res, params) => {
    const id = Number(params.id);
    await withDb((d) => {
      d.registrationRequests = d.registrationRequests.filter((r) => r.id !== id);
    });
    sendJson(res, 200, { ok: true });
  }));
}
