// Rutas de administración para el respaldo automático (ver backup.js):
// listar copias existentes, forzar una copia ahora mismo, y descargar una
// copia puntual. Solo Administrador — el archivo de respaldo es la base de
// datos completa (incluye datos personales de todo el barrio).
import fs from 'fs';
import { requireRole } from '../guard.js';
import { sendJson } from '../router.js';
import { listBackups, runBackupNow, resolveBackupPath } from '../backup.js';

export function registerBackupRoutes(router) {
  router.get('/api/admin/backups', requireRole(['admin'], async (req, res) => {
    sendJson(res, 200, { backups: listBackups() });
  }));

  router.post('/api/admin/backups/run', requireRole(['admin'], async (req, res) => {
    try {
      const filename = runBackupNow();
      sendJson(res, 200, { ok: true, filename, backups: listBackups() });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  }));

  router.get('/api/admin/backups/:filename/download', requireRole(['admin'], async (req, res, params) => {
    const full = resolveBackupPath(params.filename);
    if (!full) {
      return sendJson(res, 404, { error: 'Ese respaldo no existe' });
    }
    const raw = fs.readFileSync(full);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${params.filename}"`,
      'Content-Length': raw.length,
    });
    res.end(raw);
  }));
}
