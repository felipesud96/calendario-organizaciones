import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireRole } from '../guard.js';
import { currentQuarter, quarterOf, isValidQuarter } from '../quarter.js';

// El módulo de Presupuesto es solo para Líderes y el Administrador — los
// Miembros no lo ven en absoluto (ni siquiera la pestaña aparece).

function isObispadoLeader(user, data) {
  if (user.role === 'admin') return true;
  if (user.role !== 'leader') return false;
  const org = data.organizations.find((o) => o.id === Number(user.organizationId));
  return !!org && org.name === 'Obispado';
}

// Una "categoría" de presupuesto es o bien una organización del barrio, o
// bien una categoría personalizada creada por Obispado (ej. "Actividades de
// Barrio", para gastos que no pertenecen a una sola organización).
function categoryRefsEqual(a, b) {
  if (a.categoryType !== b.categoryType) return false;
  if (a.categoryType === 'organization') return Number(a.organizationId) === Number(b.organizationId);
  return Number(a.budgetCategoryId) === Number(b.budgetCategoryId);
}

export function allCategoryRefs(data) {
  return [
    ...data.organizations.map((o) => ({ categoryType: 'organization', organizationId: o.id, budgetCategoryId: null })),
    ...data.budgetCategories.map((c) => ({ categoryType: 'custom', organizationId: null, budgetCategoryId: c.id })),
  ];
}

// Solo el líder de Obispado (o el administrador) puede asignar presupuesto o
// crear categorías nuevas — es la "opción de distribución" del enunciado.
// Para REGISTRAR GASTOS, en cambio, cada líder solo puede hacerlo en la
// categoría de su propia organización; el líder de Obispado además puede
// hacerlo en cualquier categoría personalizada (de todo el barrio), pero no
// en la organización de otro líder.
function canOperateOnCategory(user, data, ref) {
  if (user.role === 'admin') return true;
  if (user.role !== 'leader') return false;
  if (ref.categoryType === 'organization') return Number(ref.organizationId) === Number(user.organizationId);
  return isObispadoLeader(user, data);
}

function withCategoryInfo(ref, data) {
  if (ref.categoryType === 'organization') {
    const org = data.organizations.find((o) => o.id === Number(ref.organizationId));
    return {
      categoryType: 'organization', organizationId: ref.organizationId, budgetCategoryId: null,
      categoryName: org?.name || '(organización eliminada)', categoryColor: org?.color || '#999999',
    };
  }
  const cat = data.budgetCategories.find((c) => c.id === Number(ref.budgetCategoryId));
  return {
    categoryType: 'custom', organizationId: null, budgetCategoryId: ref.budgetCategoryId,
    categoryName: cat?.name || '(categoría eliminada)', categoryColor: '#8b6fd6',
  };
}

function withExpenseInfo(expense, data) {
  const event = expense.eventId ? data.events.find((e) => e.id === Number(expense.eventId)) : null;
  const registeredByUser = data.users.find((u) => u.id === Number(expense.registeredBy));
  return { ...expense, eventTitle: event ? event.title : null, registeredByName: registeredByUser ? registeredByUser.name : '' };
}

export function summaryFor(data, quarter, ref) {
  const alloc = data.budgetAllocations.find((a) => a.quarter === quarter && categoryRefsEqual(a, ref));
  const expenses = data.budgetExpenses
    .filter((e) => e.quarter === quarter && categoryRefsEqual(e, ref))
    .sort((a, b) => (b.date + String(b.id)).localeCompare(a.date + String(a.id)));
  const spent = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  const assigned = alloc ? Number(alloc.amount) : 0;
  return {
    ...withCategoryInfo(ref, data),
    assigned,
    spent,
    balance: assigned - spent,
    hasAllocation: !!alloc,
    expenses: expenses.map((e) => withExpenseInfo(e, data)),
  };
}

function parseAmount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

export function registerBudgetRoutes(router) {
  // Trimestres con algún dato (asignación o gasto), más el actual siempre
  // incluido — para poblar el selector de trimestre en el cliente.
  router.get('/api/budget/quarters', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    const set = new Set([currentQuarter()]);
    data.budgetAllocations.forEach((a) => set.add(a.quarter));
    data.budgetExpenses.forEach((e) => set.add(e.quarter));
    sendJson(res, 200, { quarters: [...set].sort().reverse(), currentQuarter: currentQuarter() });
  }));

  router.get('/api/budget/categories', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    sendJson(res, 200, {
      organizations: data.organizations.map((o) => ({ id: o.id, name: o.name, color: o.color })),
      custom: data.budgetCategories,
    });
  }));

  router.post('/api/budget/categories', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const data0 = load();
    if (!isObispadoLeader(req.user, data0)) {
      return sendJson(res, 403, { error: 'Solo el líder de Obispado puede crear categorías de presupuesto' });
    }
    const name = String(body?.name || '').trim();
    if (!name) return sendJson(res, 400, { error: 'Falta el nombre de la categoría' });
    if (data0.budgetCategories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      return sendJson(res, 409, { error: 'Ya existe una categoría con ese nombre' });
    }
    const cat = await withDb((d) => {
      const c = { id: nextId(d, 'budgetCategories'), name, createdBy: req.user.id, createdAt: new Date().toISOString() };
      d.budgetCategories.push(c);
      return c;
    });
    sendJson(res, 201, cat);
  }));

  router.delete('/api/budget/categories/:id', requireRole(['admin', 'leader'], async (req, res, params) => {
    const data0 = load();
    if (!isObispadoLeader(req.user, data0)) {
      return sendJson(res, 403, { error: 'Solo el líder de Obispado puede eliminar categorías de presupuesto' });
    }
    const id = Number(params.id);
    if (!data0.budgetCategories.some((c) => c.id === id)) {
      return sendJson(res, 404, { error: 'Categoría no encontrada' });
    }
    // Las asignaciones y gastos históricos de esta categoría NO se borran —
    // quedan a modo de consulta (se muestran como "(categoría eliminada)").
    await withDb((d) => { d.budgetCategories = d.budgetCategories.filter((c) => c.id !== id); });
    sendJson(res, 200, { ok: true });
  }));

  // Vista principal del módulo. Para el líder de Obispado (o admin): todas
  // las categorías (cada organización + las personalizadas) con su
  // asignación/gastos/saldo del trimestre pedido. Para cualquier otro
  // líder: solo la categoría de su propia organización.
  router.get('/api/budget', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    const quarter = isValidQuarter(req.query.quarter) ? req.query.quarter : currentQuarter();
    const isObispado = isObispadoLeader(req.user, data);
    const refs = isObispado
      ? allCategoryRefs(data)
      : [{ categoryType: 'organization', organizationId: req.user.organizationId, budgetCategoryId: null }];
    sendJson(res, 200, {
      quarter,
      isCurrentQuarter: quarter === currentQuarter(),
      isObispado,
      categories: refs.map((ref) => summaryFor(data, quarter, ref)),
    });
  }));

  router.put('/api/budget/allocations', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const data0 = load();
    if (!isObispadoLeader(req.user, data0)) {
      return sendJson(res, 403, { error: 'Solo el líder de Obispado puede asignar presupuesto' });
    }
    const quarter = body?.quarter;
    if (quarter !== currentQuarter()) {
      return sendJson(res, 400, { error: 'Solo se puede asignar presupuesto para el trimestre actual' });
    }
    const ref = { categoryType: body?.categoryType, organizationId: body?.organizationId ?? null, budgetCategoryId: body?.budgetCategoryId ?? null };
    if (ref.categoryType === 'organization' && !data0.organizations.some((o) => o.id === Number(ref.organizationId))) {
      return sendJson(res, 400, { error: 'Organización inválida' });
    }
    if (ref.categoryType === 'custom' && !data0.budgetCategories.some((c) => c.id === Number(ref.budgetCategoryId))) {
      return sendJson(res, 400, { error: 'Categoría inválida' });
    }
    if (!['organization', 'custom'].includes(ref.categoryType)) {
      return sendJson(res, 400, { error: 'Tipo de categoría inválido' });
    }
    const amount = parseAmount(body?.amount);
    if (amount === null) return sendJson(res, 400, { error: 'Monto inválido' });
    const now = new Date().toISOString();
    await withDb((d) => {
      const existing = d.budgetAllocations.find((a) => a.quarter === quarter && categoryRefsEqual(a, ref));
      if (existing) {
        existing.amount = amount;
        existing.updatedAt = now;
        existing.setBy = req.user.id;
      } else {
        d.budgetAllocations.push({
          id: nextId(d, 'budgetAllocations'), quarter,
          categoryType: ref.categoryType, organizationId: ref.organizationId, budgetCategoryId: ref.budgetCategoryId,
          amount, setBy: req.user.id, createdAt: now, updatedAt: now,
        });
      }
    });
    const data = load();
    sendJson(res, 200, summaryFor(data, quarter, ref));
  }));

  router.post('/api/budget/expenses', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const data0 = load();
    const ref = { categoryType: body?.categoryType, organizationId: body?.organizationId ?? null, budgetCategoryId: body?.budgetCategoryId ?? null };
    if (!canOperateOnCategory(req.user, data0, ref)) {
      return sendJson(res, 403, { error: 'No tienes permiso para registrar gastos en esta categoría' });
    }
    const description = String(body?.description || '').trim();
    const date = body?.date;
    if (!description || !date) return sendJson(res, 400, { error: 'Faltan campos requeridos (descripción, fecha)' });
    const amount = parseAmount(body?.amount);
    if (amount === null || amount <= 0) return sendJson(res, 400, { error: 'Monto inválido' });
    const quarter = quarterOf(date);
    if (quarter !== currentQuarter()) {
      return sendJson(res, 400, { error: 'Solo se pueden registrar gastos del trimestre actual (fecha dentro del trimestre en curso)' });
    }
    if (ref.categoryType === 'organization' && !data0.organizations.some((o) => o.id === Number(ref.organizationId))) {
      return sendJson(res, 400, { error: 'Organización inválida' });
    }
    if (ref.categoryType === 'custom' && !data0.budgetCategories.some((c) => c.id === Number(ref.budgetCategoryId))) {
      return sendJson(res, 400, { error: 'Categoría inválida' });
    }
    let eventId = null;
    if (body?.eventId) {
      const ev = data0.events.find((e) => e.id === Number(body.eventId));
      eventId = ev ? ev.id : null;
    }
    const now = new Date().toISOString();
    const expense = await withDb((d) => {
      const e = {
        id: nextId(d, 'budgetExpenses'), quarter,
        categoryType: ref.categoryType, organizationId: ref.organizationId, budgetCategoryId: ref.budgetCategoryId,
        amount, description, date, eventId,
        registeredBy: req.user.id, createdAt: now, updatedAt: now,
      };
      d.budgetExpenses.push(e);
      return e;
    });
    const data = load();
    sendJson(res, 201, withExpenseInfo(expense, data));
  }));

  router.put('/api/budget/expenses/:id', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    const existing = data0.budgetExpenses.find((e) => e.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Gasto no encontrado' });
    const ref = { categoryType: existing.categoryType, organizationId: existing.organizationId, budgetCategoryId: existing.budgetCategoryId };
    if (!canOperateOnCategory(req.user, data0, ref)) {
      return sendJson(res, 403, { error: 'No tienes permiso para editar este gasto' });
    }
    if (existing.quarter !== currentQuarter()) {
      return sendJson(res, 400, { error: 'Los gastos de trimestres anteriores quedan como historial y no se pueden editar' });
    }
    const newDate = body?.date ?? existing.date;
    if (quarterOf(newDate) !== currentQuarter()) {
      return sendJson(res, 400, { error: 'La fecha debe seguir dentro del trimestre actual' });
    }
    const amount = body?.amount !== undefined ? parseAmount(body.amount) : existing.amount;
    if (amount === null || amount <= 0) return sendJson(res, 400, { error: 'Monto inválido' });
    let eventId = existing.eventId;
    if (body?.eventId !== undefined) {
      eventId = body.eventId ? (data0.events.find((e) => e.id === Number(body.eventId))?.id ?? null) : null;
    }
    const updated = await withDb((d) => {
      const e = d.budgetExpenses.find((x) => x.id === id);
      Object.assign(e, {
        description: body?.description !== undefined ? String(body.description).trim() : e.description,
        date: newDate,
        amount,
        eventId,
        updatedAt: new Date().toISOString(),
      });
      return e;
    });
    const data = load();
    sendJson(res, 200, withExpenseInfo(updated, data));
  }));

  router.delete('/api/budget/expenses/:id', requireRole(['admin', 'leader'], async (req, res, params) => {
    const id = Number(params.id);
    const data0 = load();
    const existing = data0.budgetExpenses.find((e) => e.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Gasto no encontrado' });
    const ref = { categoryType: existing.categoryType, organizationId: existing.organizationId, budgetCategoryId: existing.budgetCategoryId };
    if (!canOperateOnCategory(req.user, data0, ref)) {
      return sendJson(res, 403, { error: 'No tienes permiso para eliminar este gasto' });
    }
    if (existing.quarter !== currentQuarter()) {
      return sendJson(res, 400, { error: 'Los gastos de trimestres anteriores quedan como historial y no se pueden eliminar' });
    }
    await withDb((d) => { d.budgetExpenses = d.budgetExpenses.filter((e) => e.id !== id); });
    sendJson(res, 200, { ok: true });
  }));
}
