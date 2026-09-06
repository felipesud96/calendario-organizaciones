import { sendJson } from '../router.js';
import { load, withDb, nextId, resolveCallingAndPresident, unmarkOtherPresidents } from '../db.js';
import { requireRole } from '../guard.js';
import { hashPassword, publicUser } from '../auth.js';

const VALID_ROLES = ['admin', 'leader', 'member', 'executive_secretary', 'ward_clerk', 'financial_clerk'];

// Punto 28/29/30 (ideas de UX basadas en el Manual General): tres llamamientos
// de apoyo al Obispado, cada uno con una mayordomía bien acotada — a
// propósito NO son "líder de Obispado" (no heredan `isObispadoLeader`, así
// que no ven todas las entrevistas/actas/paneles de todo el Barrio, solo lo
// que les corresponde a cada uno):
//   - executive_secretary (Secretario Ejecutivo): agenda del Obispado en
//     Entrevistas — ver interviews.js.
//   - ward_clerk (Secretario de Barrio): actas de Consejo de Barrio /
//     Coordinación de Ministración — ver meetings.js.
//   - financial_clerk (Secretario de Finanzas): Presupuesto de todas las
//     organizaciones — ver budget.js.
// Los tres, igual que un líder, deben pertenecer a una organización — pero
// siempre a Obispado específicamente, porque es a quien apoyan.
const OBISPADO_STAFF_ROLES = ['executive_secretary', 'ward_clerk', 'financial_clerk'];
const ORG_REQUIRED_ROLES = ['leader', ...OBISPADO_STAFF_ROLES];

function validateStaffOrg(data, role, organizationId) {
  if (!OBISPADO_STAFF_ROLES.includes(role)) return null;
  const org = data.organizations.find((o) => o.id === Number(organizationId));
  if (!org || org.name !== 'Obispado') {
    return 'Este llamamiento de apoyo al Obispado debe asignarse dentro de la organización Obispado';
  }
  return null;
}

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
    if (ORG_REQUIRED_ROLES.includes(role) && !organizationId) {
      return sendJson(res, 400, { error: 'Debe pertenecer a una organización' });
    }
    const normalizedEmail = String(email).toLowerCase().trim();
    const data = load();
    if (data.users.some((u) => u.email === normalizedEmail)) {
      return sendJson(res, 409, { error: 'Ya existe un usuario con ese nombre de usuario' });
    }
    const staffOrgError = validateStaffOrg(data, role, organizationId);
    if (staffOrgError) return sendJson(res, 400, { error: staffOrgError });
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
        // Notificaciones por WhatsApp (CallMeBot): cada persona activa su
        // propia clave gratuita enviándole un mensaje al bot una sola vez —
        // ver "Mi Perfil" en el cliente y whatsapp.js en el servidor.
        whatsappPhone: null,
        whatsappApiKey: null,
        // Recuperación de contraseña self-service por WhatsApp — ver
        // routes/auth-routes.js.
        passwordReset: null,
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
    const data = load();
    const existing = data.users.find((u) => u.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Usuario no encontrado' });
    if (body.role && !VALID_ROLES.includes(body.role)) {
      return sendJson(res, 400, { error: 'Rol inválido' });
    }
    const resolvedRole = body.role ?? existing.role;
    const resolvedOrgId = body.organizationId !== undefined ? body.organizationId : existing.organizationId;
    if (ORG_REQUIRED_ROLES.includes(resolvedRole) && !resolvedOrgId) {
      return sendJson(res, 400, { error: 'Debe pertenecer a una organización' });
    }
    const staffOrgError = validateStaffOrg(data, resolvedRole, resolvedOrgId);
    if (staffOrgError) return sendJson(res, 400, { error: staffOrgError });
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
