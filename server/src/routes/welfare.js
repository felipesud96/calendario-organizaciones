import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireRole } from '../guard.js';
import { isObispadoLeader } from './stake.js';

// Módulo "Bienestar" (Punto 51): registro de casos de ayuda temporal
// (alimento, vivienda, empleo, u otro) con un log de seguimiento — quién
// pidió/recibió ayuda, qué se acordó, y qué se hizo después, con fecha.
//
// Visibilidad: el usuario mismo pidió, en sus propias palabras, que esto
// quede MÁS restringido que cualquier otro módulo de la app — "Solo puede
// ver, el Obispado, El presidente del Cuorum y Presidenta de la Soc Soc".
// Esto es más angosto que "cualquier líder de esas organizaciones": debe
// ser específicamente quien preside cada una. Por eso NO se reutiliza
// ninguna noción de "pertenece a Obispado" (los tres llamamientos de apoyo
// — Secretario Ejecutivo, Secretario de Barrio, Secretario de Finanzas —
// tienen organizationId = Obispado pero role !== 'leader', así que ya
// quedan afuera de isObispadoLeader; y de los líderes de Obispado que no
// sean el Obispo igual se los deja entrar porque el Obispado siempre actúa
// como cuerpo colegiado en la app — ver isObispadoLeader en stake.js).
export const WELFARE_COMMITTEE_ORGS = ['Cuórum de Élderes', 'Sociedad de Socorro'];

export function isWelfareCommitteeMember(user, data) {
  if (isObispadoLeader(user, data)) return true;
  if (user.role !== 'leader' || !user.isPresident) return false;
  const org = data.organizations.find((o) => o.id === Number(user.organizationId));
  return !!org && WELFARE_COMMITTEE_ORGS.includes(org.name);
}

export const WELFARE_CATEGORIES = ['alimento', 'vivienda', 'empleo', 'otro'];
export const WELFARE_STATUSES = ['abierto', 'en_seguimiento', 'cerrado'];

function withCaseInfo(c, data) {
  return { ...c, actions: [...(c.actions || [])].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id) };
}

export function registerWelfareRoutes(router) {
  // La capa exterior solo exige estar autenticado como admin/leader (igual
  // que el resto de los módulos "solo Obispado"); el filtro fino de
  // isWelfareCommitteeMember es el que de verdad decide quién entra —
  // cualquier otro líder o el Administrador reciben 403, no un listado
  // vacío, para que quede claro que el módulo existe pero no es para ellos.
  router.get('/api/welfare-cases', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    if (!isWelfareCommitteeMember(req.user, data)) {
      return sendJson(res, 403, { error: 'El módulo de Bienestar es solo para el Obispado, el presidente de Cuórum de Élderes y la presidenta de Sociedad de Socorro' });
    }
    const { status } = req.query;
    let items = data.welfareCases;
    if (status) items = items.filter((c) => c.status === status);
    items = items.map((c) => withCaseInfo(c, data)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    sendJson(res, 200, items);
  }));

  router.get('/api/welfare-cases/:id', requireRole(['admin', 'leader'], async (req, res, params) => {
    const data = load();
    if (!isWelfareCommitteeMember(req.user, data)) {
      return sendJson(res, 403, { error: 'El módulo de Bienestar es solo para el Obispado, el presidente de Cuórum de Élderes y la presidenta de Sociedad de Socorro' });
    }
    const c = data.welfareCases.find((x) => x.id === Number(params.id));
    if (!c) return sendJson(res, 404, { error: 'Caso no encontrado' });
    sendJson(res, 200, withCaseInfo(c, data));
  }));

  router.post('/api/welfare-cases', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const data0 = load();
    if (!isWelfareCommitteeMember(req.user, data0)) {
      return sendJson(res, 403, { error: 'El módulo de Bienestar es solo para el Obispado, el presidente de Cuórum de Élderes y la presidenta de Sociedad de Socorro' });
    }
    const memberName = String(body?.memberName || '').trim();
    if (!memberName) return sendJson(res, 400, { error: 'Falta el nombre de la persona o familia' });
    const category = WELFARE_CATEGORIES.includes(body?.category) ? body.category : 'otro';
    const description = String(body?.description || '').trim();
    const rawMemberUserId = body?.memberUserId;
    const now = new Date().toISOString();
    const created = await withDb((data) => {
      const memberUserId = (rawMemberUserId !== undefined && rawMemberUserId !== null && rawMemberUserId !== '')
        ? (data.users.some((u) => u.id === Number(rawMemberUserId)) ? Number(rawMemberUserId) : null)
        : null;
      const c = {
        id: nextId(data, 'welfareCases'),
        memberName,
        memberUserId,
        category,
        description,
        status: 'abierto',
        actions: [],
        createdBy: req.user.id,
        createdAt: now,
        updatedAt: now,
      };
      data.welfareCases.push(c);
      return c;
    });
    const data = load();
    sendJson(res, 201, withCaseInfo(data.welfareCases.find((c) => c.id === created.id), data));
  }));

  router.put('/api/welfare-cases/:id', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    if (!isWelfareCommitteeMember(req.user, data0)) {
      return sendJson(res, 403, { error: 'El módulo de Bienestar es solo para el Obispado, el presidente de Cuórum de Élderes y la presidenta de Sociedad de Socorro' });
    }
    const existing = data0.welfareCases.find((c) => c.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Caso no encontrado' });
    const memberName = body?.memberName !== undefined ? String(body.memberName).trim() : existing.memberName;
    if (!memberName) return sendJson(res, 400, { error: 'Falta el nombre de la persona o familia' });
    const category = body?.category !== undefined
      ? (WELFARE_CATEGORIES.includes(body.category) ? body.category : existing.category)
      : existing.category;
    const description = body?.description !== undefined ? String(body.description).trim() : existing.description;
    const status = body?.status !== undefined
      ? (WELFARE_STATUSES.includes(body.status) ? body.status : existing.status)
      : existing.status;
    const updated = await withDb((data) => {
      const c = data.welfareCases.find((x) => x.id === id);
      Object.assign(c, { memberName, category, description, status, updatedAt: new Date().toISOString() });
      return c;
    });
    const data = load();
    sendJson(res, 200, withCaseInfo(data.welfareCases.find((c) => c.id === updated.id), data));
  }));

  // Agrega una entrada al log de seguimiento del caso (Manual General 22:
  // el comité de bienestar revisa y da seguimiento a cada caso a lo largo
  // del tiempo, no solo lo abre y lo olvida).
  router.post('/api/welfare-cases/:id/actions', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    if (!isWelfareCommitteeMember(req.user, data0)) {
      return sendJson(res, 403, { error: 'El módulo de Bienestar es solo para el Obispado, el presidente de Cuórum de Élderes y la presidenta de Sociedad de Socorro' });
    }
    if (!data0.welfareCases.some((c) => c.id === id)) return sendJson(res, 404, { error: 'Caso no encontrado' });
    const note = String(body?.note || '').trim();
    if (!note) return sendJson(res, 400, { error: 'Falta la descripción de la acción de seguimiento' });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body?.date) ? body.date : new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    await withDb((data) => {
      const c = data.welfareCases.find((x) => x.id === id);
      c.actions.push({
        id: nextId(data, 'welfareActions'),
        date,
        note,
        createdBy: req.user.id,
        createdAt: now,
      });
      c.updatedAt = now;
    });
    const data = load();
    sendJson(res, 200, withCaseInfo(data.welfareCases.find((c) => c.id === id), data));
  }));

  router.delete('/api/welfare-cases/:id', requireRole(['admin', 'leader'], async (req, res, params) => {
    const id = Number(params.id);
    const data0 = load();
    if (!isWelfareCommitteeMember(req.user, data0)) {
      return sendJson(res, 403, { error: 'El módulo de Bienestar es solo para el Obispado, el presidente de Cuórum de Élderes y la presidenta de Sociedad de Socorro' });
    }
    if (!data0.welfareCases.some((c) => c.id === id)) return sendJson(res, 404, { error: 'Caso no encontrado' });
    await withDb((data) => { data.welfareCases = data.welfareCases.filter((c) => c.id !== id); });
    sendJson(res, 200, { ok: true });
  }));
}
