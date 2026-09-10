import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireRole } from '../guard.js';
import { isObispadoLeader } from './stake.js';
import {
  ASISTENCIA_VALUES, computeCuadrante, ageFromBirthDate, categoryFor, isAdultMale, isAdultFemale,
  CONVENIO_STATUS_VALUES, faltaConvenioFromChecklist,
} from '../pastoralFocus.js';
import { parseMemberListPdfBuffer } from '../directoryImport.js';

// Módulo "Directorio" (ahora dentro de "Crecimiento del Barrio") +
// "Enfoque Ministración" (dentro de Estadísticas): la lista de miembros del
// barrio (importada desde el reporte oficial "Lista de miembros" — ver
// seedDirectory.js / directoryImport.js — y editable a mano después, según
// se muevan familias o se detecten datos mal cargados) más el seguimiento
// por cuadrante (Rescatar/Enfoque/Retener/Actividad) de los adultos, con
// historial de cada cambio de categoría en el tiempo.
//
// Ojo: son DOS permisos independientes que viven en el mismo archivo:
//   - El Directorio (Miembros) — ver, editar, agregar, eliminar e
//     importar desde PDF — es TODO exclusivo de Obispado/Administrador
//     (isObispadoLeader, igual que budget.js/stake.js). Antes ver/editar
//     estaba abierto a todo el comité de Bienestar (isWelfareCommitteeMember
//     en welfare.js); el Obispado pidió acotarlo más: "que el directorio
//     esté solo en el perfil líderes obispado y que sea editable los
//     nombres (por si se cargan mal desde la base de datos, por ejemplo sin
//     apellido)". Por eso PUT también quedó en isObispadoLeader.
//   - "Enfoque Ministración" incluye información más sensible todavía
//     (recomendación al templo, convenios pendientes) y arrancó acotada a
//     los líderes de Cuórum de Élderes, viendo solo a los hombres adultos.
//     Se extendió con el MISMO modelo a Sociedad de Socorro, viendo solo a
//     las mujeres adultas — cada presidencia ve y edita solo su mitad; el
//     Obispado/Administrador puede ver y editar ambas (isMinisteringFocusLeaderHombres /
//     isMinisteringFocusLeaderMujeres más abajo).
const ACCESS_ROLES = ['admin', 'leader'];

function forbidden(res) {
  return sendJson(res, 403, {
    error: 'El Directorio es solo para el Obispado y el Administrador',
  });
}

function isMinisteringFocusLeaderHombres(user, data) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'leader') return false;
  const org = data.organizations.find((o) => o.id === Number(user.organizationId));
  return !!org && org.name === 'Cuórum de Élderes';
}

function isMinisteringFocusLeaderMujeres(user, data) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'leader') return false;
  const org = data.organizations.find((o) => o.id === Number(user.organizationId));
  return !!org && org.name === 'Sociedad de Socorro';
}

function forbiddenMinisteringFocus(res) {
  return sendJson(res, 403, {
    error: 'Enfoque Ministración está habilitado solo para los líderes de Cuórum de Élderes (hombres) y Sociedad de Socorro (mujeres)',
  });
}

function withMemberInfo(m) {
  return { ...m, age: ageFromBirthDate(m.birthDate), category: categoryFor(m) };
}

function focusInfo(focus) {
  if (!focus) {
    return {
      asistencia: null, tieneLlamamiento: null, faltaConvenio: null, convenios: null, recomendacionVigente: null,
      cuadrante: null, updatedAt: null, updatedByName: null, history: [],
    };
  }
  return {
    asistencia: focus.asistencia,
    tieneLlamamiento: focus.tieneLlamamiento,
    faltaConvenio: focus.faltaConvenio,
    // Punto 14: detalle granular (Investidura/Sellamiento/Ordenación) — los
    // registros que nunca pasaron por el formulario nuevo quedan en `null`,
    // así el cliente sabe que solo tiene el dato agregado antiguo
    // (faltaConvenio) y muestra el aviso genérico hasta que se actualicen.
    convenios: focus.convenios || null,
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
    if (!isObispadoLeader(req.user, data)) return forbidden(res);
    const items = data.directoryMembers.map(withMemberInfo).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    sendJson(res, 200, items);
  }));

  router.post('/api/directory/members', requireRole(ACCESS_ROLES, async (req, res, params, body) => {
    const data0 = load();
    if (!isObispadoLeader(req.user, data0)) return forbidden(res);
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
    if (!isObispadoLeader(req.user, data0)) return forbidden(res);
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
    if (!isObispadoLeader(req.user, data0)) return forbidden(res);
    if (!data0.directoryMembers.some((m) => m.id === id)) return sendJson(res, 404, { error: 'Persona no encontrada' });
    await withDb((data) => {
      data.directoryMembers = data.directoryMembers.filter((m) => m.id !== id);
      data.pastoralFocus = data.pastoralFocus.filter((p) => p.memberId !== id);
    });
    sendJson(res, 200, { ok: true });
  }));

  // Reimportar el Directorio desde un nuevo PDF oficial "Lista de
  // miembros" (Punto pedido explícitamente: "subir un nuevo PDF y sumar o
  // depurar cual fuere el caso"). Mismo límite de seguridad que el PDF de
  // Crecimiento del Barrio (ver pdfExtract.js): esta ruta SOLO lee el PDF y
  // arma un borrador comparando contra el Directorio actual — nunca
  // escribe nada. El Obispado revisa el borrador en la app (puede destildar
  // cualquier alta o baja que no corresponda — un nombre mal leído o una
  // homonimia no borra a nadie solo) y recién ahí confirma, lo que dispara
  // /api/directory/import/apply con exactamente lo que quedó marcado.
  // Restringido a Obispado/Administrador, igual que el resto del
  // Directorio (ver forbidden más arriba).
  router.post('/api/directory/import/preview', requireRole(ACCESS_ROLES, async (req, res, params, body) => {
    const data = load();
    if (!isObispadoLeader(req.user, data)) return forbidden(res);
    const file = (body?.files || []).find((f) => f.field === 'pdf') || (body?.files || [])[0];
    if (!file || !file.data || !file.data.length) {
      return sendJson(res, 400, { error: 'Subí un archivo PDF' });
    }
    let parsed;
    try {
      parsed = parseMemberListPdfBuffer(file.data);
    } catch (err) {
      console.error('Error al procesar PDF de Directorio:', err);
      return sendJson(res, 200, {
        totalInPdf: 0, expectedCount: null, toAdd: [], toRemove: [], unchangedCount: 0,
        warnings: ['No se pudo procesar el PDF automáticamente.'],
      });
    }
    const currentByName = new Map(data.directoryMembers.map((m) => [m.name, m]));
    const pdfNames = new Set(parsed.people.map((p) => p.name));
    const toAdd = parsed.people.filter((p) => !currentByName.has(p.name));
    const toRemove = data.directoryMembers
      .filter((m) => !pdfNames.has(m.name))
      .map((m) => ({ id: m.id, name: m.name }));
    const unchangedCount = parsed.people.length - toAdd.length;
    sendJson(res, 200, {
      totalInPdf: parsed.people.length,
      expectedCount: parsed.expectedCount,
      warnings: parsed.warnings,
      toAdd,
      toRemove,
      unchangedCount,
    });
  }));

  // Aplica solo lo que el Obispado dejó marcado en la vista previa de
  // arriba — nunca el borrador completo sin revisar.
  router.post('/api/directory/import/apply', requireRole(ACCESS_ROLES, async (req, res, params, body) => {
    const data0 = load();
    if (!isObispadoLeader(req.user, data0)) return forbidden(res);
    const toAdd = Array.isArray(body?.toAdd) ? body.toAdd : [];
    const toRemoveIds = Array.isArray(body?.toRemoveIds) ? body.toRemoveIds.map(Number) : [];
    const result = await withDb((data) => {
      const now = new Date().toISOString();
      let added = 0;
      for (const p of toAdd) {
        const name = String(p?.name || '').trim();
        if (!name) continue;
        data.directoryMembers.push({
          id: nextId(data, 'directoryMembers'),
          name,
          sex: p.sex === 'V' ? 'V' : 'M',
          birthDate: /^\d{4}-\d{2}-\d{2}$/.test(p.birthDate || '') ? p.birthDate : null,
          source: 'import-pdf',
          createdAt: now,
        });
        added += 1;
      }
      let removed = 0;
      if (toRemoveIds.length) {
        const beforeCount = data.directoryMembers.length;
        data.directoryMembers = data.directoryMembers.filter((m) => !toRemoveIds.includes(m.id));
        removed = beforeCount - data.directoryMembers.length;
        data.pastoralFocus = data.pastoralFocus.filter((p) => !toRemoveIds.includes(p.memberId));
      }
      return { added, removed, total: data.directoryMembers.length };
    });
    sendJson(res, 200, { ok: true, ...result });
  }));

  // Enfoque Ministración (cuadrantes) — adultos (18+) de 18 años o más.
  // Cada presidencia ve solo su mitad (Cuórum de Élderes -> hombres,
  // Sociedad de Socorro -> mujeres); Obispado/Administrador ve ambas.
  // Devuelve a TODOS los adultos que le corresponden al que consulta,
  // tengan o no un cuadrante ya cargado (cuadrante: null hasta que alguien
  // ingrese sus 4 datos), para que se vea de un vistazo a quién todavía le
  // falta evaluar.
  router.get('/api/pastoral-focus', requireRole(ACCESS_ROLES, async (req, res) => {
    const data = load();
    const canHombres = isMinisteringFocusLeaderHombres(req.user, data);
    const canMujeres = isMinisteringFocusLeaderMujeres(req.user, data);
    if (!canHombres && !canMujeres) return forbiddenMinisteringFocus(res);
    const items = data.directoryMembers
      .filter((m) => (canHombres && isAdultMale(m)) || (canMujeres && isAdultFemale(m)))
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
    const canHombres = isMinisteringFocusLeaderHombres(req.user, data0);
    const canMujeres = isMinisteringFocusLeaderMujeres(req.user, data0);
    if (!canHombres && !canMujeres) return forbiddenMinisteringFocus(res);
    const member = data0.directoryMembers.find((m) => m.id === memberId);
    if (!member) return sendJson(res, 404, { error: 'Persona no encontrada' });
    const memberIsMale = isAdultMale(member);
    const memberIsFemale = isAdultFemale(member);
    if (!memberIsMale && !memberIsFemale) {
      return sendJson(res, 400, { error: 'El Enfoque Ministración por cuadrantes es solo para adultos (18 años o más)' });
    }
    // Cada presidencia solo puede cargar/editar su propia mitad — el
    // presidente de Cuórum de Élderes no puede tocar el cuadrante de una
    // mujer, ni la presidenta de Sociedad de Socorro el de un hombre
    // (Obispado/Administrador sí puede, porque pasa las dos condiciones).
    if ((memberIsMale && !canHombres) || (memberIsFemale && !canMujeres)) {
      return forbiddenMinisteringFocus(res);
    }
    if (!ASISTENCIA_VALUES.includes(body?.asistencia)) {
      return sendJson(res, 400, { error: 'Asistencia inválida (debe ser Alto, Medio o Bajo)' });
    }
    // Punto 14: convenios granulares — Investidura del templo y Sellamiento
    // aplican a cualquier adulto evaluado (por eso se exigen explícitos, con
    // opción "No aplica" para quien corresponda, ej. Sellamiento de alguien
    // soltero/a); Ordenación al sacerdocio solo aplica a hombres, y se fuerza
    // a 'na' para mujeres sin importar lo que mande el cliente, para que
    // nunca cuente en contra de alguien a quien no le corresponde.
    const rawConvenios = body?.convenios || {};
    if (!CONVENIO_STATUS_VALUES.includes(rawConvenios.investidura) || !CONVENIO_STATUS_VALUES.includes(rawConvenios.sellamiento)) {
      return sendJson(res, 400, { error: 'Falta indicar el estado de Investidura del templo y Sellamiento (Sí / No / No aplica)' });
    }
    if (memberIsMale && !CONVENIO_STATUS_VALUES.includes(rawConvenios.ordenacion)) {
      return sendJson(res, 400, { error: 'Falta indicar el estado de la Ordenación al sacerdocio' });
    }
    const convenios = {
      investidura: rawConvenios.investidura,
      sellamiento: rawConvenios.sellamiento,
      ordenacion: memberIsMale ? rawConvenios.ordenacion : 'na',
    };
    const newValues = {
      asistencia: body.asistencia,
      tieneLlamamiento: !!body.tieneLlamamiento,
      convenios,
      faltaConvenio: faltaConvenioFromChecklist(convenios),
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
      // Se compara el detalle granular completo (no solo el agregado
      // faltaConvenio): así queda registro en el historial aunque el
      // agregado no haya cambiado — ej. antes faltaba Sellamiento y ahora
      // en cambio falta Ordenación, el agregado sigue siendo "falta algo"
      // pero el detalle real cambió y vale la pena que quede trazado.
      const conveniosChanged = JSON.stringify(focus.convenios || null) !== JSON.stringify(newValues.convenios);
      const changed = focus.asistencia !== newValues.asistencia
        || focus.tieneLlamamiento !== newValues.tieneLlamamiento
        || conveniosChanged
        || focus.recomendacionVigente !== newValues.recomendacionVigente;
      if (changed) {
        focus.history = focus.history || [];
        focus.history.push({
          id: nextId(data, 'pastoralFocusHistory'),
          asistencia: focus.asistencia,
          tieneLlamamiento: focus.tieneLlamamiento,
          faltaConvenio: focus.faltaConvenio,
          convenios: focus.convenios || null,
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
