// ----------------------------------------------------------------------
// VOZ DE DESERET (texto → audio) con Azure Speech — voces neuronales de
// Chile (es-CL-CatalinaNeural / es-CL-LorenzoNeural).
// ----------------------------------------------------------------------
// Variables de entorno (Render → Environment):
//   AZURE_SPEECH_KEY     clave del recurso "Speech" de Azure (obligatoria)
//   AZURE_SPEECH_REGION  región del recurso, ej. "brazilsouth" o "eastus"
//   AZURE_SPEECH_VOICE   opcional, por defecto "es-CL-CatalinaNeural"
//
// Sin clave, GET /api/tts/estado responde { disponible: false } y el chat
// sigue usando la voz del navegador, como antes.
//
// El plan gratuito (F0) de Azure trae una cuota mensual de caracteres; para
// no gastarla de más: se limita el largo del texto, hay un límite por
// persona por minuto y un pequeño caché de los audios repetidos (saludos,
// "¿Lo registro así?", etc.).
// ----------------------------------------------------------------------
import { sendJson } from '../router.js';
import { requireAuth } from '../guard.js';

const MAX_CHARS = 900;
const POR_MINUTO = 20;
const CACHE_MAX = 60;

const config = () => ({
  key: process.env.AZURE_SPEECH_KEY || '',
  region: (process.env.AZURE_SPEECH_REGION || '').trim(),
  voz: (process.env.AZURE_SPEECH_VOICE || 'es-CL-CatalinaNeural').trim(),
});
export const ttsDisponible = () => { const c = config(); return !!(c.key && c.region); };

const cache = new Map();          // texto → Buffer mp3
const usos = new Map();           // userId → [timestamps]

function limitado(userId) {
  const ahora = Date.now();
  const l = (usos.get(userId) || []).filter((t) => ahora - t < 60_000);
  l.push(ahora);
  usos.set(userId, l);
  return l.length > POR_MINUTO;
}

const escXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// Texto del chat → texto para hablar: sin markdown, emojis ni enlaces.
export function limpiarParaVoz(texto) {
  return String(texto || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>«»]/g, '')
    .replace(/\p{Extended_Pictographic}|️/gu, '')
    .replace(/\s*·\s*/g, '. ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
    .slice(0, MAX_CHARS);
}

async function sintetizar(texto) {
  const { key, region, voz } = config();
  const lang = voz.slice(0, 5);
  // Velocidad un poco más pausada que la normal, y una pausa entre cada
  // línea (cada dato de una ficha o de una lista), como al leer en voz alta.
  const cuerpo = texto.split('\n').map((l) => escXml(l.trim())).filter(Boolean).join('<break time="450ms"/>');
  const ssml = `<speak version="1.0" xml:lang="${lang}" xmlns="http://www.w3.org/2001/10/synthesis"><voice name="${escXml(voz)}"><prosody rate="-5%">${cuerpo}</prosody></voice></speak>`;
  const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'OrganizaSion',
    },
    body: ssml,
    signal: AbortSignal.timeout(12_000),
  });
  if (!r.ok) throw new Error(`Azure TTS ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export function registerTtsRoutes(router) {
  router.get('/api/tts/estado', requireAuth(async (req, res) => {
    sendJson(res, 200, { disponible: ttsDisponible(), voz: ttsDisponible() ? config().voz : null });
  }));

  router.post('/api/tts', requireAuth(async (req, res, params, body) => {
    if (!ttsDisponible()) return sendJson(res, 503, { error: 'Voz de Azure no configurada' });
    const texto = limpiarParaVoz(body?.texto);
    if (!texto) return sendJson(res, 400, { error: 'Sin texto' });
    if (limitado(req.user.id)) return sendJson(res, 429, { error: 'Demasiadas solicitudes de voz' });
    try {
      let audio = cache.get(texto);
      if (!audio) {
        audio = await sintetizar(texto);
        cache.set(texto, audio);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
      res.end(audio);
    } catch (e) {
      console.error('[tts]', e.message);
      sendJson(res, 502, { error: 'No se pudo generar la voz' });
    }
  }));
}
