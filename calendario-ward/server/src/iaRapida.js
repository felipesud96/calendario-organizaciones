// ----------------------------------------------------------------------
// IA "rápida" para respuestas cortas dentro de la app (buscador, lectura
// del tablero): primero Groq (responde en ~1 s) y, si no hay clave o falla,
// Gemini con un tope de tiempo, para que nada se quede cargando.
// ----------------------------------------------------------------------
import { jsonConIA, redactarConIA } from './chat.js';

export const conTope = (promesa, ms, que = 'IA') => Promise.race([
  promesa,
  new Promise((_, mal) => setTimeout(() => mal(new Error(`${que}: sin respuesta en ${ms / 1000} s`)), ms)),
]);

async function groq(sistema, texto, { json = false, temperatura = 0.3, ms = 12_000 } = {}) {
  if (!process.env.GROQ_API_KEY) return null;
  try {
    const r = await fetch(process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        temperature: temperatura,
        max_tokens: 1500,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        messages: [{ role: 'system', content: sistema }, { role: 'user', content: texto }],
      }),
      signal: AbortSignal.timeout(ms),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    return String(j?.choices?.[0]?.message?.content || '').trim() || null;
  } catch (e) {
    console.warn('[ia rápida] Groq:', String(e.message).slice(0, 160));
    return null;
  }
}

// Planificador JSON (misma firma que jsonConIA).
export async function jsonRapido(sistema, texto) {
  const t = await groq(sistema, texto, { json: true, temperatura: 0 });
  if (t) { try { return JSON.parse(t.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); } catch (e) { /* sigue */ } }
  try { return await conTope(jsonConIA(sistema, texto), 15_000, 'Gemini'); } catch (e) { console.warn('[ia rápida]', e.message); return null; }
}

// Redactor de texto (misma firma que redactarConIA).
export async function textoRapido(sistema, historial, mensaje, temperatura = 0.4) {
  const t = await groq(sistema, mensaje, { temperatura });
  if (t) return t;
  try { return await conTope(redactarConIA(sistema, historial || [], mensaje), 15_000, 'Gemini'); } catch (e) { console.warn('[ia rápida]', e.message); return null; }
}
