import { procesarPreguntaChat } from './chat.js';
import http from 'http';
import fs from 'fs';
import zlib from 'zlib';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { URL } from 'url';

import { Router, sendJson, readJsonBody, readRawBody, parseMultipart } from './router.js';
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
import { registerMeetingRoutes } from './routes/meetings.js';
import { registerAgreementRoutes } from './routes/agreements.js';
import { registerCleaningRoutes } from './routes/cleaning.js';
import { registerTalkRoutes } from './routes/talks.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerAchievementRoutes } from './routes/achievements.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerNotificationsSummaryRoutes } from './routes/notifications-summary.js';
import { registerInterviewRequestRoutes } from './routes/interview-requests.js';
import { registerPublicBookingRoutes } from './routes/publicBooking.js';
import { registerPersonasSemanaRoutes } from './routes/personasSemana.js';
import { registerTtsRoutes } from './routes/tts.js';
import { startWeeklySummaryScheduler } from './semana.js';
import { registerWelfareRoutes } from './routes/welfare.js';
import { registerNamesRoutes } from './routes/names.js';
import { registerWardGrowthRoutes } from './routes/wardGrowth.js';
import { registerAdminBackupRoutes } from './routes/adminBackup.js';
import { registerBackupRoutes } from './routes/backups.js';
import { registerDirectoryRoutes } from './routes/directory.js';
import { registerWebPushRoutes } from './routes/webpush.js';
import { startReminderScheduler } from './reminders.js';
import { startStakeSyncScheduler } from './stakeCalendar.js';
import { startAchievementsScheduler } from './achievements.js';
import { startBackupScheduler } from './backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;
const CLIENT_DIR = process.env.CLIENT_DIR || path.join(__dirname, '../../client/public');

// Límite simple para /api/chat: cada mensaje puede terminar llamando a una
// API externa DE PAGO (Gemini/Groq), así que sin esto cualquiera logueado
// podía generar costos mandando mensajes en bucle (o por accidente, con el
// auto-envío por voz). No es un rate limiter robusto de producción (Map en
// memoria: se resetea si el proceso se reinicia, y no se comparte entre
// instancias) pero para esta app de un solo proceso alcanza para frenar el
// abuso más obvio.
const CHAT_RATE_LIMIT_MAX = 15;
const CHAT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const chatRateLimitState = new Map(); // userId -> timestamps recientes

function chatRateLimited(userId) {
  const now = Date.now();
  const timestamps = (chatRateLimitState.get(userId) || []).filter((t) => now - t < CHAT_RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= CHAT_RATE_LIMIT_MAX) {
    chatRateLimitState.set(userId, timestamps);
    return true;
  }
  timestamps.push(now);
  chatRateLimitState.set(userId, timestamps);
  return false;
}

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
registerMeetingRoutes(router);
registerAgreementRoutes(router);
registerCleaningRoutes(router);
registerTalkRoutes(router);
registerStatsRoutes(router);
registerAchievementRoutes(router);
registerDashboardRoutes(router);
registerSearchRoutes(router);
registerNotificationsSummaryRoutes(router);
registerInterviewRequestRoutes(router);
registerPublicBookingRoutes(router);
registerPersonasSemanaRoutes(router);
registerTtsRoutes(router);
registerWelfareRoutes(router);
registerNamesRoutes(router);
registerWardGrowthRoutes(router);
registerAdminBackupRoutes(router);
registerBackupRoutes(router);
registerDirectoryRoutes(router);
registerWebPushRoutes(router);

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

// ----------------------------------------------------------------------
// Archivos estáticos, más rápidos en el celular (App 10)
// ----------------------------------------------------------------------
// app.js pesa ~700 KB. Antes se enviaba completo y sin comprimir en cada
// visita. Ahora:
//   • se comprime con Brotli o gzip (según lo que acepte el navegador):
//     el JavaScript y el CSS bajan a ~20-25% de su tamaño;
//   • cada archivo lleva un ETag (huella del contenido): si el navegador ya
//     tiene esa misma versión, el servidor responde "304 sin cambios" en
//     vez de volver a mandarla;
//   • las imágenes quedan en caché del navegador por una semana.
// La versión comprimida se guarda en memoria y se recalcula sola cuando el
// archivo cambia (deploy nuevo).
const COMPRIMIBLES = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest']);
const cacheEstaticos = new Map(); // ruta -> { mtimeMs, etag, raw, br, gz }

function prepararEstatico(filePath) {
  const st = fs.statSync(filePath);
  const prev = cacheEstaticos.get(filePath);
  if (prev && prev.mtimeMs === st.mtimeMs) return prev;
  const raw = fs.readFileSync(filePath);
  const ext = path.extname(filePath);
  const entry = {
    mtimeMs: st.mtimeMs,
    etag: `"${crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 20)}"`,
    raw,
    br: COMPRIMIBLES.has(ext) && raw.length > 1024 ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }) : null,
    gz: COMPRIMIBLES.has(ext) && raw.length > 1024 ? zlib.gzipSync(raw, { level: 9 }) : null,
  };
  cacheEstaticos.set(filePath, entry);
  return entry;
}

function enviarEstatico(req, res, filePath) {
  const e = prepararEstatico(filePath);
  const ext = path.extname(filePath);
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    ETag: e.etag,
    // HTML/JS/CSS no llevan versión en el nombre: se revalidan siempre
    // (barato gracias al ETag). Imágenes e íconos: una semana.
    'Cache-Control': ['.png', '.ico', '.jpg', '.jpeg', '.webp'].includes(ext) ? 'public, max-age=604800' : 'no-cache',
    Vary: 'Accept-Encoding',
  };
  if (req.headers['if-none-match'] === e.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const acepta = String(req.headers['accept-encoding'] || '');
  let cuerpo = e.raw;
  if (e.br && /\bbr\b/.test(acepta)) { cuerpo = e.br; headers['Content-Encoding'] = 'br'; }
  else if (e.gz && /\bgzip\b/.test(acepta)) { cuerpo = e.gz; headers['Content-Encoding'] = 'gzip'; }
  headers['Content-Length'] = cuerpo.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : cuerpo);
}

function serveStatic(req, res, pathname) {
  // Página pública para pedir entrevista sin cuenta (ver routes/publicBooking.js):
  // /agendar/<token> y /agendar/estado/<token> sirven la misma página liviana.
  if (/^\/agendar\/[a-z0-9/]+$/i.test(pathname)) pathname = '/agendar.html';
  let filePath = path.join(CLIENT_DIR, pathname === '/' ? 'index.html' : pathname);
  // evita path traversal
  if (!filePath.startsWith(CLIENT_DIR)) {
    res.writeHead(400);
    return res.end('Ruta inválida');
  }
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      // SPA fallback: cualquier ruta no encontrada sirve index.html
      filePath = path.join(CLIENT_DIR, 'index.html');
    }
    enviarEstatico(req, res, filePath);
  } catch (err) {
    res.writeHead(404);
    res.end('No encontrado');
  }
}

const server = http.createServer(async (req, res) => {
  // CORS abierto
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

 // Ruta del Chat — requiere sesión iniciada (antes no se exigía: cualquiera,
  // sin loguearse, podía pedirle al chat que creara actividades). Además,
  // antes se le pasaba el objeto `usuario` a procesarPreguntaChat() en el
  // lugar donde debía ir el HISTORIAL de la conversación (el frontend sí lo
  // mandaba, pero acá se descartaba) — por eso el chat nunca tenía memoria
  // de mensajes anteriores. Ahora se pasan ambos, cada uno en su lugar.
  if (pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body || '{}');

        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        const usuario = token ? await getUserFromToken(token) : null;
        if (!usuario) {
          return sendJson(res, 401, { error: 'Necesitas iniciar sesión para usar a Deseret' });
        }

        if (chatRateLimited(usuario.id)) {
          return sendJson(res, 429, { error: 'Estás mandándome mensajes muy rápido. Espera un momento e intenta de nuevo.' });
        }

        const historial = Array.isArray(parsed.historial) ? parsed.historial.slice(-6) : [];
        // procesarPreguntaChat devuelve { texto, opciones?, tarjeta?, items? }
        // (botones de respuesta rápida, resumen para confirmar y tarjetas).
        const r = await procesarPreguntaChat(String(parsed.mensaje || '').slice(0, 1000), historial, usuario);
        const { texto, ...extra } = typeof r === 'string' ? { texto: r } : r;
        return sendJson(res, 200, { respuesta: texto, ...extra });
      } catch (error) {
        console.error('Error en endpoint chat IA:', error);
        const mensajeError = "Ocurrió un inconveniente al validar la consulta. Por favor, intenta de nuevo.";
        return sendJson(res, 200, { respuesta: mensajeError });
      }
    });
    return;
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
        const contentType = req.headers['content-type'] || '';
        if (contentType.startsWith('multipart/form-data')) {
          const raw = await readRawBody(req, 20 * 1024 * 1024);
          body = parseMultipart(raw, contentType);
        } else {
          body = await readJsonBody(req);
        }
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
  console.log(`Servidor de OrganizaSion escuchando en http://localhost:${PORT}`);
  console.log(`Sirviendo frontend estático desde: ${CLIENT_DIR}`);
  startReminderScheduler();
  startWeeklySummaryScheduler();
  startStakeSyncScheduler();
  startAchievementsScheduler();
  startBackupScheduler();
});
