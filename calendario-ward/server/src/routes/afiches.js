// ----------------------------------------------------------------------
// GENERADOR DE AFICHES para actividades — imágenes con IA, gratis.
// ----------------------------------------------------------------------
// La ilustración la pinta FLUX.1 [schnell] en Cloudflare Workers AI (nivel
// gratuito diario: 10.000 "neurons", y cada imagen de 1024x1024 usa ~58, o
// sea ~170 imágenes al día). El texto (título, fecha, lugar, QR) NO lo
// escribe la IA: lo dibuja la app encima, así sale sin faltas.
//
// Deseret (Gemini) traduce la idea de la persona —en español, simple— a un
// buen prompt en inglés, con reglas fijas de contenido (sin texto, sin
// logos, sin figuras sagradas ni templos, ropa modesta).
//
// Variables de entorno (Render → Environment):
//   CLOUDFLARE_ACCOUNT_ID   ID de la cuenta de Cloudflare (obligatoria)
//   CLOUDFLARE_API_TOKEN    token con permiso "Workers AI" (obligatoria)
//   AFICHES_POR_DIA         opcional, tope diario del barrio (por defecto 120)
//
// Las imágenes se guardan como .jpg en una carpeta junto a la base de datos
// (no dentro de db.json). Se conservan las últimas ~80 del barrio, más las
// que quedaron adjuntas a una actividad.
//
// Rutas (todos menos el rol "member"; ver la imagen: cualquiera con sesión):
//   GET    /api/afiches/estado         ¿hay servicio? ¿cuántos quedan hoy?
//   POST   /api/afiches/idea           Deseret sugiere una idea (texto)
//   POST   /api/afiches/generar        pinta una imagen nueva
//   GET    /api/afiches                galería del barrio
//   GET    /api/afiches/:id/imagen     la imagen (?final=1: con el texto)
//   POST   /api/afiches/:id/adjuntar   multipart: final (jpg), eventId
//   DELETE /api/afiches/:id
// ----------------------------------------------------------------------
import fs from 'fs';
import path from 'path';
import { sendJson } from '../router.js';
import { requireAuth } from '../guard.js';
import { load, withDb, nextId, DB_PATH } from '../db.js';
import { canEditOrg } from './events.js';
import { clienteGemini, GEMINI_MODEL } from '../chat.js';

const MODELO = '@cf/black-forest-labs/flux-1-schnell';
const POR_MINUTO = 8;
const GUARDAR_MAX = 80;
const DIR = process.env.AFICHES_DIR || path.join(path.dirname(DB_PATH), 'afiches');

const config = () => ({
  cuenta: (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim(),
  token: (process.env.CLOUDFLARE_API_TOKEN || '').trim(),
  url: process.env.CLOUDFLARE_AI_URL || '',
});
export const afichesDisponible = () => { const c = config(); return !!(c.cuenta && c.token); };
const topeDiario = () => Math.max(1, Number(process.env.AFICHES_POR_DIA) || 120);
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ_APP || 'America/Santiago' }).format(new Date());
const puedeCrear = (u) => !!u && u.role !== 'member';

const usos = new Map();
function limitado(userId) {
  const ahora = Date.now();
  const l = (usos.get(userId) || []).filter((t) => ahora - t < 60_000);
  l.push(ahora); usos.set(userId, l);
  return l.length > POR_MINUTO;
}
function usadosHoy(data) {
  const u = data.afichesUso || {};
  return u.fecha === hoy() ? (u.n || 0) : 0;
}

// ---------------- de la idea en español al prompt en inglés ----------------
const MAPA = {
  publico: { todos: 'people of all ages', ninos: 'children', jovenes: 'teenagers and young people', adultos: 'adults', familias: 'families with parents and children' },
  ambiente: { alegre: 'joyful, bright and cheerful mood', reverente: 'peaceful, reverent and spiritual mood, soft light', festivo: 'festive, celebratory mood with lights and color', tranquilo: 'calm, serene and cozy mood' },
  aparece: { personas: 'with people as the main subject', paisaje: 'a landscape or scenery as the main subject, people small or absent', objetos: 'meaningful objects as the main subject, still life, no people', sinpersonas: 'no people at all' },
  estilo: {
    acuarela: 'soft watercolor painting, paper texture, gentle washes of color',
    realista: 'photorealistic, cinematic photography, natural light, high detail',
    moderno: 'modern flat vector illustration, clean shapes, bold harmonious colors',
    infantil: 'cute children book illustration, playful, rounded shapes, bright colors',
    elegante: 'elegant, refined, minimal composition, muted premium colors, subtle gold accents',
    animado: '3D animated movie style, expressive, colorful, soft lighting',
  },
  retoque: {
    colorido: 'more vibrant and saturated colors',
    sobrio: 'more sober, muted and elegant color palette',
    sinpersonas: 'remove all people, no people at all',
    luz: 'brighter image, more light, luminous',
    fondo: 'a different background setting',
  },
};
const REGLAS_EN = 'No text, no letters, no words, no numbers, no logos, no watermarks. Modest clothing (covered shoulders, knee-length or longer). Family-friendly.';
const FORMATO_EN = {
  historia: 'vertical composition with the main subject in the center, calm areas at the top and bottom',
  cuadrado: 'centered square composition',
  carta: 'poster composition, main subject in the center, calm area at the top',
};

function promptBasico(o) {
  const partes = [
    o.idea || o.titulo || 'a friendly community gathering',
    o.publico && MAPA.publico[o.publico] ? `for ${MAPA.publico[o.publico]}` : '',
    MAPA.ambiente[o.ambiente] || '',
    MAPA.aparece[o.aparece] || '',
    o.estiloLibre ? o.estiloLibre : (MAPA.estilo[o.estilo] || 'beautiful illustration'),
    FORMATO_EN[o.formato] || '',
    ...(o.retoques || []).map((r) => MAPA.retoque[r]).filter(Boolean),
    REGLAS_EN,
  ];
  return partes.filter(Boolean).join(', ').slice(0, 1900);
}

// Deseret redacta con Gemini; si Gemini está saturado (503) se reintenta una
// vez y, si sigue fallando, se usa Groq (si hay clave). Sin ninguno, se arma
// un prompt básico con las opciones elegidas.
const conTope = (promesa, ms, que) => Promise.race([promesa, new Promise((_, mal) => setTimeout(() => mal(new Error(`${que}: sin respuesta en ${ms / 1000} s`)), ms))]);

// Redactar el prompt: primero Groq (responde en ~1 s), y si no hay clave o
// falla, Gemini (con tope de 10 s y un reintento si está saturado). Sin
// ninguno, se arma un prompt básico con las opciones elegidas.
async function preguntarGroq(sistema, texto, temperatura) {
  if (!process.env.GROQ_API_KEY) return null;
  try {
    const r = await fetch(process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', temperature: temperatura, messages: [{ role: 'system', content: sistema }, { role: 'user', content: texto }] }),
      signal: AbortSignal.timeout(12_000),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    return String(j?.choices?.[0]?.message?.content || '').trim() || null;
  } catch (e) {
    console.warn('[afiches] Groq:', String(e.message).slice(0, 160));
    return null;
  }
}
async function preguntarGemini(sistema, texto, temperatura = 0.7) {
  const rapido = await preguntarGroq(sistema, texto, temperatura);
  if (rapido) return rapido;
  const g = clienteGemini();
  if (!g) return null;
  for (let intento = 0; intento < 2; intento += 1) {
    try {
      const r = await conTope(g.models.generateContent({
        model: GEMINI_MODEL(),
        contents: [{ role: 'user', parts: [{ text: texto }] }],
        config: { systemInstruction: sistema, temperature: temperatura },
      }), 10_000, 'Gemini');
      const t = String(r?.text || '').trim();
      if (t) return t;
    } catch (e) {
      console.warn('[afiches] Gemini:', String(e.message).slice(0, 160));
      if (!/503|UNAVAILABLE|overloaded|high demand|429|RESOURCE_EXHAUSTED/i.test(String(e.message)) || intento) break;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  }
  return null;
}

const SISTEMA_PROMPT = `You write prompts for the FLUX image model to illustrate posters for activities of a local congregation (ward) of The Church of Jesus Christ of Latter-day Saints in Chile.
Return ONLY the prompt, in English, 50-110 words, one paragraph, no quotes.
Always: describe a concrete scene, lighting, colors, composition and the requested art style.
Hard rules (always add them): no text, letters, words or numbers in the image; no logos; do NOT depict Jesus Christ, God, angels, prophets, temples, church buildings with steeples, scriptures with visible text or sacred ordinances — use symbolic, everyday scenes instead (families, nature, light, service, friendship); modest clothing (covered shoulders, knee-length or longer); family-friendly; people of Latin American appearance when people appear.
If a previous prompt is given with requested changes, keep everything else and apply only the changes.`;

async function construirPrompt(o) {
  const pedido = [
    `Activity: ${o.titulo || '(none)'}${o.descripcion ? ` — ${o.descripcion}` : ''}${o.organizacion ? ` (organized by: ${o.organizacion})` : ''}`,
    o.idea ? `What the person imagines (Spanish): ${o.idea}` : 'The person gave no idea: propose a fitting scene.',
    o.publico ? `Audience: ${MAPA.publico[o.publico] || o.publico}` : '',
    o.ambiente ? `Mood: ${MAPA.ambiente[o.ambiente] || o.ambiente}` : '',
    o.aparece ? `Subject: ${MAPA.aparece[o.aparece] || o.aparece}` : '',
    `Art style: ${o.estiloLibre ? `(the person wrote, in Spanish) ${o.estiloLibre}` : (MAPA.estilo[o.estilo] || 'choose the style that best fits')}`,
    `Composition: ${FORMATO_EN[o.formato] || FORMATO_EN.historia}`,
    o.previo ? `Previous prompt: ${o.previo}` : '',
    (o.retoques || []).length ? `Requested changes: ${(o.retoques || []).map((r) => MAPA.retoque[r] || r).join('; ')}` : '',
  ].filter(Boolean).join('\n');
  const r = await preguntarGemini(SISTEMA_PROMPT, pedido, 0.6);
  if (r && r.length > 30) return r.replace(/^["']|["']$/g, '').slice(0, 1800).trim();
  return promptBasico(o);
}

// ---------------- Cloudflare ----------------
async function pintar(prompt) {
  const c = config();
  const url = c.url || `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(c.cuenta)}/ai/run/${MODELO}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    // (FLUX schnell en Cloudflare no acepta "seed": cada pedido ya sale distinto.)
    body: JSON.stringify({ prompt, steps: 4 }),
    signal: AbortSignal.timeout(45_000),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { /* nada */ }
  if (!r.ok || (j && j.success === false)) {
    const msg = j?.errors?.[0]?.message || `HTTP ${r.status}`;
    const e = new Error(msg); e.status = r.status; throw e;
  }
  const b64 = j?.result?.image || j?.image;
  if (!b64) throw new Error('Cloudflare no devolvió imagen');
  return Buffer.from(b64, 'base64');
}

const archivo = (id, final = false) => path.join(DIR, `${Number(id)}${final ? '-final' : ''}.jpg`);
function borrarArchivos(id) {
  for (const f of [archivo(id), archivo(id, true)]) { try { fs.unlinkSync(f); } catch (e) { /* ya no está */ } }
}
const publico = (a, data) => ({
  id: a.id, titulo: a.titulo, eventId: a.eventId || null, opciones: a.opciones, prompt: a.prompt, seed: a.seed,
  creadoEn: a.creadoEn, creadoPor: data.users.find((u) => u.id === a.userId)?.name || '', final: !!a.final,
});

export function registerAfichesRoutes(router) {
  router.get('/api/afiches/estado', requireAuth(async (req, res) => {
    const data = load();
    sendJson(res, 200, { disponible: afichesDisponible(), puedeCrear: puedeCrear(req.user), quedanHoy: Math.max(0, topeDiario() - usadosHoy(data)), tope: topeDiario() });
  }));

  router.post('/api/afiches/idea', requireAuth(async (req, res, params, body) => {
    if (!puedeCrear(req.user)) return sendJson(res, 403, { error: 'No tienes permiso' });
    const b = body || {};
    const r = await preguntarGemini(
      'Eres Deseret, asistente de un barrio de La Iglesia de Jesucristo de los Santos de los Últimos Días en Chile. Propón UNA idea de imagen para el afiche de una actividad: una escena concreta y bonita, en español de Chile, de 12 a 25 palabras, sin comillas. No propongas mostrar a Jesucristo, templos, ángeles ni texto escrito. Si te dan una idea anterior, propone algo distinto.',
      `Actividad: ${String(b.titulo || '').slice(0, 120)}\n${b.descripcion ? `Detalle: ${String(b.descripcion).slice(0, 300)}\n` : ''}${b.anterior ? `Idea anterior: ${String(b.anterior).slice(0, 300)}` : ''}`,
      1,
    );
    if (!r) return sendJson(res, 503, { error: 'Deseret no pudo sugerir una idea ahora' });
    sendJson(res, 200, { idea: r.replace(/^["'«]|["'»]$/g, '').slice(0, 300) });
  }));

  router.post('/api/afiches/generar', requireAuth(async (req, res, params, body) => {
    if (!puedeCrear(req.user)) return sendJson(res, 403, { error: 'No tienes permiso para crear afiches' });
    if (!afichesDisponible()) return sendJson(res, 503, { error: 'El generador de afiches aún no está configurado (faltan los datos de Cloudflare en Render).' });
    if (limitado(req.user.id)) return sendJson(res, 429, { error: 'Vas muy rápido: espera un minuto antes de pedir más afiches.' });
    const b = body || {};
    const txt = (v, n) => String(v || '').trim().slice(0, n);
    const o = {
      titulo: txt(b.titulo, 120), descripcion: txt(b.descripcion, 300), organizacion: txt(b.organizacion, 80),
      idea: txt(b.idea, 500), publico: txt(b.publico, 20), ambiente: txt(b.ambiente, 20), aparece: txt(b.aparece, 20),
      estilo: txt(b.estilo, 20), estiloLibre: txt(b.estiloLibre, 200), formato: ['historia', 'cuadrado', 'carta'].includes(b.formato) ? b.formato : 'historia',
      retoques: (Array.isArray(b.retoques) ? b.retoques : []).map((r) => txt(r, 20)).filter((r) => MAPA.retoque[r]).slice(0, 5),
      previo: txt(b.promptPrevio, 1900),
    };
    const eventId = Number(b.eventId) || null;
    // Reservar el cupo antes de pintar (dos pedidos a la vez no se pasan del tope).
    const cupo = await withDb((db) => {
      const fecha = hoy();
      if (!db.afichesUso || db.afichesUso.fecha !== fecha) db.afichesUso = { fecha, n: 0 };
      if (db.afichesUso.n >= topeDiario()) return false;
      db.afichesUso.n += 1;
      return true;
    });
    if (!cupo) return sendJson(res, 429, { error: 'Se alcanzó el máximo de afiches gratis por hoy. Mañana se renueva.' });
    const devolverCupo = () => withDb((db) => { if (db.afichesUso?.fecha === hoy() && db.afichesUso.n > 0) db.afichesUso.n -= 1; }).catch(() => {});
    try {
      // "Otra versión" (sin cambios) reutiliza el mismo prompt con otra semilla.
      const t0 = Date.now();
      console.log(`[afiches] ${req.user.name || req.user.id} pide un afiche: "${o.titulo || o.idea.slice(0, 40)}"`);
      const prompt = o.previo && !o.retoques.length && b.mismoPrompt ? o.previo : await construirPrompt(o);
      console.log(`[afiches] prompt listo en ${((Date.now() - t0) / 1000).toFixed(1)} s; pintando en Cloudflare…`);
      // Para que "Otra versión" no se parezca demasiado, se varía un poco el encuadre.
      const VARIANTES = ['wide shot', 'medium shot', 'slightly different angle', 'soft morning light', 'warm golden hour light', 'gentle depth of field', 'from a low angle'];
      const extra = b.mismoPrompt ? VARIANTES[Math.floor(Math.random() * VARIANTES.length)] : '';
      const seed = null;
      const img = await pintar(extra ? `${prompt} ${extra}.` : prompt);
      console.log(`[afiches] imagen lista (${Math.round(img.length / 1024)} KB) en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      fs.mkdirSync(DIR, { recursive: true });
      const afiche = await withDb((db) => {
        db.afiches = db.afiches || [];
        const a = {
          id: nextId(db, 'afiches'), userId: req.user.id, eventId, titulo: o.titulo || 'Afiche', prompt, seed,
          opciones: { idea: o.idea, publico: o.publico, ambiente: o.ambiente, aparece: o.aparece, estilo: o.estilo, estiloLibre: o.estiloLibre, formato: o.formato },
          creadoEn: new Date().toISOString(), final: false,
        };
        fs.writeFileSync(archivo(a.id), img);
        db.afiches.push(a);
        // Limpieza: se guardan los últimos GUARDAR_MAX (más los adjuntos a una actividad).
        const adjuntos = new Set(db.events.filter((e) => e.posterId).map((e) => Number(e.posterId)));
        const sueltos = db.afiches.filter((x) => !adjuntos.has(x.id));
        const sobran = sueltos.slice(0, Math.max(0, sueltos.length - GUARDAR_MAX));
        if (sobran.length) {
          const fuera = new Set(sobran.map((x) => x.id));
          sobran.forEach((x) => borrarArchivos(x.id));
          db.afiches = db.afiches.filter((x) => !fuera.has(x.id));
        }
        return a;
      });
      const data = load();
      sendJson(res, 200, { afiche: publico(afiche, data), quedanHoy: Math.max(0, topeDiario() - usadosHoy(data)) });
    } catch (e) {
      await devolverCupo();
      console.error('[afiches]', e.status || '', e.message);
      const msg = e.status === 429 ? 'Se agotó la cuota gratis de Cloudflare por hoy. Mañana se renueva.'
        : (e.status === 401 || e.status === 403) ? 'Cloudflare rechazó la clave: revisa CLOUDFLARE_ACCOUNT_ID y CLOUDFLARE_API_TOKEN en Render.'
          : /flag|nsfw|safety/i.test(e.message) ? 'La imagen fue bloqueada por el filtro de contenido. Prueba describiéndola de otra forma.'
            : /timeout|aborted|sin respuesta/i.test(e.message) ? 'Cloudflare tardó demasiado en responder. Inténtalo de nuevo.'
            : 'No se pudo pintar el afiche ahora. Inténtalo de nuevo en un momento.';
      sendJson(res, 502, { error: msg });
    }
  }));

  router.get('/api/afiches', requireAuth(async (req, res) => {
    if (!puedeCrear(req.user)) return sendJson(res, 200, { afiches: [] });
    const data = load();
    const lista = (data.afiches || []).slice(-40).reverse().map((a) => publico(a, data));
    sendJson(res, 200, { afiches: lista });
  }));

  router.get('/api/afiches/:id/imagen', requireAuth(async (req, res, params) => {
    const data = load();
    const a = (data.afiches || []).find((x) => x.id === Number(params.id));
    if (!a) return sendJson(res, 404, { error: 'Afiche no encontrado' });
    const quiereFinal = req.query?.final === '1' && a.final;
    const f = archivo(a.id, quiereFinal);
    if (!fs.existsSync(f)) return sendJson(res, 404, { error: 'La imagen ya no está disponible' });
    const buf = fs.readFileSync(f);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400' });
    res.end(buf);
  }));

  router.post('/api/afiches/:id/adjuntar', requireAuth(async (req, res, params, body) => {
    const data = load();
    const a = (data.afiches || []).find((x) => x.id === Number(params.id));
    if (!a) return sendJson(res, 404, { error: 'Afiche no encontrado' });
    const campos = body?.fields || {};
    const eventId = Number(campos.eventId);
    const ev = data.events.find((e) => e.id === eventId);
    if (!ev) return sendJson(res, 404, { error: 'Actividad no encontrada' });
    if (!canEditOrg(req.user, ev.organizationId)) return sendJson(res, 403, { error: 'Solo quien administra esta actividad puede adjuntarle el afiche' });
    const f = (body?.files || []).find((x) => x.field === 'final');
    if (!f || !/^image\/jpe?g$/i.test(f.contentType) || f.data.length > 6 * 1024 * 1024 || f.data[0] !== 0xff || f.data[1] !== 0xd8) {
      return sendJson(res, 400, { error: 'Falta la imagen del afiche (JPG)' });
    }
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(archivo(a.id, true), f.data);
    await withDb((db) => {
      const x = (db.afiches || []).find((y) => y.id === a.id);
      if (x) { x.final = true; x.eventId = eventId; }
      const e = db.events.find((y) => y.id === eventId);
      if (e) e.posterId = a.id;
    });
    sendJson(res, 200, { ok: true, posterId: a.id });
  }));

  router.delete('/api/afiches/:id', requireAuth(async (req, res, params) => {
    const data = load();
    const a = (data.afiches || []).find((x) => x.id === Number(params.id));
    if (!a) return sendJson(res, 404, { error: 'Afiche no encontrado' });
    if (a.userId !== req.user.id && req.user.role !== 'admin') return sendJson(res, 403, { error: 'Solo quien lo creó puede borrarlo' });
    await withDb((db) => {
      db.afiches = (db.afiches || []).filter((x) => x.id !== a.id);
      db.events.forEach((e) => { if (Number(e.posterId) === a.id) delete e.posterId; });
    });
    borrarArchivos(a.id);
    sendJson(res, 200, { ok: true });
  }));
}
