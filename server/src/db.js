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
  nextId: {
    organizations: 1, users: 1, events: 1, interviews: 1, registrationRequests: 1,
    budgetCategories: 1, budgetAllocations: 1, budgetExpenses: 1,
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
