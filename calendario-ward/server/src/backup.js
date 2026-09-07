// Punto pedido explícitamente: "que haya un respaldo automático periódico
// de la base de datos, por si se corrompe algo". Antes la única forma de
// sacar una copia era la ruta de migración (adminBackup.js), que es manual y
// pensada para un traspaso puntual entre servicios de Render, no para
// protegerse de una corrupción del archivo día a día.
//
// Esto guarda copias del mismo db.json (tal cual está en disco, sin tocar
// su contenido) en una carpeta aparte, una vez al día, y va borrando las más
// viejas para no crecer sin límite. Aviso honesto (se lo decimos también a
// la persona en la pantalla de Admin): esto protege contra un archivo que se
// corrompe o un borrado accidental de un registro, pero las copias viven en
// el mismo disco que la base de datos real — si el disco completo de Render
// se pierde, se pierde todo junto. Por eso también existe el botón de
// "Descargar ahora" en el panel de Admin: para bajar una copia de vez en
// cuando a otro lugar (la propia computadora de quien administra).
import fs from 'fs';
import path from 'path';
import { DB_PATH } from './db.js';

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000; // revisa cada 1 hora si toca respaldar
const MIN_HOURS_BETWEEN_BACKUPS = 20; // como máximo 1 copia por día — evita duplicar en cada reinicio/deploy de Render
const MAX_BACKUPS_KEPT = 30; // ~1 mes de historial diario

// Nombre de archivo con la fecha/hora, sin ":" (no son válidos en Windows,
// y el archivo puede terminar bajándose a la computadora de alguien).
function backupFileName(date = new Date()) {
  return `db-${date.toISOString().replace(/:/g, '-').replace(/\..+$/, '')}.json`;
}
const BACKUP_FILENAME_RE = /^db-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/;

function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

export function listBackups() {
  ensureBackupDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => BACKUP_FILENAME_RE.test(f))
    .map((filename) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, filename));
      return { filename, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function pruneOldBackups() {
  const backups = listBackups();
  for (const b of backups.slice(MAX_BACKUPS_KEPT)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, b.filename)); } catch (e) { /* ignorar */ }
  }
}

// Copia el archivo tal cual está en disco en este instante (no pasa por
// load()/save() — no hace falta re-parsear el JSON, y así una copia nunca
// puede fallar por una validación que a futuro se le agregue a load()).
export function runBackupNow() {
  ensureBackupDir();
  if (!fs.existsSync(DB_PATH)) throw new Error('Todavía no existe la base de datos');
  const filename = backupFileName();
  fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, filename));
  pruneOldBackups();
  return filename;
}

function hoursSinceMostRecentBackup() {
  const backups = listBackups();
  if (!backups.length) return Infinity;
  return (Date.now() - new Date(backups[0].createdAt).getTime()) / (1000 * 60 * 60);
}

function backupIfDue(label) {
  try {
    if (hoursSinceMostRecentBackup() >= MIN_HOURS_BETWEEN_BACKUPS) {
      const filename = runBackupNow();
      console.log(`[respaldo] copia creada (${label}): ${filename}`);
    }
  } catch (err) {
    console.error(`[respaldo] error al respaldar (${label}):`, err.message);
  }
}

// Resuelve una ruta de archivo de respaldo a partir de un nombre recibido
// por parámetro de URL, validando estrictamente el formato para evitar
// cualquier intento de path traversal (ej. "../../.env").
export function resolveBackupPath(filename) {
  if (!BACKUP_FILENAME_RE.test(filename)) return null;
  const full = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(full)) return null;
  return full;
}

let schedulerStarted = false;
export function startBackupScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  backupIfDue('al iniciar el servidor');
  setInterval(() => backupIfDue('chequeo periódico'), BACKUP_CHECK_INTERVAL_MS);
}
