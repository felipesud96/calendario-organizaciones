import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { URL } from 'url';

import { Router, sendJson, readJsonBody } from './router.js';
import { getUserFromToken } from './auth.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerOrganizationRoutes } from './routes/organizations.js';
import { registerEventRoutes } from './routes/events.js';
import { registerInterviewRoutes } from './routes/interviews.js';
import { registerUserRoutes } from './routes/users.js';
import { registerRegistrationRoutes } from './routes/registration.js';
import { registerCalendarRoutes } from './routes/calendar.js';
import { registerBudgetRoutes } from './routes/budget.js';
import { registerStakeRoutes } from './routes/stake.js';
import { startReminderScheduler } from './reminders.js';
import { startStakeSyncScheduler } from './stakeCalendar.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;
const CLIENT_DIR = process.env.CLIENT_DIR || path.join(__dirname, '../../client/public');

const router = new Router();
registerAuthRoutes(router);
registerOrganizationRoutes(router);
registerEventRoutes(router);
registerInterviewRoutes(router);
registerUserRoutes(router);
registerRegistrationRoutes(router);
registerCalendarRoutes(router);
registerBudgetRoutes(router);
registerStakeRoutes(router);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, pathname) {
  let filePath = path.join(CLIENT_DIR, pathname === '/' ? 'index.html' : pathname);
  // evita path traversal
  if (!filePath.startsWith(CLIENT_DIR)) {
    res.writeHead(400);
    return res.end('Ruta inválida');
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      // SPA fallback: cualquier ruta no encontrada sirve index.html
      const indexPath = path.join(CLIENT_DIR, 'index.html');
      fs.readFile(indexPath, (err2, indexContent) => {
        if (err2) {
          res.writeHead(404);
          return res.end('No encontrado');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(indexContent);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS abierto (útil si el frontend se sirve por separado en desarrollo)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
  }

  if (pathname.startsWith('/api/')) {
    try {
      const match = router.match(req.method, pathname);
      if (!match) {
        return sendJson(res, 404, { error: 'Ruta no encontrada' });
      }
      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      req.token = token;
      req.user = token ? await getUserFromToken(token) : null;
      req.query = Object.fromEntries(url.searchParams.entries());

      let body = {};
      if (['POST', 'PUT'].includes(req.method)) {
        body = await readJsonBody(req);
      }
      await match.handler(req, res, match.params, body);
    } catch (err) {
      console.error('Error en request:', err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Error interno del servidor' });
      }
    }
    return;
  }

  if (req.method === 'GET') {
    return serveStatic(req, res, pathname);
  }

  res.writeHead(405);
  res.end('Método no permitido');
});

server.listen(PORT, () => {
  console.log(`Servidor del Calendario de Organizaciones escuchando en http://localhost:${PORT}`);
  console.log(`Sirviendo frontend estático desde: ${CLIENT_DIR}`);
  startReminderScheduler();
  startStakeSyncScheduler();
});
