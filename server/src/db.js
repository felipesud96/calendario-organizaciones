// Capa de almacenamiento: un archivo JSON como base de datos.
// No usa librerías externas (el entorno de compilación no tiene acceso a npm),
// pero el modelo de datos es el mismo que tendría una tabla SQL real, así que
// migrar a Postgres/MySQL más adelante es directo si el proyecto crece.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/db.json');

const EMPTY_DB = {
  organizations: [],
  users: [],
  events: [],
  interviews: [],
  sessions: [],
  registrationRequests: [],
  budgetCategories: [],
  budgetAllocations: [],
  budgetExpenses: [],
  stakeEvents: [],
  // Módulo "Reuniones y Asignaciones": cada acta (reunión) tiene sus propios
  // compromisos anidados (ver routes/meetings.js). Los compromisos se buscan
  // por id global (nextId 'commitments') a través de todas las actas, así
  // que no hace falta una colección aparte para ellos.
  meetings: [],
  // Módulo "Aseo del Edificio": familias (autocompletado + estadística
  // histórica) y los turnos de aseo de cada sábado asignados a una familia.
  families: [],
  cleaningShifts: [],
  // Módulo "Estadísticas": una evaluación (opcional) por actividad ya
  // pasada — asistencia esperada/real y feedback. Ver routes/stats.js.
  eventEvaluations: [],
  // Módulo "Discursos" (dentro de la pestaña "Asignaciones", junto a Aseo
  // del Edificio): registro de quién discursó en la reunión sacramental,
  // qué domingo, y de qué tema (opcional) — para saber cuántas veces ha
  // discursado cada miembro y cuándo fue la última vez. Ver routes/talks.js.
  talks: [],
  // Módulo "Rachas y Logros" (dentro de Estadísticas): premios ya cerrados
  // por período (mes/trimestre/semestre/año) — un registro por categoría
  // ganada, con el nombre temático del logro y quién lo ganó. Ver
  // achievements.js / routes/achievements.js. achievementClosures marca qué
  // combinaciones período+tipo ya se procesaron (aunque nadie haya ganado
  // ninguna categoría ese período), para no recalcularlas de nuevo.
  achievementAwards: [],
  achievementClosures: [],
  // Solicitudes de entrevista (auto-agendamiento, Punto 4): en vez de que el
  // líder deje horarios abiertos, el propio miembro (o líder) pide una
  // entrevista proponiendo fecha, hora y un motivo opcional. El líder de la
  // organización correspondiente (o el Obispado, que puede decidir
  // cualquiera) la confirma — pudiendo ajustar la fecha/hora si hace falta —
  // o la rechaza con un comentario. Al confirmarla se crea la entrevista real
  // en `interviews`. Ver routes/interview-requests.js.
  interviewRequests: [],
  // Solicitudes de aprobación de gasto: todo gasto de un líder común debe
  // aprobarse antes de registrarse (Manual General 20.2.6). El líder de
  // Obispado y el Administrador aprueban o rechazan; al aprobar se crea el
  // gasto real en `budgetExpenses`. Ver routes/budget.js.
  budgetExpenseRequests: [],
  // Configuración editable por el Obispado: cada cuántos días se espera un
  // Consejo de Barrio, para avisar en el Panel de Obispado si se atrasó. Ver
  // routes/ward-settings.js.
  wardSettings: {
    councilFrequencyDays: 7,
  },
  stakeCalendar: {
    url: '',
    displayName: 'Estaca',
    lastSyncedAt: null,
    lastSyncOk: null,
    lastSyncError: null,
    eventCount: 0,
    // Actividades de Estaca cuyo TÍTULO contenga alguna de estas palabras no
    // bloquean nada (son informativas: entrevistas, reuniones internas de
    // Estaca, etc.) — ver stakeCalendar.js → isBlockingStakeEvent().
    nonBlockingKeywords: ['entrevista', 'presidencia de estaca', 'sumo consejo', 'presentación anual'],
    // Si el Administrador (o el líder de Obispado) lo desactiva, las
    // actividades informativas (las que no influyen a la membresía del
    // barrio) directamente no se muestran en el calendario — solo quedan
    // visibles las que sí tienen prioridad. No afecta el bloqueo: esas
    // nunca bloqueaban nada, se trata solo de qué se ve.
    showNonBlockingEvents: true,
  },
  nextId: {
    organizations: 1, users: 1, events: 1, interviews: 1, registrationRequests: 1,
    budgetCategories: 1, budgetAllocations: 1, budgetExpenses: 1, stakeEvents: 1,
    meetings: 1, commitments: 1, families: 1, cleaningShifts: 1, eventEvaluations: 1, talks: 1,
    achievementAwards: 1, achievementClosures: 1, interviewRequests: 1, budgetExpenseRequests: 1,
    agendaItems: 1,
  },
};

function ensureFile() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(EMPTY_DB, null, 2));
  }
}

export function load() {
  ensureFile();
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  const data = JSON.parse(raw);
  // completa colecciones si faltan (compatibilidad hacia adelante)
  for (const key of Object.keys(EMPTY_DB)) {
    if (data[key] === undefined) data[key] = EMPTY_DB[key];
  }
  // migración: el rol "secretary" se fusionó con "leader" (un mismo líder
  // ahora edita tanto actividades como entrevistas de su organización).
  let migrated = false;
  for (const u of data.users) {
    if (u.role === 'secretary') { u.role = 'leader'; migrated = true; }
  }
  // migración: bases de datos creadas antes de que existiera la lista de
  // palabras clave "no restrictivas" del calendario de Estaca.
  if (!Array.isArray(data.stakeCalendar?.nonBlockingKeywords)) {
    data.stakeCalendar = { ...data.stakeCalendar, nonBlockingKeywords: [...EMPTY_DB.stakeCalendar.nonBlockingKeywords] };
    migrated = true;
  }
  // migración: bases de datos creadas antes de que existiera la opción de
  // ocultar del calendario las actividades de Estaca informativas.
  if (typeof data.stakeCalendar?.showNonBlockingEvents !== 'boolean') {
    data.stakeCalendar = { ...data.stakeCalendar, showNonBlockingEvents: true };
    migrated = true;
  }
  // migración: entrevistas creadas antes de que existiera el check de
  // verificación (¿se hizo o no?) — quedan como "scheduled" (pendientes de
  // verificar), igual que cualquier entrevista nueva; el líder las puede
  // marcar retroactivamente con ✅/❌ para que pasen al historial. Ver
  // routes/interviews.js.
  for (const iv of data.interviews) {
    if (iv.status === undefined) {
      iv.status = 'scheduled';
      iv.comment = iv.comment || '';
      iv.markedAt = iv.markedAt ?? null;
      iv.markedBy = iv.markedBy ?? null;
      migrated = true;
    }
  }
  // migración: usuarios creados antes de que existiera la marca de
  // "presidente/titular" de una organización (Punto 8: identificar al
  // Obispo, al presidente de Cuórum de Élderes y a la presidenta de
  // Sociedad de Socorro, no solo "un líder" cualquiera de esa organización).
  for (const u of data.users) {
    if (u.isPresident === undefined) { u.isPresident = false; migrated = true; }
  }
  // migración: actas creadas antes de que existiera el tipo, la agenda
  // previa y la confidencialidad.
  for (const m of data.meetings) {
    if (m.type === undefined) { m.type = 'general'; migrated = true; }
    if (m.confidential === undefined) { m.confidential = false; migrated = true; }
    if (!Array.isArray(m.agendaItems)) { m.agendaItems = []; migrated = true; }
    for (const c of (m.commitments || [])) {
      if (c.confidential === undefined) { c.confidential = false; migrated = true; }
    }
  }
  if (!data.wardSettings || typeof data.wardSettings.councilFrequencyDays !== 'number') {
    data.wardSettings = { councilFrequencyDays: 7 };
    migrated = true;
  }
  // migración: usuarios creados antes de que existiera el perfil (fecha de
  // nacimiento, sexo, foto) — necesario para saber con quién puede
  // agendarse una entrevista (ver interviewEligibility() más abajo). Estos
  // usuarios quedan con el perfil incompleto hasta que lo llenen — el
  // cliente les muestra un aviso obligatorio al ingresar.
  for (const u of data.users) {
    if (u.birthDate === undefined) { u.birthDate = null; migrated = true; }
    if (u.sex === undefined) { u.sex = null; migrated = true; }
    if (u.profilePhoto === undefined) { u.profilePhoto = null; migrated = true; }
  }
  // migración: usuarios creados antes de que existiera la agenda semanal de
  // disponibilidad para entrevistas (Punto 4, ampliación): un líder (típico:
  // el presidente o sus consejeros) declara qué días/horas de la semana
  // recibe entrevistas normalmente — p. ej. "martes y jueves de 20:00 a
  // 22:00". Es solo una guía para lo que un miembro puede proponer al pedir
  // una entrevista con ese líder; no reserva nada por sí sola ni bloquea el
  // agendamiento manual extraordinario. Ver interviewAvailabilityMatches().
  for (const u of data.users) {
    if (!Array.isArray(u.interviewAvailability)) { u.interviewAvailability = []; migrated = true; }
  }
  // migración: usuarios creados antes de que existiera el llamamiento
  // específico (Presidente/Consejero/Secretario) dentro de Obispado, Cuórum
  // de Élderes y Sociedad de Socorro — ver PRESIDENT_ORGS/callingLabel más
  // abajo. Queda null hasta que se declare (el propio líder puede hacerlo
  // desde "Mi Perfil", o el Administrador desde Administración → Usuarios).
  for (const u of data.users) {
    if (u.calling === undefined) { u.calling = null; migrated = true; }
  }
  // migración: solicitudes de entrevista creadas antes de que existiera la
  // opción de pedirla con un líder específico.
  for (const r of data.interviewRequests) {
    if (r.targetLeaderUserId === undefined) { r.targetLeaderUserId = null; migrated = true; }
    if (r.targetLeaderName === undefined) { r.targetLeaderName = null; migrated = true; }
  }
  if (migrated) save(data);
  return data;
}

// Punto 4 (ampliación) — con quién se puede agendar una entrevista, según el
// Manual General: un hombre adulto puede entrevistarse con la presidencia
// de Cuórum de Élderes o con el Obispado; una mujer adulta con la
// presidencia de Sociedad de Socorro o con el Obispado; un joven o una
// joven (Hombres Jóvenes / Mujeres Jóvenes) solo con el Obispado — el
// Obispo (y sus consejeros) pueden entrevistar a cualquier persona, sin
// ninguna restricción de sexo ni edad.
export function computeAge(birthDate) {
  if (!birthDate) return null;
  const b = new Date(`${birthDate}T00:00:00`);
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const monthDiff = now.getMonth() - b.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < b.getDate())) age--;
  return age;
}

export function isAdult(user) {
  const age = computeAge(user?.birthDate);
  return age !== null && age >= 18;
}

// Punto 8 (ampliación) — las tres organizaciones cuya presidencia tiene un
// llamamiento específico (Obispo/Presidente/Presidenta + Consejero/a +
// Secretario/a) según el Manual General: son las mismas tres que ya
// distinguía isPresident (Coordinación de Ministración) y las mismas con
// reglas de elegibilidad de entrevista.
export const PRESIDENT_ORGS = ['Obispado', 'Cuórum de Élderes', 'Sociedad de Socorro'];

// `calling` se guarda con un valor genérico ('Presidente' | 'Consejero' |
// 'Secretario') sin importar la organización, para no tener que duplicar la
// lógica de validación por género — callingLabel() lo traduce al nombre real
// del llamamiento según la organización (el Obispado usa "Obispo" para el
// titular; Sociedad de Socorro usa las formas femeninas).
export function callingLabel(orgName, calling) {
  if (!calling) return '';
  if (orgName === 'Obispado' && calling === 'Presidente') return 'Obispo';
  if (orgName === 'Sociedad de Socorro') {
    if (calling === 'Presidente') return 'Presidenta';
    if (calling === 'Consejero') return 'Consejera';
    if (calling === 'Secretario') return 'Secretaria';
  }
  return calling;
}

// true = puede agendarse con esta organización; false = no corresponde;
// null = no se puede determinar todavía porque a `user` le falta el perfil
// (fecha de nacimiento y/o sexo).
export function interviewEligibility(orgName, user) {
  if (orgName === 'Obispado') return true;
  if (orgName !== 'Cuórum de Élderes' && orgName !== 'Sociedad de Socorro') return true;
  if (!user?.birthDate || !user?.sex) return null;
  if (orgName === 'Cuórum de Élderes') return user.sex === 'M' && isAdult(user);
  return user.sex === 'F' && isAdult(user); // Sociedad de Socorro
}

// ¿La fecha/hora propuesta cae dentro de alguna ventana semanal declarada por
// el líder? `windows` es el arreglo interviewAvailability del usuario
// ({weekday, startTime, endTime}, weekday con la convención de
// Date.getDay(): domingo=0). No exige que termine antes de endTime — basta
// con que la hora de inicio propuesta esté dentro del rango, igual que
// cualquier otro horario de atención.
export function interviewAvailabilityMatches(windows, dateStr, startTime) {
  if (!Array.isArray(windows) || windows.length === 0) return false;
  if (!dateStr || !startTime) return false;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return false;
  const weekday = d.getDay();
  return windows.some((w) => Number(w.weekday) === weekday
    && startTime >= w.startTime && startTime < w.endTime);
}

const DEFAULT_SLOT_MINUTES = 30;
function timeToMinutes(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}
// Cuando falta la hora de término (es opcional en una solicitud/entrevista),
// se asume una duración típica de entrevista solo para poder comparar si dos
// horarios se superponen — no se guarda ni se muestra en ningún lado.
function effectiveEndMinutes(startTime, endTime) {
  return endTime ? timeToMinutes(endTime) : timeToMinutes(startTime) + DEFAULT_SLOT_MINUTES;
}
export function timesOverlap(aStart, aEnd, bStart, bEnd) {
  const aEndMin = effectiveEndMinutes(aStart, aEnd);
  const bEndMin = effectiveEndMinutes(bStart, bEnd);
  return timeToMinutes(aStart) < bEndMin && timeToMinutes(bStart) < aEndMin;
}

const CALLING_VALUES = ['Presidente', 'Consejero', 'Secretario'];
// Centraliza cómo se calculan `calling` + `isPresident` a partir de lo que
// mandó el formulario (usado por Administración → Usuarios, por la
// aprobación de una solicitud de registro, y por la auto-declaración en "Mi
// Perfil") — así los tres puntos de entrada quedan con la misma regla: en
// las tres organizaciones con llamamiento (PRESIDENT_ORGS), `calling` manda
// y `isPresident` se deriva de él; en cualquier otra organización no existe
// esta distinción y se mantiene el checkbox "★ Presidente/Titular" de
// siempre (retrocompatible con datos previos a esta función).
export function resolveCallingAndPresident(data, { organizationId, role, callingInput, isPresidentInput }) {
  if (role !== 'leader' || !organizationId) return { calling: null, isPresident: false };
  const org = data.organizations.find((o) => o.id === Number(organizationId));
  if (org && PRESIDENT_ORGS.includes(org.name)) {
    const calling = CALLING_VALUES.includes(callingInput) ? callingInput : null;
    return { calling, isPresident: calling === 'Presidente' };
  }
  return { calling: null, isPresident: !!isPresidentInput };
}

// Punto 8: cada organización (incluido Obispado, donde equivale a "el
// Obispo") puede tener más de un líder, pero como mucho UNO marcado como su
// presidente/titular a la vez — usado por Administración → Usuarios y por
// la aprobación de una solicitud de registro.
export function unmarkOtherPresidents(d, organizationId, exceptUserId) {
  for (const u of d.users) {
    if (u.id !== exceptUserId && u.role === 'leader' && Number(u.organizationId) === Number(organizationId) && u.isPresident) {
      u.isPresident = false;
    }
  }
}

export function save(data) {
  // escritura atómica: primero a un archivo temporal, luego rename
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

export function nextId(data, collection) {
  const id = data.nextId[collection] || 1;
  data.nextId[collection] = id + 1;
  return id;
}

// Pequeño mutex en memoria para evitar condiciones de carrera entre
// escrituras concurrentes dentro del mismo proceso.
let queue = Promise.resolve();
export function withDb(fn) {
  const result = queue.then(() => {
    const data = load();
    const out = fn(data);
    save(data);
    return out;
  });
  queue = result.catch(() => {});
  return result;
}
