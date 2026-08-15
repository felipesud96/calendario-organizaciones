import { sendJson } from '../router.js';
import { load, withDb } from '../db.js';
import { requireAuth } from '../guard.js';
import { STAKE_COLOR, syncStakeCalendar, isBlockingStakeEvent, findStakeConflicts } from '../stakeCalendar.js';

// Igual que en budget.js: "líder de Obispado" es quien puede disparar una
// sincronización manual, cambiar la configuración, o autorizar ("dar el OK")
// una actividad que choca con una de Estaca — además del Administrador (los
// demás líderes y los miembros solo pueden consultar).
export function isObispadoLeader(user, data) {
  if (user.role === 'admin') return true;
  if (user.role !== 'leader') return false;
  const org = data.organizations.find((o) => o.id === Number(user.organizationId));
  return !!org && org.name === 'Obispado';
}

function withStakeDisplay(ev, data) {
  return {
    ...ev,
    organizationName: data.stakeCalendar?.displayName || 'Estaca',
    organizationColor: STAKE_COLOR,
    blocking: isBlockingStakeEvent(ev, data.stakeCalendar?.nonBlockingKeywords),
  };
}

export function registerStakeRoutes(router) {
  // Cualquier usuario autenticado puede ver las actividades de Estaca — son
  // públicas dentro del barrio y afectan a cualquiera que quiera agendar algo.
  // Si el Administrador (o el líder de Obispado) desactivó
  // "showNonBlockingEvents", las informativas (las que no influyen a la
  // membresía del barrio) directamente no se devuelven acá — solo quedan
  // las que sí tienen prioridad. Esto es solo de visualización: el bloqueo
  // (ver /api/stake-conflicts y routes/events.js) nunca dependió de las
  // informativas, así que no cambia en nada.
  router.get('/api/stake-events', requireAuth(async (req, res) => {
    const data = load();
    const query = req.query;
    let items = data.stakeEvents || [];
    if (query.from) items = items.filter((e) => e.date >= query.from);
    if (query.to) items = items.filter((e) => e.date <= query.to);
    items = items.map((e) => withStakeDisplay(e, data));
    if (data.stakeCalendar?.showNonBlockingEvents === false) items = items.filter((e) => e.blocking);
    items = items.sort((a, b) => (a.date + (a.startTime || '00:00')).localeCompare(b.date + (b.startTime || '00:00')));
    sendJson(res, 200, items);
  }));

  // Estado de la sincronización — visible para cualquiera (no es información
  // sensible, es lo mismo que muestra el calendario público de la Estaca).
  router.get('/api/stake-calendar', requireAuth(async (req, res) => {
    const data = load();
    sendJson(res, 200, data.stakeCalendar);
  }));

  // Revisa si una actividad/reunión (o entrevista) que se está por agendar
  // choca con alguna actividad de Estaca de las que SÍ bloquean (no las
  // informativas). Centraliza acá la misma lógica que usa routes/events.js
  // al guardar, para que el cliente pueda avisar de inmediato sin
  // duplicarla. `canOverride` indica si quien pregunta es el líder de
  // Obispado (o Administrador) — el único que puede autorizar igual.
  router.post('/api/stake-conflicts', requireAuth(async (req, res, params, body) => {
    const data = load();
    const conflicts = findStakeConflicts(data, body || {}).map((c) => withStakeDisplay(c, data));
    sendJson(res, 200, { conflicts, canOverride: isObispadoLeader(req.user, data) });
  }));

  // Cambiar el enlace, el nombre a mostrar, o las palabras clave "no
  // restrictivas": Administrador o líder de Obispado.
  router.put('/api/stake-calendar', requireAuth(async (req, res, params, body) => {
    const data0 = load();
    if (!isObispadoLeader(req.user, data0)) {
      return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado pueden configurar el calendario de Estaca' });
    }
    const { url, displayName, nonBlockingKeywords, showNonBlockingEvents } = body || {};
    if (!url || !/^https?:\/\//i.test(String(url).trim())) {
      return sendJson(res, 400, { error: 'El enlace debe ser una URL válida (http o https)' });
    }
    const cleanKeywords = Array.isArray(nonBlockingKeywords)
      ? [...new Set(nonBlockingKeywords.map((k) => String(k).trim()).filter(Boolean))]
      : data0.stakeCalendar.nonBlockingKeywords;
    await withDb((data) => {
      data.stakeCalendar = {
        ...data.stakeCalendar,
        url: String(url).trim(),
        displayName: displayName ? String(displayName).trim() : (data.stakeCalendar.displayName || 'Estaca'),
        nonBlockingKeywords: cleanKeywords,
        showNonBlockingEvents: typeof showNonBlockingEvents === 'boolean' ? showNonBlockingEvents : data.stakeCalendar.showNonBlockingEvents,
      };
    });
    const meta = await syncStakeCalendar();
    sendJson(res, 200, meta);
  }));

  // Sincronizar ahora: Administrador o líder de Obispado.
  router.post('/api/stake-calendar/sync', requireAuth(async (req, res) => {
    const data = load();
    if (!isObispadoLeader(req.user, data)) {
      return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado pueden sincronizar el calendario de Estaca' });
    }
    const meta = await syncStakeCalendar();
    sendJson(res, 200, meta);
  }));
}
