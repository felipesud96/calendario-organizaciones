import { sendJson } from '../router.js';
import { load } from '../db.js';
import { requireRole } from '../guard.js';
import { isObispadoLeader } from './stake.js';
import { PERIOD_TYPES, isValidPeriodKey, currentPeriodKey, periodRange, periodLabel } from '../periods.js';
import { computeCategoryRankings, ACHIEVEMENT_CATEGORIES } from '../achievements.js';

// "Rachas y Logros" por período (mes/trimestre/semestre/año) — la pestaña
// "Todo el tiempo" sigue viviendo en GET /api/stats/rankings (sin filtro de
// fecha). Estrictamente para el Administrador o el líder de Obispado, igual
// que el resto del Panel de Rachas y Logros.

function requireValidPeriod(req, res) {
  const period = req.query.period;
  if (!PERIOD_TYPES.includes(period)) {
    sendJson(res, 400, { error: `Período inválido — debe ser uno de: ${PERIOD_TYPES.join(', ')}` });
    return null;
  }
  return period;
}

export function registerAchievementRoutes(router) {
  // Metadatos de las 6 categorías (ícono, nombre temático, explicación) —
  // así el cliente no tiene que duplicar esta lista a mano.
  router.get('/api/achievements/categories', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    if (!isObispadoLeader(req.user, data)) return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado pueden ver Rachas y Logros' });
    sendJson(res, 200, ACHIEVEMENT_CATEGORIES.map((c) => ({ key: c.key, icon: c.icon, label: c.label, achievementName: c.achievementName, blurb: c.blurb })));
  }));

  // Ranking EN VIVO del período que todavía está en curso (no ha cerrado,
  // así que no tiene premio fijo en el histórico todavía).
  router.get('/api/achievements/current', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    if (!isObispadoLeader(req.user, data)) return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado pueden ver Rachas y Logros' });
    const period = requireValidPeriod(req, res);
    if (!period) return;
    const key = currentPeriodKey(period);
    const range = periodRange(period, key);
    const rankings = computeCategoryRankings(data, range);
    sendJson(res, 200, { periodType: period, periodKey: key, periodLabel: periodLabel(period, key), periodStart: range.start, periodEnd: range.end, ...rankings });
  }));

  // Histórico de premios ya cerrados (períodos que ya terminaron) — el
  // "salón de la fama" de cada período, agrupado por periodKey en el
  // cliente. Con ?winnerUserId= se puede acotar a los premios de una sola
  // persona (por ejemplo, para mostrarlos en su propio detalle).
  router.get('/api/achievements/history', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    if (!isObispadoLeader(req.user, data)) return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado pueden ver el histórico de Rachas y Logros' });
    const period = requireValidPeriod(req, res);
    if (!period) return;
    let items = data.achievementAwards.filter((a) => a.periodType === period);
    if (req.query.winnerUserId) items = items.filter((a) => Number(a.winnerUserId) === Number(req.query.winnerUserId));
    items = [...items].sort((a, b) => b.periodKey.localeCompare(a.periodKey) || a.categoryKey.localeCompare(b.categoryKey));
    sendJson(res, 200, items);
  }));
}
