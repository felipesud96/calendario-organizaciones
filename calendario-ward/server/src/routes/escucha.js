// ----------------------------------------------------------------------
// "DESERET ESCUCHA LA REUNIÓN" — transcribir una reunión y armar el acta
// ----------------------------------------------------------------------
// El navegador graba la reunión (micrófono, o micrófono + audio de la
// reunión online) y sube un trozo de audio cada ~5 minutos. Por cada trozo:
//   1. se transcribe con Whisper en Groq (GROQ_API_KEY) — o, si no hay,
//      con Gemini (GEMINI_API_KEY);
//   2. se guarda SOLO el texto; el audio se descarta en el acto (nunca se
//      escribe en disco ni queda en la base de datos).
// Al terminar, la IA ordena el texto como acta (temas, acuerdos y
// compromisos, con los responsables buscados entre las personas
// asignables). La persona REVISA y corrige todo antes de guardar; al
// guardar (o descartar) se borra también la transcripción.
//
// Rutas (líderes, secretario de barrio y Administrador — los mismos que
// crean actas):
//   GET    /api/escucha/estado          ¿hay servicio de transcripción?
//   POST   /api/escucha                 empieza una sesión
//   POST   /api/escucha/:id/trozo       sube un trozo (multipart: audio, n)
//   POST   /api/escucha/:id/terminar    arma el borrador del acta
//   POST   /api/escucha/:id/guardar     guarda el acta revisada
//   DELETE /api/escucha/:id             descarta todo
// ----------------------------------------------------------------------
import { sendJson } from '../router.js';
import { requireRole } from '../guard.js';
import { load, withDb, nextId } from '../db.js';
import { assignableUsersFor } from './meetings.js';
import { isObispadoLeader } from './stake.js';
import { clienteGemini, GEMINI_MODEL, hoyEnChile, vaciarCache } from '../chat.js';
import { ordenarActa, guardarActaCore } from '../deseretPlus.js';

const ROLES = ['admin', 'leader', 'ward_clerk'];
const MAX_TROZO = 20 * 1024 * 1024;
const MAX_TROZOS = 60;             // ~5 horas a 5 minutos por trozo
const VIGENCIA_MS = 2 * 24 * 3600 * 1000; // sesiones olvidadas se borran a los 2 días

export const transcripcionDisponible = () => !!(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY);

// Palabras que Whisper suele escribir mal: ayudan a reconocer nombres y
// términos de la Iglesia (el "prompt" de Whisper admite ~200 palabras).
function vocabulario(data) {
  const nombres = data.users.filter((u) => u.role !== 'member').map((u) => u.name).slice(0, 40).join(', ');
  return `Reunión de barrio de La Iglesia de Jesucristo de los Santos de los Últimos Días, en Chile. Obispo, obispado, consejo de barrio, Cuórum de Élderes, Sociedad de Socorro, Primaria, Hombres Jóvenes, Mujeres Jóvenes, ministración, recomendación del templo, llamamiento, sacramental. ${nombres}.`.slice(0, 900);
}

async function transcribirGroq(buffer, mime, nombre, prompt) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mime || 'audio/webm' }), nombre);
  fd.append('model', process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3');
  fd.append('language', 'es');
  fd.append('response_format', 'json');
  fd.append('temperature', '0');
  fd.append('prompt', prompt);
  const r = await fetch(process.env.GROQ_AUDIO_URL || 'https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: fd,
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return String(j.text || '').trim();
}

async function transcribirGemini(buffer, mime, prompt) {
  const gemini = clienteGemini();
  if (!gemini) throw new Error('Sin Gemini');
  const r = await gemini.models.generateContent({
    model: GEMINI_MODEL(),
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: (mime || 'audio/webm').split(';')[0], data: buffer.toString('base64') } },
        { text: `Transcribe TEXTUALMENTE este audio en español (Chile). Contexto: ${prompt}\nDevuelve solo el texto hablado, sin comentarios, sin marcas de tiempo, sin resumir. Si no se entiende nada, devuelve vacío.` },
      ],
    }],
    config: { temperature: 0 },
  });
  return String(r?.text || '').trim();
}

async function transcribir(buffer, mime, nombre, data) {
  const prompt = vocabulario(data);
  if (process.env.GROQ_API_KEY) {
    try { return await transcribirGroq(buffer, mime, nombre, prompt); } catch (e) {
      console.warn('⚠️ Transcripción Groq falló:', e.message);
      if (!process.env.GEMINI_API_KEY) throw e;
    }
  }
  return transcribirGemini(buffer, mime, prompt);
}

// Whisper a veces "rellena" el silencio con frases típicas de videos.
const ALUCINACIONES = /^(gracias por ver( el video)?|suscr[ií]bete|subt[ií]tulos (realizados )?por|amara\.org|¡?gracias!?\.?)$/i;
const limpiarTexto = (t) => String(t || '').split(/(?<=[.!?])\s+/).filter((f) => !ALUCINACIONES.test(f.trim())).join(' ').trim();

function sesionDe(data, id, user) {
  const s = (data.escuchas || []).find((x) => x.id === Number(id));
  if (!s || Number(s.userId) !== Number(user.id)) return null;
  return s;
}

export function registerEscuchaRoutes(router) {
  router.get('/api/escucha/estado', requireRole(ROLES, async (req, res) => {
    sendJson(res, 200, { disponible: transcripcionDisponible(), motor: process.env.GROQ_API_KEY ? 'whisper' : process.env.GEMINI_API_KEY ? 'gemini' : null });
  }));

  router.post('/api/escucha', requireRole(ROLES, async (req, res, params, body) => {
    if (!transcripcionDisponible()) return sendJson(res, 503, { error: 'Falta configurar la transcripción (GROQ_API_KEY o GEMINI_API_KEY en el servidor).' });
    const ahora = Date.now();
    const s = await withDb((db) => {
      db.escuchas = (db.escuchas || []).filter((x) => ahora - new Date(x.creado).getTime() < VIGENCIA_MS);
      const nueva = {
        id: nextId(db, 'escuchas'), userId: req.user.id, creado: new Date().toISOString(),
        fuente: body?.fuente === 'online' ? 'online' : 'sala', titulo: String(body?.titulo || '').slice(0, 100), trozos: [],
      };
      db.escuchas.push(nueva);
      return nueva;
    });
    sendJson(res, 201, { id: s.id });
  }));

  router.post('/api/escucha/:id/trozo', requireRole(ROLES, async (req, res, params, body) => {
    const data = load();
    const s = sesionDe(data, params.id, req.user);
    if (!s) return sendJson(res, 404, { error: 'Sesión no encontrada' });
    const file = (body?.files || []).find((f) => f.field === 'audio');
    const n = Number(body?.fields?.n);
    if (!file || !Number.isInteger(n) || n < 0 || n >= MAX_TROZOS) return sendJson(res, 400, { error: 'Falta el audio o el número de trozo' });
    if (file.data.length > MAX_TROZO) return sendJson(res, 413, { error: 'Trozo de audio demasiado grande' });
    // Reintento del mismo trozo: ya estaba transcrito.
    const previo = s.trozos.find((t) => t.n === n);
    if (previo) return sendJson(res, 200, { ok: true, n, texto: previo.texto });
    let texto = '';
    if (file.data.length > 2000) {
      try {
        texto = limpiarTexto(await transcribir(file.data, file.contentType, file.filename || `trozo-${n}.webm`, data));
      } catch (e) {
        console.error('[escucha] no se pudo transcribir:', e.message);
        return sendJson(res, 502, { error: 'No se pudo transcribir este trozo; se reintentará.' });
      }
    }
    // El audio (file.data) no se guarda: sale de memoria al terminar la petición.
    await withDb((db) => {
      const x = sesionDe(db, params.id, req.user);
      if (x && !x.trozos.some((t) => t.n === n)) x.trozos.push({ n, texto, at: new Date().toISOString() });
    });
    sendJson(res, 200, { ok: true, n, texto });
  }));

  router.post('/api/escucha/:id/terminar', requireRole(ROLES, async (req, res, params) => {
    const data = load();
    const s = sesionDe(data, params.id, req.user);
    if (!s) return sendJson(res, 404, { error: 'Sesión no encontrada' });
    const texto = [...s.trozos].sort((a, b) => a.n - b.n).map((t) => t.texto).filter(Boolean).join('\n');
    if (texto.replace(/\s/g, '').length < 40) return sendJson(res, 400, { error: 'No alcancé a escuchar nada claro. Revisa que el micrófono esté cerca y sin silenciar, e inténtalo de nuevo.' });
    const acta = await ordenarActa(`${s.titulo ? `Reunión: ${s.titulo}\n` : ''}${texto}`, req.user, data, hoyEnChile(), { transcripcion: true });
    if (s.titulo && /^Reunión del /.test(acta.titulo)) acta.titulo = s.titulo;
    const asignables = assignableUsersFor(req.user, data).map((u) => ({ id: u.id, name: u.name }));
    if (!asignables.some((u) => u.id === req.user.id)) asignables.unshift({ id: req.user.id, name: req.user.name });
    sendJson(res, 200, {
      acta, asignables, transcripcion: texto,
      tipos: isObispadoLeader(req.user, data) ? ['general', 'consejo_barrio', 'coordinacion_ministracion'] : ['general'],
    });
  }));

  router.post('/api/escucha/:id/guardar', requireRole(ROLES, async (req, res, params, body) => {
    const data = load();
    const s = sesionDe(data, params.id, req.user);
    if (!s) return sendJson(res, 404, { error: 'Sesión no encontrada' });
    const a = body?.acta || {};
    const fechaOk = (f) => (typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f) ? f : null);
    const asignables = new Set([req.user.id, ...assignableUsersFor(req.user, data).map((u) => u.id)]);
    const obispado = isObispadoLeader(req.user, data);
    const acta = {
      titulo: String(a.titulo || '').trim().slice(0, 100) || 'Reunión',
      tipo: obispado && ['consejo_barrio', 'coordinacion_ministracion'].includes(a.tipo) ? a.tipo : 'general',
      fecha: fechaOk(a.fecha) || new Date().toISOString().slice(0, 10),
      temas: (Array.isArray(a.temas) ? a.temas : []).filter((t) => String(t?.tema || '').trim()).slice(0, 30).map((t) => ({
        tema: String(t.tema).trim().slice(0, 150), notas: String(t.notas || '').trim().slice(0, 1500), acuerdo: String(t.acuerdo || '').trim().slice(0, 800),
      })),
      compromisos: (Array.isArray(a.compromisos) ? a.compromisos : []).filter((c) => String(c?.descripcion || '').trim() && fechaOk(c.fecha)).slice(0, 40).map((c) => ({
        userId: asignables.has(Number(c.userId)) ? Number(c.userId) : req.user.id,
        nombre: 'ok', dicho: '', descripcion: String(c.descripcion).trim().slice(0, 300), fecha: c.fecha,
      })),
    };
    const m = await guardarActaCore(acta, req.user, { escuchadoConDeseret: true, confidential: !!a.confidencial });
    // Listo: se borra la transcripción.
    await withDb((db) => { db.escuchas = (db.escuchas || []).filter((x) => x.id !== s.id); });
    vaciarCache();
    sendJson(res, 201, { ok: true, meetingId: m.id, temas: m.agendaItems.length, compromisos: m.commitments.length });
  }));

  router.delete('/api/escucha/:id', requireRole(ROLES, async (req, res, params) => {
    await withDb((db) => { db.escuchas = (db.escuchas || []).filter((x) => !(x.id === Number(params.id) && Number(x.userId) === Number(req.user.id))); });
    sendJson(res, 200, { ok: true });
  }));
}

