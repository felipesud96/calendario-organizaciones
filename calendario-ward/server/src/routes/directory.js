import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireRole } from '../guard.js';
import { isWelfareCommitteeMember } from './welfare.js';
import {
  ASISTENCIA_VALUES, computeCuadrante, ageFromBirthDate, categoryFor, isAdultMale,
} from '../pastoralFocus.js';

// Módulo "Directorio" + "Enfoque Ministración" (dentro de Estadísticas): la
// lista de miembros del barrio (importada una vez desde el reporte oficial
// "Lista de miembros" — ver seedDirectory.js — y editable a mano después,
// según se muevan familias) más el seguimiento por cuadrante
// (Rescatar/Enfoque/Retener/Actividad) de los hombres adultos, con
// historial de cada cambio de categoría en el tiempo.
//
// Ojo: son DOS permisos independientes que viven en el mismo archivo desde
// que se separaron (antes eran una sola pestaña "Directorio y Enfoque
// Pastoral" con un único público):
//   - El Directorio (Miembros) sigue con el público restringido original,
//     el mismo de Bienestar — Obispado, presidente de Cuórum de Élderes,
//     presidenta de Sociedad de Socorro — vía isWelfareCommitteeMember
//     (welfare.js), sin cambios.
//   - "Enfoque Ministración" (antes "Enfoque Pastoral") incluye información
//     más sensible todavía (recomendación al templo, convenios pendientes)
//     y el Obispado pidió explícitamente acotarlo, por ahora, SOLO a los
//     líderes de Cuórum de Élderes (toda la presidencia, no solo el
//     presidente) — ni el resto del Obispado ni Sociedad de Socorro lo ven
//     todavía. Ver isMinisteringFocusLeader más abajo.
const ACCESS_ROLES = ['admin', 'leader'];

function forbidden(res) {
  return sendJson(res, 403, {
    error: 'El Directorio es solo para el Obispado, el presidente de Cuórum de Élderes y la presidenta de Sociedad de Socorro',
  });
}

function isMinisteringFocusLeader(user, data) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'leader') return false;
  const org = data.organizations.find((o) => o.id === Number(user.organizationId));
  return !!org && org.name === 'Cuórum de Élderes';
}

function forbiddenMinisteringFocus(res) {
  return sendJson(res, 403, {
    error: 'Enfoque Ministración está habilitado por ahora solo para los líderes de Cuórum de Élderes',
  });
}

function withMemberInfo(m) {
  return { ...m, age: ageFromBirthDate(m.birthDate), category: categoryFor(m) };
}

function focusInfo(focus) {
  if (!focus) {
    return {
      asistencia: null, tieneLlamamiento: null, faltaConvenio: null, recomendacionVigente: null,
      cuadrante: null, updatedAt: null, updatedByName: null, history: [],
    };
  }
  return {
    asistencia: focus.asistencia,
    tieneLlamamiento: focus.tieneLlamamiento,
    faltaConvenio: focus.faltaConvenio,
    recomendacionVigente: focus.recomendacionVigente,
    cuadrante: computeCuadrante(focus),
    updatedAt: focus.updatedAt,
    updatedByName: focus.updatedByName,
    history: [...(focus.history || [])].sort((a, b) => b.changedAt.localeCompare(a.changedAt)),
  };
}

export function registerDirectoryRoutes(router) {
  router.get('/api/directory/members', requireRole(ACCESS_ROLES, async (req, res) => {
    const data = load();
    if (!isWelfareCommitteeMember(req.user, data)) return forbidden(res);
    const items = data.directoryMembers.map(withMemberInfo).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    sendJson(res, 200, items);
  }));

  router.post('/api/directory/members', requireRole(ACCESS_ROLES, async (req, res, params, body) => {
    const data0 = load();
    if (!isWelfareCommitteeMember(req.user, data0)) return forbidden(res);
    const name = String(body?.name || '').trim();
    if (!name) return sendJson(res, 400, { error: 'Falta el nombre' });
    const sex = body?.sex === 'V' ? 'V' : 'M';
    const birthDate = /^\d{4}-\d{2}-\d{2}$/.test(body?.birthDate || '') ? body.birthDate : null;
    const created = await withDb((data) => {
      const m = {
        id: nextId(data, 'directoryMembers'), name, sex, birthDate,
        source: 'manual', createdAt: new Date().toISOString(),
      };
      data.directoryMembers.push(m);
      return m;
    });
    sendJson(res, 201, withMemberInfo(created));
  }));

  router.put('/api/directory/members/:id', requireRole(ACCESS_ROLES, async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    if (!isWelfareCommitteeMember(req.user, data0)) return forbidden(res);
    if (!data0.directoryMembers.some((m) => m.id === id)) return sendJson(res, 404, { error: 'Persona no encontrada' });
    if (body?.name !== undefined && !String(body.name).trim()) {
      return sendJson(res, 400, { error: 'Falta el nombre' });
    }
    const updated = await withDb((data) => {
      const m = data.directoryMembers.find((x) => x.id === id);
      if (body?.name !== undefined) m.name = String(body.name).trim();
      if (body?.sex !== undefined) m.sex = body.sex === 'V' ? 'V' : 'M';
      if (body?.birthDate !== undefined) {
        m.birthDate = /^\d{4}-\d{2}-\d{2}$/.test(body.birthDate || '') ? body.birthDate : null;
      }
      return m;
    });
    sendJson(res, 200, withMemberInfo(updated));
  }));

  router.delete('/api/directory/members/:id', requireRole(ACCESS_ROLES, async (req, res, params) => {
    const id = Number(params.id);
    const data0 = load();
    if (!isWelfareCommitteeMember(req.user, data0)) return forbidden(res);
    if (!data0.directoryMembers.some((m) => m.id === id)) return sendJson(res, 404, { error: 'Persona no encontrada' });
    await withDb((data) => {
      data.directoryMembers = data.directoryMembers.filter((m) => m.id !== id);
      data.pastoralFocus = data.pastoralFocus.filter((p) => p.memberId !== id);
    });
    sendJson(res, 200, { ok: true });
  }));

  // Enfoque Ministración (cuadrantes) — solo hombres de 18 años o más.
  // Devuelve a TODOS los hombres adultos del directorio, tengan o no un
  // cuadrante ya cargado (cuadrante: null hasta que alguien ingrese sus 4
  // datos), para que se vea de un vistazo a quién todavía le falta evaluar.
  router.get('/api/pastoral-focus', requireRole(ACCESS_ROLES, async (req, res) => {
    const data = load();
    if (!isMinisteringFocusLeader(req.user, data)) return forbiddenMinisteringFocus(res);
    const items = data.directoryMembers
      .filter(isAdultMale)
      .map((m) => ({
        member: withMemberInfo(m),
        ...focusInfo(data.pastoralFocus.find((p) => p.memberId === m.id)),
      }))
      .sort((a, b) => a.member.name.localeCompare(b.member.name, 'es'));
    sendJson(res, 200, items);
  }));

  // Actualiza los 4 datos de una persona y recalcula su cuadrante con la
  // MISMA fórmula que la planilla Excel (ver pastoralFocus.js). Si ya
  // existía una evaluación previa y algo cambió, esa evaluación anterior
  // queda guardada en `history` — así se puede ver cuándo y cómo fue
  // cambiando cada persona de cuadrante en el tiempo.
  router.put('/api/pastoral-focus/:memberId', requireRole(ACCESS_ROLES, async (req, res, params, body) => {
    const memberId = Number(params.memberId);
    const data0 = load();
    if (!isMinisteringFocusLeader(req.user, data0)) return forbiddenMinisteringFocus(res);
    const member = data0.directoryMembers.find((m) => m.id === memberId);
    if (!member) return sendJson(res, 404, { error: 'Persona no encontrada' });
    if (!isAdultMale(member)) {
      return sendJson(res, 400, { error: 'El Enfoque Ministración por cuadrantes es solo para hombres de 18 años o más' });
    }
    if (!ASISTENCIA_VALUES.includes(body?.asistencia)) {
      return sendJson(res, 400, { error: 'Asistencia inválida (debe ser Alto, Medio o Bajo)' });
    }
    const newValues = {
      asistencia: body.asistencia,
      tieneLlamamiento: !!body.tieneLlamamiento,
      faltaConvenio: !!body.faltaConvenio,
      recomendacionVigente: !!body.recomendacionVigente,
    };
    const now = new Date().toISOString();
    await withDb((data) => {
      let focus = data.pastoralFocus.find((p) => p.memberId === memberId);
      if (!focus) {
        focus = {
          id: nextId(data, 'pastoralFocus'), memberId, ...newValues,
          updatedAt: now, updatedBy: req.user.id, updatedByName: req.user.name, history: [],
        };
        data.pastoralFocus.push(focus);
        return;
      }
      const changed = focus.asistencia !== newValues.asistencia
        || focus.tieneLlamamiento !== newValues.tieneLlamamiento
        || focus.faltaConvenio !== newValues.faltaConvenio
        || focus.recomendacionVigente !== newValues.recomendacionVigente;
      if (changed) {
        focus.history = focus.history || [];
        focus.history.push({
          id: nextId(data, 'pastoralFocusHistory'),
          asistencia: focus.asistencia,
          tieneLlamamiento: focus.tieneLlamamiento,
          faltaConvenio: focus.faltaConvenio,
          recomendacionVigente: focus.recomendacionVigente,
          cuadrante: computeCuadrante(focus),
          changedAt: now,
          changedBy: req.user.id,
          changedByName: req.user.name,
        });
      }
      Object.assign(focus, newValues, { updatedAt: now, updatedBy: req.user.id, updatedByName: req.user.name });
    });
    const data = load();
    const m = data.directoryMembers.find((x) => x.id === memberId);
    sendJson(res, 200, {
      member: withMemberInfo(m),
      ...focusInfo(data.pastoralFocus.find((p) => p.memberId === memberId)),
    });
  }));
}
