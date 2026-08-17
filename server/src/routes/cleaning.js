import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireRole } from '../guard.js';
import { isObispadoLeader } from './stake.js';

// Módulo "Aseo del Edificio": estrictamente oculto para Miembros y Líderes
// comunes — solo el Administrador o el líder de Obispado lo pueden ver o
// tocar (misma regla que ya usan Estaca y Presupuesto → isObispadoLeader).

function normalizeSearchText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// Busca una familia ya guardada por nombre (sin importar mayúsculas/tildes);
// si no existe, la crea — así "Familia Pino" queda disponible para
// autocompletar la próxima vez, tal como pide el enunciado.
function findOrCreateFamily(data, rawName) {
  const name = String(rawName || '').trim();
  const norm = normalizeSearchText(name);
  let family = data.families.find((f) => normalizeSearchText(f.name) === norm);
  if (!family) {
    family = { id: nextId(data, 'families'), name, createdAt: new Date().toISOString() };
    data.families.push(family);
  }
  return family;
}

function familyStats(data, familyId) {
  const done = data.cleaningShifts.filter((s) => s.familyId === familyId && s.status === 'done');
  const timesDone = done.length;
  const lastDoneDate = done.length ? done.map((s) => s.date).sort().slice(-1)[0] : null;
  return { timesDone, lastDoneDate };
}

// Reutilizado por routes/stats.js (Panel de "Todo el tiempo") y por
// achievements.js (Rachas y Logros por período) para el ranking "Familia
// con más aseo cumplido" — mismo cálculo que ya usa el módulo de Aseo, sin
// duplicar la lógica (igual que allCategoryRefs en budget.js para el Panel
// de Obispado). `range` es opcional: si viene ({start, end} en formato ISO,
// ambas inclusive), solo cuentan los turnos "Sí fue" cuya fecha caiga
// dentro de ese período — así el mismo cálculo sirve tanto para el
// histórico de siempre como para "este mes/trimestre/semestre/año".
export function allFamiliesWithStats(data, range) {
  const inRange = (date) => !range || (date >= range.start && date <= range.end);
  return data.families
    .map((f) => {
      const done = data.cleaningShifts.filter((s) => s.familyId === f.id && s.status === 'done' && inRange(s.date));
      const timesDone = done.length;
      const lastDoneDate = done.length ? done.map((s) => s.date).sort().slice(-1)[0] : null;
      return { familyId: f.id, familyName: f.name, timesDone, lastDoneDate };
    })
    .filter((f) => f.timesDone > 0)
    .sort((a, b) => b.timesDone - a.timesDone);
}

function withShiftInfo(shift, data) {
  const family = data.families.find((f) => f.id === Number(shift.familyId));
  return {
    ...shift,
    familyName: family?.name || shift.familyName || '(familia eliminada)',
    ...familyStats(data, Number(shift.familyId)),
  };
}

export function registerCleaningRoutes(router) {
  router.get('/api/cleaning/families', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    if (!isObispadoLeader(req.user, data)) return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado pueden ver el módulo de Aseo' });
    const q = normalizeSearchText(req.query.q);
    let families = data.families;
    if (q) families = families.filter((f) => normalizeSearchText(f.name).includes(q));
    const withStats = families
      .map((f) => ({ ...f, ...familyStats(data, f.id) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    sendJson(res, 200, withStats);
  }));

  router.get('/api/cleaning/shifts', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    if (!isObispadoLeader(req.user, data)) return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado pueden ver el módulo de Aseo' });
    const { from, to } = req.query;
    let items = data.cleaningShifts;
    if (from) items = items.filter((s) => s.date >= from);
    if (to) items = items.filter((s) => s.date <= to);
    items = items.map((s) => withShiftInfo(s, data)).sort((a, b) => b.date.localeCompare(a.date));
    sendJson(res, 200, items);
  }));

  // Un turno de aseo es, ante todo, una FECHA (el sábado de aseo) a la que
  // se le puede asignar más de una familia — así el listado no termina
  // teniendo una fila por familia por semana, sino una tarjeta por fecha
  // con todas sus familias adentro. Por eso este endpoint recibe un arreglo
  // "families" en vez de una sola "familyName": crea un registro de turno
  // por cada familia (cada una con su propio estado de cumplimiento), todos
  // compartiendo la misma fecha. Llamarlo de nuevo con la misma fecha y una
  // familia nueva agrega esa familia al turno ya existente de ese sábado
  // (no hace falta un endpoint aparte para "agregar familia a un turno").
  router.post('/api/cleaning/shifts', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const data0 = load();
    if (!isObispadoLeader(req.user, data0)) return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado pueden asignar turnos de aseo' });
    const date = String(body?.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Falta la fecha del turno (el sábado de aseo)' });
    const rawNames = Array.isArray(body?.families) ? body.families : (body?.familyName ? [body.familyName] : []);
    const names = [...new Set(rawNames.map((n) => String(n || '').trim()).filter(Boolean))];
    if (!names.length) return sendJson(res, 400, { error: 'Agrega al menos una familia al turno' });
    const now = new Date().toISOString();
    await withDb((data) => {
      for (const familyName of names) {
        const family = findOrCreateFamily(data, familyName);
        // Evita duplicar a la misma familia dos veces en el mismo turno
        // (por ejemplo, si ya estaba y la vuelven a agregar sin querer).
        const already = data.cleaningShifts.some((s) => s.date === date && Number(s.familyId) === Number(family.id));
        if (already) continue;
        data.cleaningShifts.push({
          id: nextId(data, 'cleaningShifts'),
          date,
          familyId: family.id,
          familyName: family.name,
          status: 'scheduled',
          markedAt: null,
          markedBy: null,
          createdBy: req.user.id,
          createdAt: now,
        });
      }
    });
    const data = load();
    const shiftsForDate = data.cleaningShifts.filter((s) => s.date === date).map((s) => withShiftInfo(s, data));
    sendJson(res, 201, shiftsForDate);
  }));

  router.put('/api/cleaning/shifts/:id', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    if (!isObispadoLeader(req.user, data0)) return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado pueden editar turnos de aseo' });
    const existing = data0.cleaningShifts.find((s) => s.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Turno no encontrado' });
    const date = body?.date !== undefined ? String(body.date).trim() : existing.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Fecha inválida' });
    const familyName = body?.familyName !== undefined ? String(body.familyName).trim() : null;
    if (body?.familyName !== undefined && !familyName) return sendJson(res, 400, { error: 'Falta el nombre de la familia' });
    const updated = await withDb((data) => {
      const s = data.cleaningShifts.find((x) => x.id === id);
      s.date = date;
      if (familyName) {
        const family = findOrCreateFamily(data, familyName);
        s.familyId = family.id;
        s.familyName = family.name;
      }
      return s;
    });
    const data = load();
    sendJson(res, 200, withShiftInfo(data.cleaningShifts.find((s) => s.id === updated.id), data));
  }));

  // Checklist de cumplimiento — botones ✅ (Sí fue) / ❌ (No fue). Solo "Sí
  // fue" suma a la estadística histórica de la familia (familyStats solo
  // cuenta status === 'done').
  router.put('/api/cleaning/shifts/:id/mark', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    if (!isObispadoLeader(req.user, data0)) return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado pueden marcar turnos de aseo' });
    const existing = data0.cleaningShifts.find((s) => s.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Turno no encontrado' });
    const status = body?.status;
    if (!['done', 'not_done', 'scheduled'].includes(status)) return sendJson(res, 400, { error: 'Estado inválido' });
    await withDb((data) => {
      const s = data.cleaningShifts.find((x) => x.id === id);
      s.status = status;
      s.markedAt = status === 'scheduled' ? null : new Date().toISOString();
      s.markedBy = status === 'scheduled' ? null : req.user.id;
    });
    const data = load();
    sendJson(res, 200, withShiftInfo(data.cleaningShifts.find((s) => s.id === id), data));
  }));

  router.delete('/api/cleaning/shifts/:id', requireRole(['admin', 'leader'], async (req, res, params) => {
    const id = Number(params.id);
    const data0 = load();
    if (!isObispadoLeader(req.user, data0)) return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado pueden eliminar turnos de aseo' });
    await withDb((data) => { data.cleaningShifts = data.cleaningShifts.filter((s) => s.id !== id); });
    sendJson(res, 200, { ok: true });
  }));
}
