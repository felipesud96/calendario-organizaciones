// Matemática de períodos para "Rachas y Logros": mes, trimestre, semestre y
// año, cada uno con su propia llave ("2026-08", "2026-Q3", "2026-S2",
// "2026"), su rango de fechas [start, end] (ambas inclusive, en formato
// ISO "YYYY-MM-DD" para poder comparar como texto), y una etiqueta legible
// para mostrar en pantalla. `quarter.js` ya tenía esta misma matemática
// para el trimestre del Presupuesto — se reutiliza tal cual acá para no
// tener dos implementaciones del mismo cálculo.
import { quarterOf, quarterLabel as quarterLabelOf, isValidQuarter } from './quarter.js';

export const PERIOD_TYPES = ['month', 'quarter', 'semester', 'year'];

function pad2(n) { return String(n).padStart(2, '0'); }
function toISODate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function parseISODate(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
function lastDayOfMonth(year, monthIndex0) { return new Date(year, monthIndex0 + 1, 0).getDate(); }

export function monthKeyOf(dateInput) {
  const d = typeof dateInput === 'string' ? parseISODate(dateInput) : dateInput;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
export function semesterKeyOf(dateInput) {
  const d = typeof dateInput === 'string' ? parseISODate(dateInput) : dateInput;
  const s = d.getMonth() < 6 ? 1 : 2;
  return `${d.getFullYear()}-S${s}`;
}
export function yearKeyOf(dateInput) {
  const d = typeof dateInput === 'string' ? parseISODate(dateInput) : dateInput;
  return `${d.getFullYear()}`;
}

export function periodKeyOf(periodType, dateInput) {
  if (periodType === 'month') return monthKeyOf(dateInput);
  if (periodType === 'quarter') return quarterOf(dateInput);
  if (periodType === 'semester') return semesterKeyOf(dateInput);
  if (periodType === 'year') return yearKeyOf(dateInput);
  throw new Error(`Tipo de período desconocido: ${periodType}`);
}

export function currentPeriodKey(periodType) {
  return periodKeyOf(periodType, new Date());
}

export function isValidPeriodKey(periodType, key) {
  if (periodType === 'month') return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(key || ''));
  if (periodType === 'quarter') return isValidQuarter(key);
  if (periodType === 'semester') return /^\d{4}-S[12]$/.test(String(key || ''));
  if (periodType === 'year') return /^\d{4}$/.test(String(key || ''));
  return false;
}

// Rango [start, end] — ambas fechas ISO inclusive — que cubre esa llave de
// período. Se usa para filtrar qué registros (compromisos, turnos de aseo,
// entrevistas, discursos, actividades, actas) "pertenecen" a ese período.
export function periodRange(periodType, key) {
  if (periodType === 'month') {
    const [y, m] = key.split('-').map(Number);
    const last = lastDayOfMonth(y, m - 1);
    return { start: `${y}-${pad2(m)}-01`, end: `${y}-${pad2(m)}-${pad2(last)}` };
  }
  if (periodType === 'quarter') {
    const mth = /^(\d{4})-Q([1-4])$/.exec(key);
    const y = Number(mth[1]); const q = Number(mth[2]);
    const startMonth0 = (q - 1) * 3;
    const endMonth0 = startMonth0 + 2;
    const last = lastDayOfMonth(y, endMonth0);
    return { start: `${y}-${pad2(startMonth0 + 1)}-01`, end: `${y}-${pad2(endMonth0 + 1)}-${pad2(last)}` };
  }
  if (periodType === 'semester') {
    const mth = /^(\d{4})-S([12])$/.exec(key);
    const y = Number(mth[1]); const s = Number(mth[2]);
    const startMonth0 = s === 1 ? 0 : 6;
    const endMonth0 = startMonth0 + 5;
    const last = lastDayOfMonth(y, endMonth0);
    return { start: `${y}-${pad2(startMonth0 + 1)}-01`, end: `${y}-${pad2(endMonth0 + 1)}-${pad2(last)}` };
  }
  if (periodType === 'year') {
    const y = Number(key);
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }
  throw new Error(`Tipo de período desconocido: ${periodType}`);
}

const MONTH_LABELS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function periodLabel(periodType, key) {
  if (periodType === 'month') {
    const [y, m] = key.split('-').map(Number);
    return `${MONTH_LABELS[m - 1]} ${y}`;
  }
  if (periodType === 'quarter') return quarterLabelOf(key);
  if (periodType === 'semester') {
    const m = /^(\d{4})-S([12])$/.exec(key);
    return `${m[2]}° semestre ${m[1]}`;
  }
  if (periodType === 'year') return key;
  return key;
}

// La fecha ISO justo antes del inicio de esta llave de período — se usa
// para "dar un paso atrás" y encontrar la llave del período anterior
// (necesario para el cierre automático: hay que ir revisando hacia atrás
// hasta encontrar períodos ya cerrados).
export function previousPeriodKey(periodType, key) {
  const { start } = periodRange(periodType, key);
  const d = parseISODate(start);
  d.setDate(d.getDate() - 1); // último día del período anterior
  return periodKeyOf(periodType, d);
}

export function isPeriodElapsed(periodType, key, todayISOStr) {
  const { end } = periodRange(periodType, key);
  return end < todayISOStr;
}
