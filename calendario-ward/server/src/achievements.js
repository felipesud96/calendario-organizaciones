// "Rachas y Logros" — capa de premios por período. Además de la pestaña
// "Todo el tiempo" (ver routes/stats.js → allCategoryRankings, sin filtro
// de fecha), esta capa calcula los mismos 6 rankings acotados a UN período
// (mes/trimestre/semestre/año) y, cuando ese período ya terminó, deja
// guardado para siempre quién ganó cada categoría — un "salón de la fama"
// consultable después, aunque los datos originales cambien con el tiempo.
//
// El cierre es AUTOMÁTICO: no hace falta que nadie apriete ningún botón.
// startAchievementsScheduler() revisa cada cierto tiempo (ver
// CHECK_EVERY_MS) si hay períodos ya terminados que todavía no se cerraron,
// y si los hay, calcula el ganador de cada categoría en ese momento y lo
// deja guardado — de ahí en adelante ese premio ya es historia fija, no se
// vuelve a recalcular aunque después se edite o borre el dato original.

import { load, withDb, nextId } from './db.js';
import { PERIOD_TYPES, currentPeriodKey, previousPeriodKey, periodRange, periodLabel, isPeriodElapsed } from './periods.js';
import { allCategoryRankings } from './routes/stats.js';

const todayISO = () => new Date().toISOString().slice(0, 10);

// Nombres temáticos: cada categoría de Rachas y Logros lleva el nombre de
// una figura de las escrituras (Antiguo Testamento, Nuevo Testamento, Libro
// de Mormón, Doctrina y Convenios, y la Perla de Gran Precio — se intentó
// representar los cinco libros) elegida por el rasgo que mejor representa
// esa categoría, para que el logro se sienta más significativo que un
// simple número en una tabla.
export const ACHIEVEMENT_CATEGORIES = [
  {
    key: 'commitments', rankingKey: 'commitmentsRanking', icon: '🎯',
    label: 'Compromisos cumplidos', achievementName: 'Premio Nefi',
    blurb: 'Como Nefi ante cada encargo — "Iré y haré" (1 Nefi 3:7) — el mayor porcentaje de compromisos cumplidos.',
    winnerOf: (ranking) => (ranking[0] && ranking[0].pct !== null && ranking[0].total > 0) ? { userId: ranking[0].userId, name: ranking[0].userName, valueLabel: `${ranking[0].pct}%` } : null,
  },
  {
    key: 'cleaning', rankingKey: 'cleaningRanking', icon: '🧹',
    label: 'Más aseo cumplido', achievementName: 'Premio Nehemías',
    blurb: 'Como Nehemías, que organizó al pueblo en turnos para reconstruir la muralla de Jerusalén (Nehemías 3) — la familia con más turnos de aseo cumplidos.',
    winnerOf: (ranking) => ranking[0] ? { userId: null, name: ranking[0].familyName, valueLabel: `${ranking[0].timesDone}×` } : null,
  },
  {
    key: 'interviews', rankingKey: 'interviewsRanking', icon: '👤',
    label: 'Más entrevistas realizadas', achievementName: 'Premio Samuel',
    blurb: 'Como el joven Samuel — "Habla, que tu siervo oye" (1 Samuel 3:10) — quien más entrevistas realizó.',
    winnerOf: (ranking) => ranking[0] ? { userId: null, name: ranking[0].interviewerName, valueLabel: `${ranking[0].count}×` } : null,
  },
  {
    key: 'talks', rankingKey: 'talksRanking', icon: '🎤',
    label: 'Más discursos dados', achievementName: 'Premio Pablo',
    blurb: 'Como el apóstol Pablo, incansable predicando en cada ciudad — quien más veces discursó.',
    winnerOf: (ranking) => ranking[0] ? { userId: ranking[0].speakerUserId || null, name: ranking[0].speakerName, valueLabel: `${ranking[0].timesSpoken}×` } : null,
  },
  {
    key: 'activities', rankingKey: 'activitiesRanking', icon: '📅',
    label: 'Más actividades registradas', achievementName: 'Premio Brigham Young',
    blurb: 'Como Brigham Young, que organizó al pueblo en compañías ordenadas para la travesía al oeste (D. y C. 136) — quien más actividades organizó.',
    winnerOf: (ranking) => ranking[0] ? { userId: ranking[0].userId, name: ranking[0].userName, valueLabel: `${ranking[0].count}×` } : null,
  },
  {
    key: 'meetings', rankingKey: 'meetingsRanking', icon: '📋',
    label: 'Más actas de reunión registradas', achievementName: 'Premio Enoc',
    blurb: 'Como Enoc, cuyas palabras y ciudad quedaron registradas para siempre (Moisés 6-7) — quien más actas dejó registradas.',
    winnerOf: (ranking) => ranking[0] ? { userId: ranking[0].userId, name: ranking[0].userName, valueLabel: `${ranking[0].count}×` } : null,
  },
];

export function categoryByKey(key) {
  return ACHIEVEMENT_CATEGORIES.find((c) => c.key === key) || null;
}

// Calcula los 6 rankings ya acotados a un período puntual (o sin acotar,
// para "Todo el tiempo" / el período EN CURSO todavía no cerrado).
export function computeCategoryRankings(data, range) {
  return allCategoryRankings(data, range);
}

// Cuántos períodos hacia atrás revisar al buscar pendientes de cierre — un
// límite prudente para no recorrer indefinidamente si el servidor estuvo
// mucho tiempo apagado (en ese caso, los períodos más antiguos que ese
// límite simplemente se quedan sin premio — no se pierde nada más que el
// registro histórico de un período muy viejo).
const LOOKBACK_STEPS = { month: 14, quarter: 9, semester: 5, year: 3 };

function alreadyClosed(data, periodType, periodKey) {
  return data.achievementClosures.some((c) => c.periodType === periodType && c.periodKey === periodKey);
}

// Cierra UN período puntual: calcula los 6 rankings acotados a su rango de
// fechas, guarda un premio por cada categoría que sí tuvo un ganador (una
// categoría sin ningún dato ese período simplemente no reparte premio), y
// deja la marca de "ya procesado" pase lo que pase — así nunca se vuelve a
// intentar, ni aunque ninguna categoría haya tenido ganador.
function closeOnePeriod(data, periodType, periodKey, now) {
  const range = periodRange(periodType, periodKey);
  const rankings = computeCategoryRankings(data, range);
  for (const cat of ACHIEVEMENT_CATEGORIES) {
    const winner = cat.winnerOf(rankings[cat.rankingKey] || []);
    if (!winner) continue;
    data.achievementAwards.push({
      id: nextId(data, 'achievementAwards'),
      periodType, periodKey,
      periodLabel: periodLabel(periodType, periodKey),
      periodStart: range.start, periodEnd: range.end,
      categoryKey: cat.key, categoryLabel: cat.label, categoryIcon: cat.icon,
      achievementName: cat.achievementName, blurb: cat.blurb,
      winnerUserId: winner.userId, winnerName: winner.name, valueLabel: winner.valueLabel,
      closedAt: now,
    });
  }
  data.achievementClosures.push({ id: nextId(data, 'achievementClosures'), periodType, periodKey, closedAt: now });
}

// Revisa los 4 tipos de período y cierra todos los que ya terminaron y
// todavía no tienen registro de cierre — va "retrocediendo" período por
// período desde el actual hasta encontrar uno ya cerrado (o hasta el
// límite de LOOKBACK_STEPS), así se pone al día aunque el servidor haya
// estado apagado varios períodos seguidos.
export async function closeElapsedPeriods() {
  const today = todayISO();
  await withDb((data) => {
    const now = new Date().toISOString();
    for (const periodType of PERIOD_TYPES) {
      let key = previousPeriodKey(periodType, currentPeriodKey(periodType));
      for (let i = 0; i < LOOKBACK_STEPS[periodType]; i++) {
        if (!isPeriodElapsed(periodType, key, today)) break;
        if (alreadyClosed(data, periodType, key)) break; // ya está al día
        closeOnePeriod(data, periodType, key, now);
        key = previousPeriodKey(periodType, key);
      }
    }
  });
}

const CHECK_EVERY_MS = 60 * 60 * 1000; // revisa cada hora — sobra para este volumen

export function startAchievementsScheduler() {
  closeElapsedPeriods().catch((err) => console.error('[rachas y logros] error inicial cerrando períodos:', err));
  setInterval(() => {
    closeElapsedPeriods().catch((err) => console.error('[rachas y logros] error cerrando períodos:', err));
  }, CHECK_EVERY_MS);
}
