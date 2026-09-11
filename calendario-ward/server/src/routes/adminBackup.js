import fs from 'fs';
import crypto from 'crypto';
import { DB_PATH } from '../db.js';

// Corrección (revisión de código): comparar el secreto con `!==` compara
// caracter por caracter y corta apenas encuentra una diferencia — en teoría
// eso filtra por tiempo de respuesta cuántos caracteres iniciales de un
// secreto adivinado coinciden con el real. Mismo criterio que ya se aplica
// a la contraseña (auth.js) y al token de sesión: se usa
// `crypto.timingSafeEqual` en vez de una comparación directa.
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Ruta temporal de migración: sirve para copiar la base de datos completa
// (server/data/db.json) de un servicio de Render a otro, por ejemplo al
// pasar de un servicio "Node nativo" a uno "Docker" (con OCR habilitado)
// sin perder los datos reales ya cargados (usuarios, eventos, entrevistas,
// etc.).
//
// Está protegida por una variable de entorno MIGRATION_SECRET en vez de
// por sesión de usuario, para poder llamarla con un solo comando curl
// desde la Shell de Render (que no tiene una sesión de navegador). Si esa
// variable de entorno no está configurada en este servicio, la ruta
// responde 404 como si no existiera — hay que agregarla a propósito en
// Render → Environment antes de usarla, y se recomienda borrarla de nuevo
// apenas termine la migración.
export function registerAdminBackupRoutes(router) {
  router.get('/api/admin/backup-export', async (req, res) => {
    const secret = process.env.MIGRATION_SECRET;
    const provided = req.headers['x-migration-secret'];
    if (!secret || !provided || !timingSafeStringEqual(provided, secret)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No encontrado' }));
      return;
    }
    let raw;
    try {
      raw = fs.readFileSync(DB_PATH, 'utf8');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No se pudo leer la base de datos: ' + err.message }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="db-export.json"',
    });
    res.end(raw);
  });
}
