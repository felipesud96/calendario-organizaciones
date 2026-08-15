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
  if (migrated) save(data);
  return data;
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
