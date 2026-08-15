// Autorregistro de usuarios: cualquier persona puede pedir una cuenta
// (nombre, usuario, contraseña, y el perfil que cree que le corresponde),
// pero la cuenta queda "pendiente" y no puede ingresar hasta que un
// administrador la apruebe (y de paso pueda corregir el perfil/organización
// si hace falta) desde el panel de Administración → Solicitudes.

import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
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
    const { name, email, password, requestedRole, requestedOrganizationId, phone } = body || {};
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
    const normalizedEmail = String(email).toLowerCase().trim();
    const data = load();
    const taken = data.users.some((u) => u.email === normalizedEmail)
      || data.registrationRequests.some((r) => r.email === normalizedEmail);
    if (taken) {
      return sendJson(res, 409, { error: 'Ese usuario ya existe o ya tiene una solicitud pendiente' });
    }
    await withDb((d) => {
      d.registrationRequests.push({
        id: nextId(d, 'registrationRequests'),
        name,
        email: normalizedEmail,
        passwordHash: hashPassword(password),
        requestedRole,
        requestedOrganizationId: requestedOrganizationId ? Number(requestedOrganizationId) : null,
        phone: phone || null,
        createdAt: new Date().toISOString(),
      });
    });
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
    const user = await withDb((d) => {
      const u = {
        id: nextId(d, 'users'),
        name: finalName,
        email: reqItem.email,
        passwordHash: reqItem.passwordHash,
        role: finalRole,
        organizationId: finalRole === 'leader' ? finalOrgId : null,
        phone: reqItem.phone || null,
        createdAt: new Date().toISOString(),
      };
      d.users.push(u);
      d.registrationRequests = d.registrationRequests.filter((r) => r.id !== id);
      return u;
    });
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
