// ----------------------------------------------------------------------
// LEER BOLETA CON FOTO → llenar el gasto del presupuesto
// ----------------------------------------------------------------------
// En "Registrar gasto" y "Solicitar aprobación de gasto" hay un botón
// "Leer boleta": la persona saca una foto (o elige una de la galería), la
// app la achica en el navegador y la manda acá. La IA con visión lee el
// total, la fecha, el comercio y lo comprado, y devuelve esos datos para
// PRELLENAR el formulario: la persona revisa y recién ahí guarda.
//
// Proveedores: Gemini (GEMINI_API_KEY) y, si falla o está saturado, Groq
// con un modelo de visión (GROQ_API_KEY; GROQ_VISION_MODEL opcional).
// La foto NO se guarda: se usa para leerla y se descarta.
//
//   POST /api/budget/boleta   multipart: foto (jpg/png/webp)
// ----------------------------------------------------------------------
import { sendJson } from '../router.js';
import { requireRole } from '../guard.js';
import { clienteGemini, GEMINI_MODEL } from '../chat.js';

const MAX = 8 * 1024 * 1024;
const POR_MINUTO = 10;
const usos = new Map();
function limitado(id) {
  const ahora = Date.now();
  const l = (usos.get(id) || []).filter((t) => ahora - t < 60_000);
  l.push(ahora); usos.set(id, l);
  return l.length > POR_MINUTO;
}
const conTope = (p, ms, que) => Promise.race([p, new Promise((_, mal) => setTimeout(() => mal(new Error(`${que}: sin respuesta en ${ms / 1000} s`)), ms))]);

const INSTRUCCION = `Lees boletas y facturas de Chile (supermercados, librerías, ferreterías, comida, transporte, etc.) para registrar un gasto.
Responde SOLO un objeto JSON, sin texto adicional, con estas claves:
{"legible": true|false, "monto": número entero en pesos chilenos (el TOTAL a pagar, sin puntos ni signo $), "fecha": "YYYY-MM-DD" o null, "comercio": "nombre del local" o "", "descripcion": "qué se compró, en 3 a 8 palabras, en español", "items": ["hasta 6 productos principales, cortos"]}
Reglas: en Chile el punto separa miles ("12.990" = 12990). Usa el TOTAL final (no el neto, no el IVA, no el vuelto ni el "efectivo"/"pagado"). Si hay propina, inclúyela solo si está sumada al total. Fechas chilenas vienen como DD/MM/AAAA o DD-MM-AA. Si la imagen no es una boleta o no se lee el total, responde {"legible": false}.`;

function limpiarJson(t) {
  const m = String(t || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}
function normalizar(j) {
  if (!j || j.legible === false) return { legible: false };
  let monto = j.monto;
  if (typeof monto === 'string') monto = Number(monto.replace(/[^\d]/g, ''));
  monto = Number.isFinite(monto) && monto > 0 ? Math.round(monto) : null;
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(j.fecha || '')) ? j.fecha : null;
  const txt = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
  return {
    legible: !!monto,
    monto, fecha,
    comercio: txt(j.comercio, 60),
    descripcion: txt(j.descripcion, 100),
    items: (Array.isArray(j.items) ? j.items : []).map((x) => txt(x, 40)).filter(Boolean).slice(0, 6),
  };
}

async function leerConGemini(buf, mime) {
  const g = clienteGemini();
  if (!g) return null;
  for (let intento = 0; intento < 2; intento += 1) {
    try {
      const r = await conTope(g.models.generateContent({
        model: GEMINI_MODEL(),
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mime, data: buf.toString('base64') } }, { text: 'Lee esta boleta.' }] }],
        config: { systemInstruction: INSTRUCCION, temperature: 0, responseMimeType: 'application/json' },
      }), 20_000, 'Gemini');
      const j = limpiarJson(r?.text);
      if (j) return j;
    } catch (e) {
      console.warn('[boleta] Gemini:', String(e.message).slice(0, 160));
      if (!/503|UNAVAILABLE|overloaded|high demand|429|RESOURCE_EXHAUSTED/i.test(String(e.message)) || intento) break;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  }
  return null;
}

async function leerConGroq(buf, mime) {
  if (!process.env.GROQ_API_KEY) return null;
  try {
    const r = await fetch(process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: INSTRUCCION },
          { role: 'user', content: [{ type: 'text', text: 'Lee esta boleta.' }, { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } }] },
        ],
      }),
      signal: AbortSignal.timeout(25_000),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    return limpiarJson(j?.choices?.[0]?.message?.content);
  } catch (e) {
    console.warn('[boleta] Groq:', String(e.message).slice(0, 160));
    return null;
  }
}

export function registerBoletaRoutes(router) {
  router.post('/api/budget/boleta', requireRole(['admin', 'leader', 'financial_clerk'], async (req, res, params, body) => {
    if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) return sendJson(res, 503, { error: 'La lectura de boletas no está configurada' });
    if (limitado(req.user.id)) return sendJson(res, 429, { error: 'Espera un minuto antes de leer más boletas' });
    const f = (body?.files || []).find((x) => x.field === 'foto');
    if (!f || !/^image\/(jpe?g|png|webp)$/i.test(f.contentType) || !f.data?.length) return sendJson(res, 400, { error: 'Falta la foto de la boleta (JPG o PNG)' });
    if (f.data.length > MAX) return sendJson(res, 400, { error: 'La foto es muy grande' });
    const mime = f.contentType.toLowerCase().replace('jpg', 'jpeg');
    const t0 = Date.now();
    const j = (await leerConGemini(f.data, mime)) || (await leerConGroq(f.data, mime));
    if (!j) return sendJson(res, 502, { error: 'No se pudo leer la boleta ahora. Inténtalo de nuevo o escribe los datos a mano.' });
    const out = normalizar(j);
    console.log(`[boleta] leída en ${((Date.now() - t0) / 1000).toFixed(1)} s: ${out.legible ? `$${out.monto} ${out.fecha || ''} ${out.comercio}` : 'no legible'}`);
    sendJson(res, 200, out);
  }));
}
