import { GoogleGenAI } from '@google/genai';
import { load, withDb, nextId, interviewEligibility } from './db.js';
import { canEditOrg, PURPOSE_OPTIONS, orgRequiresSupervisingAdults } from './routes/events.js';
import { canScheduleOrg, orgAllowsInterviews, orgSeesAllInterviews } from './routes/interviews.js';
import { findStakeConflicts } from './stakeCalendar.js';
import { isObispadoLeader } from './routes/stake.js';
import { INDICATOR_DEFS, sortedQuarters, pctForIndicator } from './wardGrowth.js';
import { computeCuadrante, isAdultMale, isAdultFemale, CUADRANTES } from './pastoralFocus.js';
import { isMinisteringFocusLeaderHombres, isMinisteringFocusLeaderMujeres } from './routes/directory.js';

// Cache local en memoria para respuestas ultrarrápidas (<10 ms) — solo para
// preguntas de SOLO LECTURA (ver MÓDULO 2 más abajo). Nunca se usa para
// agendar, así que no hay riesgo de "responder de caché" una acción que en
// realidad no se ejecutó.
//
// Dos problemas que tenía la versión anterior, ya corregidos acá:
//   1. La llave era solo el texto del mensaje en minúsculas, sin importar
//      QUIÉN preguntaba — así que si un líder de Obispado preguntaba "¿qué
//      porcentaje tiene recomendación del templo?" (dato restringido a
//      Obispado/Administrador, ver isObispadoLeader más abajo) y después un
//      Miembro cualquiera escribía exactamente lo mismo, el Miembro recibía
//      la respuesta CACHEADA con el dato real, saltándose el permiso.
//      Ahora la llave incluye el alcance (rol + organización) de quien
//      pregunta, calculado igual que en el resto de la app.
//   2. El Map nunca se vaciaba ni expiraba — crecía para siempre mientras el
//      servidor estuviera corriendo. Ahora cada entrada expira sola
//      (CACHE_TTL_MS) y el total de entradas está acotado (CACHE_MAX_ENTRIES,
//      con desalojo FIFO simple aprovechando que un Map recorre sus llaves
//      en orden de inserción).
const cacheRespuestas = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos
const CACHE_MAX_ENTRIES = 500;

// La llave incluye el ID del usuario: algunas respuestas dependen de la
// persona (ej. "mis entrevistas" de un Miembro), no solo de su rol y
// organización — con rol+organización, dos miembros distintos podían
// recibir la respuesta cacheada del otro.
function scopeCacheParaUsuario(usuario) {
  if (!usuario) return 'anon';
  return `${usuario.id ?? ''}:${usuario.role || ''}:${usuario.organizationId ?? ''}`;
}

// Se llama cada vez que Deseret crea algo, para que una consulta hecha
// justo después ("¿qué entrevistas tengo?") no devuelva la lista vieja.
function vaciarCache() {
  cacheRespuestas.clear();
}

function claveCache(usuario, mensajeMinusculas) {
  return `${scopeCacheParaUsuario(usuario)}::${mensajeMinusculas}`;
}

function leerCache(clave) {
  const entry = cacheRespuestas.get(clave);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cacheRespuestas.delete(clave);
    return null;
  }
  return entry.value;
}

function guardarCache(clave, value) {
  if (!cacheRespuestas.has(clave) && cacheRespuestas.size >= CACHE_MAX_ENTRIES) {
    const masAntigua = cacheRespuestas.keys().next().value;
    cacheRespuestas.delete(masAntigua);
  }
  cacheRespuestas.set(clave, { value, ts: Date.now() });
}

function normalizeSearchText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// Fechas SIEMPRE en hora de Chile, sin importar la zona horaria del
// servidor (Render corre en UTC). Antes se usaba toISOString(), que
// convierte a UTC: después de las 21:00 en Chile "hoy" pasaba a ser
// mañana y las fechas calculadas quedaban corridas en un día.
const ZONA_HORARIA = process.env.TZ_APP || 'America/Santiago';

// Devuelve un Date "local" (a mediodía, para esquivar cambios de horario)
// con el día calendario actual de Chile.
function hoyEnChile() {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return new Date(Number(partes.year), Number(partes.month) - 1, Number(partes.day), 12, 0, 0);
}

function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const DIAS_INDEX = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
const MESES = { enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11 };

// Entiende fechas escritas de forma natural: ISO exacto, DD/MM(/AAAA),
// "15 de octubre", "hoy", "mañana", "pasado mañana", "en 3 días" y días de
// la semana ("el sábado", "el próximo lunes"). Devuelve AAAA-MM-DD o null
// si no logró reconocer ninguna fecha — a propósito NUNCA asume "hoy" por
// defecto en silencio (ese era el bug original): si no la encuentra, quien
// llama a esta función debe preguntar, no adivinar.
function parseFecha(mensajeMin, hoyObj) {
  const iso = mensajeMin.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];

  const dmY = mensajeMin.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (dmY) {
    const day = Number(dmY[1]);
    const month = Number(dmY[2]) - 1;
    let year = dmY[3] ? Number(dmY[3]) : hoyObj.getFullYear();
    if (year < 100) year += 2000;
    const d = new Date(year, month, day, 12);
    if (!Number.isNaN(d.getTime())) return toISO(d);
  }

  const deMes = mensajeMin.match(/\b(\d{1,2})\s+de\s+([a-záéíóúñ]+)(?:\s+de\s+(\d{4}))?\b/);
  if (deMes && MESES[deMes[2]] !== undefined) {
    const day = Number(deMes[1]);
    const month = MESES[deMes[2]];
    const year = deMes[3] ? Number(deMes[3]) : hoyObj.getFullYear();
    const d = new Date(year, month, day, 12);
    if (!deMes[3] && toISO(d) < toISO(hoyObj)) d.setFullYear(year + 1); // ya pasó este año y no dijo año -> asume el próximo
    return toISO(d);
  }

  if (/\bhoy\b/.test(mensajeMin)) return toISO(hoyObj);
  if (/\bpasado\s*ma[ñn]ana\b/.test(mensajeMin)) {
    const d = new Date(hoyObj); d.setDate(d.getDate() + 2); return toISO(d);
  }
  if (/\bma[ñn]ana\b/.test(mensajeMin)) {
    const d = new Date(hoyObj); d.setDate(d.getDate() + 1); return toISO(d);
  }
  const enDias = mensajeMin.match(/\ben\s+(\d+)\s+d[ií]as?\b/);
  if (enDias) {
    const d = new Date(hoyObj); d.setDate(d.getDate() + Number(enDias[1])); return toISO(d);
  }

  for (const nombre of Object.keys(DIAS_INDEX)) {
    const normalizado = nombre.replace('sabado', 's[áa]bado').replace('miercoles', 'mi[eé]rcoles');
    const re = new RegExp(`\\b${normalizado}\\b`);
    if (re.test(mensajeMin)) {
      const target = DIAS_INDEX[nombre];
      const d = new Date(hoyObj);
      let diff = (target - d.getDay() + 7) % 7;
      if (diff === 0 && /pr[oó]xim[oa]/.test(mensajeMin)) diff = 7; // "el próximo sábado" dicho UN sábado -> en 7 días
      d.setDate(d.getDate() + diff);
      return toISO(d);
    }
  }
  return null;
}

// Entiende horas en formato "19:30", "a las 7", "a las 7:30 pm", "7pm".
// Igual que parseFecha, devuelve null si no encuentra nada en vez de
// asumir un valor por defecto en silencio.
function parseHora(mensajeMin) {
  // "p.m." / "p. m." / "hrs" se normalizan antes de buscar la hora.
  const txt = mensajeMin
    .replace(/\bp\.?\s?m\.?(?=\s|$|[,.!?])/g, 'pm')
    .replace(/\ba\.?\s?m\.?(?=\s|$|[,.!?])/g, 'am');
  // "de la tarde/noche" = pm; "de la mañana" = am.
  const tardeNoche = /\bde\s+la\s+(tarde|noche)\b/.test(txt);
  const manana = /\bde\s+la\s+ma[ñn]ana\b/.test(txt);
  let m = txt.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/);
  if (m) {
    let h = Number(m[1]);
    const ampm = m[3] || (tardeNoche ? 'pm' : manana ? 'am' : null);
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m[2]}`;
  }
  m = txt.match(/\ba\s+las?\s+(\d{1,2})\s*(am|pm)?\b/) || txt.match(/\b(\d{1,2})\s*(am|pm)\b/) || txt.match(/\b(\d{1,2})\s*(?:hrs?|horas)\b/);
  if (m && Number(m[1]) <= 23) {
    let h = Number(m[1]);
    const ampm = m[2] || (tardeNoche ? 'pm' : manana ? 'am' : null);
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    if (!ampm && h > 0 && h <= 7) h += 12; // "a las 7" para una actividad de barrio casi siempre es de noche
    return `${String(h).padStart(2, '0')}:00`;
  }
  return null;
}

// Alias comunes (abreviaciones, formas de decirlo hablado) hacia el nombre
// real de la organización en la base de datos — además del match directo
// por nombre, más abajo, que cubre cualquier organización sin necesidad de
// mantener esta lista al día si se agrega una nueva.
const ORG_ALIASES = {
  elderes: 'Cuórum de Élderes', 'cuórum de élderes': 'Cuórum de Élderes', cuorum: 'Cuórum de Élderes',
  socorro: 'Sociedad de Socorro',
  'hombres jóvenes': 'Hombres Jóvenes', hj: 'Hombres Jóvenes',
  'mujeres jóvenes': 'Mujeres Jóvenes', mj: 'Mujeres Jóvenes',
  jas: 'Jóvenes Adultos Solteros',
};

// Busca la palabra/frase completa (con límites de palabra) — con un
// includes() simple, "Pedro Rojas" coincidía con el alias "jas" (JAS) y
// "Camila Hjort" con "hj".
function contieneFrase(textoNorm, fraseNorm) {
  const escapada = fraseNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escapada}($|[^a-z0-9])`).test(textoNorm);
}

function inferOrganizationId(mensajeMin, orgs) {
  const norm = normalizeSearchText(mensajeMin);
  for (const [alias, nombreReal] of Object.entries(ORG_ALIASES)) {
    if (contieneFrase(norm, normalizeSearchText(alias))) {
      const org = orgs.find((o) => o.name === nombreReal);
      if (org) return org.id;
    }
  }
  for (const org of orgs) {
    const n = normalizeSearchText(org.name);
    if (n && contieneFrase(norm, n)) return org.id;
  }
  return null;
}

// El primer strip (verbo + artículo + "actividad/reunión/evento") deja el
// título pegado con el resto de la frase (fecha, hora, organización) — acá
// se corta en el primer conector que anuncie ese resto, para que el título
// final sea solo "Noche de hogar" y no "Noche de hogar para el sábado a las
// 19:30 con cuórum de élderes".
function limpiarTitulo(titulo) {
  const cortes = [
    /\bpara\s+(el|la|este|la\s+pr[oó]xim\w+|el\s+pr[oó]xim\w+)\b/i,
    /\bel\s+pr[oó]xim\w+\b/i,
    /\b(el|este)\s+(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i,
    /\ba\s+las?\s+\d/i,
    /\bcon\s+(cu[oó]rum|sociedad|primaria|hombres|mujeres|j[oó]venes|obispado)/i,
    /\bpara\s+(cu[oó]rum|sociedad|primaria|hombres|mujeres|j[oó]venes|obispado)/i,
    /\bpasado\s*ma[ñn]ana\b/i,
    /\bma[ñn]ana\b/i,
    /\bhoy\b/i,
    /\b\d{4}-\d{2}-\d{2}\b/,
    /\b\d{1,2}[/-]\d{1,2}\b/,
  ];
  let idxCorte = titulo.length;
  for (const re of cortes) {
    const m = titulo.match(re);
    if (m && m.index < idxCorte) idxCorte = m.index;
  }
  const limpio = titulo.slice(0, idxCorte).trim().replace(/[,.\s]+$/, '');
  return limpio || titulo.trim();
}

function inferPurpose(mensajeMin) {
  if (/(noche de hogar|devocional|espiritual|oraci[oó]n|testimonio|misional|escritura)/.test(mensajeMin)) return 'Espiritual';
  if (/(deportiv|f[uú]tbol|b[aá]squetbol|voleibol|caminata|trekking|ejercicio|gimnasia)/.test(mensajeMin)) return 'Físico';
  if (/(charla|capacitaci[oó]n|clase|taller|curso|acad[eé]mic)/.test(mensajeMin)) return 'Académico';
  if (/(servicio|voluntariado|limpieza comunitaria)/.test(mensajeMin)) return 'Servicio';
  if (/(convivencia|once|asado|fiesta|cumplea[ñn]os|paseo|social)/.test(mensajeMin)) return 'Social';
  return null;
}

// ----------------------------------------------------------------------
// BORRADORES DE AGENDAMIENTO (conversación en varios pasos)
// ----------------------------------------------------------------------
// Antes, si Deseret preguntaba "¿A quién quieres entrevistar?" o "¿A qué
// hora?", la respuesta del usuario ("con Juan Pérez", "a las 8") ya no
// empezaba con "agenda…", así que caía al módulo de CONSULTA — y la IA,
// viendo el historial, contestaba "¡Listo, agendada!" sin que se hubiera
// guardado nada. Ahora el servidor recuerda lo que ya se sabe (borrador por
// usuario) y cada respuesta completa solo lo que faltaba.
const borradores = new Map(); // userId -> { tipo, datos, falta, ts }
const BORRADOR_TTL_MS = 10 * 60 * 1000;

function leerBorrador(usuario) {
  if (!usuario) return null;
  const b = borradores.get(usuario.id);
  if (!b) return null;
  if (Date.now() - b.ts > BORRADOR_TTL_MS) { borradores.delete(usuario.id); return null; }
  return b;
}
function guardarBorrador(usuario, tipo, datos, falta) {
  borradores.set(usuario.id, { tipo, datos, falta, ts: Date.now() });
}
function borrarBorrador(usuario) {
  if (usuario) borradores.delete(usuario.id);
}

// Nombre escrito como respuesta suelta: "con Juan Pérez", "a la hermana
// Soto", "Juan Pérez." -> "Juan Pérez" / "hermana Soto".
function nombreDesdeRespuesta(texto) {
  const limpio = String(texto || '')
    .replace(/^\s*(es\s+)?(con|a|para)\s+(el|la)?\s*/i, '')
    .replace(/[.,;!?]+\s*$/, '')
    .trim();
  if (!limpio || limpio.length > 60 || /\d/.test(limpio)) return null;
  // Palabras de control del chat que nunca son un nombre.
  if (/^(s[ií]|no|ok|okay|dale|confirmar|confirmo|cancelar|cancela|listo|ninguno|ninguna|gracias)$/i.test(limpio)) return null;
  if (PARECE_AGENDAR.test(normalizeSearchText(limpio))) return null;
  return limpio;
}

// ----------------------------------------------------------------------
// BUSCAR AL MIEMBRO (usuarios registrados + Directorio del barrio)
// ----------------------------------------------------------------------
// Igual que el selector de miembro del formulario de Entrevistas: si el
// nombre coincide con un USUARIO REGISTRADO se vincula (memberUserId, así
// le aparece en su Mis Actividades y le llegan los avisos); si coincide con
// alguien del DIRECTORIO se usa su nombre completo tal como está ahí (sin
// vincular, porque puede no tener cuenta). Cada palabra que se escribió
// tiene que estar en el nombre, en cualquier orden — así "Jaime Cuenca"
// encuentra "Cuenca Rojas, Jaime Andrés".
function palabrasDe(nombre) {
  return normalizeSearchText(nombre).replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter(Boolean);
}

export function buscarMiembros(nombre, data) {
  const buscadas = palabrasDe(nombre).filter((w) => w.length > 1 && !['de', 'del', 'la', 'las', 'los', 'hermano', 'hermana', 'hno', 'hna'].includes(w));
  if (!buscadas.length) return [];
  const coincide = (candidato) => {
    const palabras = palabrasDe(candidato);
    return buscadas.every((b) => palabras.some((p) => p === b || (b.length >= 3 && p.startsWith(b))));
  };
  const vistos = new Set();
  const resultado = [];
  for (const u of data.users || []) {
    if (!u.name || u.role === 'admin' || !coincide(u.name)) continue;
    vistos.add(normalizeSearchText(u.name));
    resultado.push({ name: u.name, userId: u.id, user: u });
  }
  for (const m of data.directoryMembers || []) {
    if (!m.name || !coincide(m.name)) continue;
    // Si la misma persona ya salió como usuario registrado, no se repite.
    const norm = normalizeSearchText(m.name);
    const yaEsta = vistos.has(norm) || resultado.some((r) => r.userId && palabrasDe(m.name).every((w) => palabrasDe(r.name).includes(w)));
    if (yaEsta) continue;
    vistos.add(norm);
    resultado.push({ name: m.name, userId: null });
  }
  return resultado;
}

function listaOpciones(opciones) {
  return opciones.map((o, i) => `${i + 1}. **${o.name}**${o.userId ? ' 🔗 registrado' : ''}`).join('\n');
}

function purposeDesdeRespuesta(mensajeMin) {
  const directo = PURPOSE_OPTIONS.find((p) => normalizeSearchText(mensajeMin).includes(normalizeSearchText(p)));
  return directo || inferPurpose(mensajeMin);
}

// ----------------------------------------------------------------------
// RESPUESTAS ESTRUCTURADAS
// ----------------------------------------------------------------------
// Cada respuesta es { texto, opciones?, tarjeta?, items? }:
//   - opciones: botones de respuesta rápida [{ label, value }] — al tocar
//     uno, el widget manda `value` como si la persona lo hubiera escrito.
//   - tarjeta: resumen para confirmar antes de guardar.
//   - items: lista de actividades/entrevistas/turnos para mostrar como
//     tarjetas con el color de cada organización.
function resp(texto, extra = {}) {
  return { texto, ...extra };
}

const DIAS_NOMBRE = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES_NOMBRE = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function fechaDesdeISO(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}
function fechaLegible(iso) {
  const d = fechaDesdeISO(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${DIAS_NOMBRE[d.getDay()]} ${d.getDate()} de ${MESES_NOMBRE[d.getMonth()]}`;
}
function sumarDias(d, n) {
  const x = new Date(d); x.setDate(x.getDate() + n); return x;
}

function opcionesFecha(hoyObj) {
  const sab = sumarDias(hoyObj, (6 - hoyObj.getDay() + 7) % 7 || 7);
  const dom = sumarDias(hoyObj, (7 - hoyObj.getDay()) % 7 || 7);
  return [
    { label: 'Hoy', value: 'hoy' },
    { label: 'Mañana', value: 'mañana' },
    { label: `Sábado ${sab.getDate()}`, value: toISO(sab) },
    { label: `Domingo ${dom.getDate()}`, value: toISO(dom) },
  ];
}
const OPCIONES_HORA = ['10:00', '19:00', '19:30', '20:00'].map((h) => ({ label: h, value: `a las ${h}` }));
const OPCIONES_CONFIRMAR = [
  { label: '✅ Confirmar', value: 'confirmar' },
  { label: '❌ Cancelar', value: 'cancelar' },
];

function orgPorId(data, id) {
  return (data.organizations || []).find((o) => Number(o.id) === Number(id)) || null;
}

const ES_AFIRMATIVO = /^\s*(s[ií]|dale|ok|okay|confirm\w*|agend[aá]\w*|guard[aá]\w*|as[ií] est[aá] bien|correcto|perfecto|listo)(?=[\s,.!]|$)/i;

// ----------------------------------------------------------------------
// AGENDAMIENTO REAL — usa las MISMAS reglas de permisos y los MISMOS
// campos obligatorios que exige POST /api/events y POST /api/interviews
// (ver events.js / interviews.js), y escribe con nextId()+withDb() como
// el resto de la app. Antes de guardar SIEMPRE muestra un resumen y pide
// confirmación (nada se guarda por un malentendido de fecha u hora).
// ----------------------------------------------------------------------

// Cuando ya se está en el paso de confirmar, un mensaje que no es "sí" ni
// "cancelar" se toma como corrección ("mejor a las 21:00", "el sábado").
function aplicarCorrecciones(d, mensajeMin, hoyObj, data) {
  let cambio = false;
  const f = parseFecha(mensajeMin, hoyObj); if (f) { d.fecha = f; cambio = true; }
  const h = parseHora(mensajeMin); if (h) { d.hora = h; cambio = true; }
  const o = inferOrganizationId(mensajeMin, data.organizations); if (o) { d.orgId = o; cambio = true; }
  if (d.purpose !== undefined) {
    const p = purposeDesdeRespuesta(mensajeMin); if (p) { d.purpose = p; cambio = true; }
  }
  return cambio;
}

async function intentarAgendarActividad(mensaje, mensajeMin, hoyObj, usuario, data, previo = null, falta = null) {
  if (!usuario) return resp('🔒 Para agendar actividades necesitas haber iniciado sesión.');

  const d = { ...(previo || {}) };
  const preguntar = (f, texto, extra = {}) => { guardarBorrador(usuario, 'actividad', d, f); return resp(texto, extra); };

  if (falta === 'confirmar') {
    if (ES_AFIRMATIVO.test(mensajeMin)) {
      borrarBorrador(usuario);
      return guardarActividad(d, usuario, data);
    }
    if (!aplicarCorrecciones(d, mensajeMin, hoyObj, data)) {
      return preguntar('confirmar', '✏️ No entendí el cambio. Dime, por ejemplo, "a las 20:00", "el sábado" o "para la Primaria" — o toca Confirmar / Cancelar.', { tarjeta: tarjetaActividad(d, data), opciones: OPCIONES_CONFIRMAR });
    }
  }

  if (!d.titulo) {
    let titulo = mensaje
      .replace(/(agendar|agenda|agéndame|agendame|crear|crea|programar|programa|añadir|añade|agregar|agrega)\s+(una?|la|el|mi)?\s*(actividad|reuni[oó]n|evento)?\s*(de|para|del)?/i, '')
      .trim();
    titulo = limpiarTitulo(titulo);
    if (!titulo) titulo = 'Actividad';
    d.titulo = titulo.charAt(0).toUpperCase() + titulo.slice(1);
  }
  d.fecha = d.fecha || parseFecha(mensajeMin, hoyObj);
  d.hora = d.hora || parseHora(mensajeMin);
  d.orgId = d.orgId || inferOrganizationId(mensajeMin, data.organizations);
  // Un líder solo puede agendar actividades de su propia organización:
  // si no dijo cuál, se asume la suya en vez de preguntar.
  if (!d.orgId && usuario.role === 'leader' && usuario.organizationId) d.orgId = Number(usuario.organizationId);
  d.purpose = d.purpose || (previo ? purposeDesdeRespuesta(mensajeMin) : inferPurpose(mensajeMin));

  const titulo = d.titulo;
  if (!d.fecha) return preguntar('fecha', `📅 ¿Qué día es "${titulo}"?`, { opciones: opcionesFecha(hoyObj) });
  if (!d.hora) return preguntar('hora', `🕐 ¿A qué hora es "${titulo}" el ${fechaLegible(d.fecha)}?`, { opciones: OPCIONES_HORA });
  if (!d.orgId) {
    const editables = (data.organizations || []).filter((o) => canEditOrg(usuario, o.id));
    return preguntar('organizacion', `🏷️ ¿Para qué organización es "${titulo}"?`, { opciones: editables.map((o) => ({ label: o.name, value: o.name })) });
  }

  if (!canEditOrg(usuario, d.orgId)) { borrarBorrador(usuario); return resp('🚫 No tienes permiso para agendar actividades de esa organización (solo su líder o un Administrador pueden).'); }

  if (!d.purpose || !PURPOSE_OPTIONS.includes(d.purpose)) {
    return preguntar('proposito', `🎯 ¿Cuál es el propósito de "${titulo}"?`, { opciones: PURPOSE_OPTIONS.map((p) => ({ label: p, value: p })) });
  }

  if (orgRequiresSupervisingAdults(data.organizations, d.orgId)) {
    borrarBorrador(usuario);
    return resp('👥 Esta organización requiere el nombre de al menos **dos adultos supervisores** presentes (Manual General 20.7.1). Agéndala desde el formulario de **Mis Actividades** para poder indicarlos — no la guardé todavía.');
  }

  const conflicts = findStakeConflicts(data, { date: d.fecha, startTime: d.hora, endTime: null });
  if (conflicts.length && !isObispadoLeader(usuario, data)) {
    borrarBorrador(usuario);
    const lista = conflicts.map((c) => `"${c.title}"`).join(', ');
    return resp(`⚠️ Esa fecha/hora choca con ${conflicts.length > 1 ? 'actividades de Estaca' : 'una actividad de Estaca'} (${lista}), que tienen prioridad. Solo el líder de Obispado o un Administrador puede autorizarlo — agéndala desde el formulario normal para poder confirmarlo. No la guardé.`);
  }

  return preguntar('confirmar', '📝 ¿Lo agendo así? Si algo no calza, dime el cambio (ej. "a las 20:00").', { tarjeta: tarjetaActividad(d, data), opciones: OPCIONES_CONFIRMAR });
}

function tarjetaActividad(d, data) {
  const org = orgPorId(data, d.orgId);
  return {
    tipo: 'actividad',
    titulo: d.titulo,
    color: org?.color || null,
    filas: [
      ['📅', fechaLegible(d.fecha)],
      ['🕐', d.hora],
      ['🏷️', org?.name || ''],
      ['🎯', d.purpose || ''],
    ],
  };
}

async function guardarActividad(d, usuario, data) {
  const org = orgPorId(data, d.orgId);
  const now = new Date().toISOString();
  const evento = await withDb((db) => {
    const e = {
      id: nextId(db, 'events'),
      title: d.titulo,
      date: d.fecha,
      startTime: d.hora,
      organizationId: Number(d.orgId),
      purpose: d.purpose,
      createdBy: usuario.id,
      createdAt: now,
      updatedAt: now,
    };
    db.events.push(e);
    return e;
  });
  vaciarCache();
  return resp(`✅ **¡Listo! Actividad agendada:** **${evento.title}**, ${fechaLegible(evento.date)} a las ${evento.startTime} (${org?.name || ''}).\n\n_Ya aparece en el calendario._`, {
    items: [{ tipo: 'actividad', titulo: evento.title, fecha: evento.date, hora: evento.startTime, org: org?.name || '', color: org?.color || null }],
  });
}

async function intentarAgendarEntrevista(mensaje, mensajeMin, hoyObj, usuario, data, previo = null, falta = null) {
  if (!usuario) return resp('🔒 Para agendar entrevistas necesitas haber iniciado sesión.');

  const d = { ...(previo || {}) };
  const preguntar = (f, texto, extra = {}) => { guardarBorrador(usuario, 'entrevista', d, f); return resp(texto, extra); };

  if (falta === 'confirmar') {
    if (ES_AFIRMATIVO.test(mensajeMin)) {
      borrarBorrador(usuario);
      return guardarEntrevista(d, usuario, data);
    }
    if (!aplicarCorrecciones(d, mensajeMin, hoyObj, data)) {
      return preguntar('confirmar', '✏️ No entendí el cambio. Dime, por ejemplo, "a las 20:00" o "el jueves" — o toca Confirmar / Cancelar.', { tarjeta: tarjetaEntrevista(d, data), opciones: OPCIONES_CONFIRMAR });
    }
  }

  // Respuestas a "¿cuál de estas personas?" y "¿lo agendo igual?".
  if (falta === 'elegirMiembro' && Array.isArray(d.opciones)) {
    const num = mensajeMin.match(/^\s*(?:el|la|opci[oó]n|n[uú]mero)?\s*(\d{1,2})\b/);
    const primeraPalabra = normalizeSearchText(mensajeMin).split(/\s+/)[0];
    if (num && d.opciones[Number(num[1]) - 1]) {
      const elegido = d.opciones[Number(num[1]) - 1];
      d.memberName = elegido.name; d.memberUserId = elegido.userId; d.miembroResuelto = true;
    } else if (/^(ninguno|ninguna|ningun)$/.test(primeraPalabra)) {
      d.miembroResuelto = true; // se deja el nombre tal como lo escribió
    } else if (nombreDesdeRespuesta(mensaje)) {
      d.memberName = nombreDesdeRespuesta(mensaje); d.miembroResuelto = false;
    } else {
      return preguntar('elegirMiembro', `🔎 Elige una de estas personas, o "ninguno" para dejarlo como lo escribiste:\n\n${listaOpciones(d.opciones)}`, { opciones: opcionesMiembros(d.opciones) });
    }
    delete d.opciones;
  } else if (falta === 'confirmarNombre') {
    if (ES_AFIRMATIVO.test(mensajeMin)) {
      d.miembroResuelto = true;
    } else if (/^\s*no\b/i.test(mensajeMin) && !nombreDesdeRespuesta(mensaje.replace(/^\s*no[\s,.]*/i, ''))) {
      d.memberName = null; d.miembroResuelto = false;
      return preguntar('nombre', '🙋 ¿Cómo se llama entonces? Escríbeme nombre y apellido.');
    } else {
      d.memberName = nombreDesdeRespuesta(mensaje.replace(/^\s*no[\s,.]*(es\s+)?/i, '')); d.miembroResuelto = false;
    }
  }

  if (!d.memberName) {
    const nombreMatch = mensaje.match(/entrevist\w*\s+(?:a|con)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ.'\- ]+?)(?:\s+(?:el|para|a las?|el d[ií]a|ma[ñn]ana|hoy|pasado|este|esta|pr[oó]xim\w*|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b|[.,]|$)/i);
    if (nombreMatch) d.memberName = nombreMatch[1].trim();
    else if (falta === 'nombre') d.memberName = nombreDesdeRespuesta(mensaje);
  }
  d.fecha = d.fecha || parseFecha(mensajeMin, hoyObj);
  d.hora = d.hora || parseHora(mensajeMin);
  d.orgId = d.orgId || inferOrganizationId(mensajeMin, data.organizations);
  if (!d.orgId && ['leader', 'executive_secretary'].includes(usuario.role) && usuario.organizationId) d.orgId = Number(usuario.organizationId);

  if (!d.memberName) return preguntar('nombre', `🙋 ¿A quién quieres entrevistar?${d.fecha ? ` (ya tengo el ${fechaLegible(d.fecha)}${d.hora ? ' a las ' + d.hora : ''})` : ''}`);
  if (!d.fecha) return preguntar('fecha', `📅 ¿Qué día es la entrevista con **${d.memberName}**?`, { opciones: opcionesFecha(hoyObj) });
  if (!d.hora) return preguntar('hora', `🕐 ¿A qué hora es la entrevista con **${d.memberName}** el ${fechaLegible(d.fecha)}?`, { opciones: OPCIONES_HORA });
  if (!d.orgId) {
    const posibles = (data.organizations || []).filter((o) => o.allowsInterviews && canScheduleOrg(usuario, o.id));
    return preguntar('organizacion', '🏷️ ¿De qué organización es esta entrevista?', { opciones: posibles.map((o) => ({ label: o.name, value: o.name })) });
  }

  // Asociar el nombre con una persona real (usuario registrado o Directorio).
  if (!d.miembroResuelto) {
    const encontrados = buscarMiembros(d.memberName, data);
    if (encontrados.length === 1) {
      d.memberName = encontrados[0].name;
      d.memberUserId = encontrados[0].userId;
      d.miembroResuelto = true;
    } else if (encontrados.length > 1) {
      d.opciones = encontrados.slice(0, 8).map(({ name, userId }) => ({ name, userId }));
      const extra = encontrados.length > 8 ? `\n_(y ${encontrados.length - 8} más — si no está, escribe el nombre más completo)_` : '';
      return preguntar('elegirMiembro', `🔎 Encontré varias personas que coinciden con **${d.memberName}**:\n\n${listaOpciones(d.opciones)}${extra}\n\nElige una, o "ninguno" para dejarlo como lo escribiste.`, {
        opciones: opcionesMiembros(d.opciones),
      });
    } else {
      return preguntar('confirmarNombre', `🔎 No encontré a **${d.memberName}** en el Directorio ni entre los usuarios registrados. ¿La agendo igual con ese nombre? (o escríbeme el nombre correcto)`, {
        opciones: [{ label: 'Sí, con ese nombre', value: 'sí' }, { label: 'Cancelar', value: 'cancelar' }],
      });
    }
  }

  if (!orgAllowsInterviews(data, d.orgId)) { borrarBorrador(usuario); return resp('🚫 Esa organización no agenda entrevistas en la app. No la guardé.'); }
  if (!canScheduleOrg(usuario, d.orgId)) { borrarBorrador(usuario); return resp('🚫 No tienes permiso para agendar entrevistas de esa organización. No la guardé.'); }

  // Misma validación del Manual General que el formulario (solo se puede
  // revisar si la persona tiene cuenta registrada con su perfil completo).
  const orgEntrevista = orgPorId(data, d.orgId);
  const cuenta = d.memberUserId ? (data.users || []).find((u) => u.id === Number(d.memberUserId)) : null;
  if (cuenta && orgEntrevista && interviewEligibility(orgEntrevista.name, cuenta) === false) {
    borrarBorrador(usuario);
    return resp(`🚫 Esta entrevista es de ${orgEntrevista.name} y **${cuenta.name}** no corresponde según su perfil (sexo/edad) — según el Manual General, agéndala con el Obispado. No la guardé.`);
  }

  return preguntar('confirmar', '📝 ¿La agendo así? Si algo no calza, dime el cambio (ej. "a las 20:30").', { tarjeta: tarjetaEntrevista(d, data), opciones: OPCIONES_CONFIRMAR });
}

function opcionesMiembros(lista) {
  return [...lista.map((o, i) => ({ label: `${i + 1}. ${o.name}`, value: String(i + 1) })), { label: 'Ninguno', value: 'ninguno' }];
}

function tarjetaEntrevista(d, data) {
  const org = orgPorId(data, d.orgId);
  return {
    tipo: 'entrevista',
    titulo: `Entrevista con ${d.memberName}`,
    color: org?.color || null,
    filas: [
      ['🙋', `${d.memberName}${d.memberUserId ? ' 🔗' : ''}`],
      ['📅', fechaLegible(d.fecha)],
      ['🕐', d.hora],
      ['🏷️', org?.name || ''],
    ],
  };
}

async function guardarEntrevista(d, usuario, data) {
  const org = orgPorId(data, d.orgId);
  const now = new Date().toISOString();
  const interview = await withDb((db) => {
    const id = nextId(db, 'interviews');
    const iv = {
      id,
      groupId: id,
      memberName: d.memberName,
      memberUserId: d.memberUserId ? Number(d.memberUserId) : null,
      memberPhone: '',
      memberEmail: '',
      description: '',
      location: '',
      sala: '',
      interviewerName: usuario.name || '',
      interviewerEmail: '',
      interviewerPhone: '',
      date: d.fecha,
      startTime: d.hora,
      endTime: null,
      organizationId: Number(d.orgId),
      scheduledBy: usuario.id,
      reminderSent: false,
      whatsappTodayReminderSent: false,
      status: 'scheduled',
      comment: '',
      markedAt: null,
      markedBy: null,
      createdAt: now,
      updatedAt: now,
    };
    db.interviews.push(iv);
    return iv;
  });
  vaciarCache();
  return resp(`✅ **¡Listo! Entrevista agendada** con **${interview.memberName}**${interview.memberUserId ? ' 🔗 (vinculada a su cuenta)' : ''}, ${fechaLegible(interview.date)} a las ${interview.startTime}.\n\n_Ya aparece en el módulo de Entrevistas._`, {
    items: [{ tipo: 'entrevista', titulo: interview.memberName, fecha: interview.date, hora: interview.startTime, org: org?.name || '', color: org?.color || null }],
  });
}

// ----------------------------------------------------------------------
// MODELOS DE IA (gratuitos) — Gemini primero (decisión del administrador),
// Groq y Cerebras de respaldo si Gemini falla o se queda sin cuota.
// Ojo: el plan gratis de Gemini puede usar lo que se le manda para mejorar
// sus modelos (fuera de la UE); Groq y Cerebras no.
// Groq y Cerebras usan la API compatible con OpenAI, así que se llaman con
// fetch directo (sin depender de la versión del SDK).
// ----------------------------------------------------------------------
const GEMINI_MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.6-flash';
function clienteGemini() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey, ...(process.env.GEMINI_BASE_URL ? { httpOptions: { baseUrl: process.env.GEMINI_BASE_URL } } : {}) });
}
function proveedoresIA() {
  const lista = [];
  if (process.env.GROQ_API_KEY) {
    lista.push({
      nombre: 'Groq',
      url: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1/chat/completions',
      key: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    });
  }
  if (process.env.CEREBRAS_API_KEY) {
    lista.push({
      nombre: 'Cerebras',
      url: process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1/chat/completions',
      key: process.env.CEREBRAS_API_KEY,
      model: process.env.CEREBRAS_MODEL || 'llama-3.3-70b',
    });
  }
  return lista;
}

async function llamarOpenAICompatible(prov, body, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(prov.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prov.key}` },
      body: JSON.stringify({ model: prov.model, ...body }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`${prov.nombre} respondió ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// --- Punto 19: la IA entiende la frase libre y devuelve datos ordenados ---
// La IA NO guarda nada: solo traduce "anótame con el hermano Cuenca el
// viernes después de la sacramental a las 8" a { nombre, fecha, hora }.
// Todo lo demás (permisos, Directorio, confirmación, guardado) lo sigue
// haciendo el servidor con las mismas reglas de siempre.
const HERRAMIENTAS_AGENDAR = [
  {
    type: 'function',
    function: {
      name: 'agendar_entrevista',
      description: 'El usuario quiere agendar/anotar una entrevista o cita con una persona.',
      parameters: {
        type: 'object',
        properties: {
          nombre: { type: 'string', description: 'Nombre de la persona a entrevistar, tal como lo dijo.' },
          fecha: { type: 'string', description: 'Fecha en formato AAAA-MM-DD, solo si la dijo.' },
          hora: { type: 'string', description: 'Hora en formato HH:MM de 24 horas, solo si la dijo.' },
          organizacion: { type: 'string', description: 'Organización, solo si la dijo.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agendar_actividad',
      description: 'El usuario quiere agendar/crear una actividad, reunión o evento en el calendario.',
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string', description: 'Nombre corto de la actividad (ej. "Noche de hogar", "Asado de JAS").' },
          fecha: { type: 'string', description: 'Fecha en formato AAAA-MM-DD, solo si la dijo.' },
          hora: { type: 'string', description: 'Hora en formato HH:MM de 24 horas, solo si la dijo.' },
          organizacion: { type: 'string', description: 'Organización, solo si la dijo.' },
          proposito: { type: 'string', enum: PURPOSE_OPTIONS, description: 'Propósito, solo si se deduce claramente.' },
        },
      },
    },
  },
];

const PARECE_AGENDAR = /\b(agend\w*|anot\w*|program\w*|reserv\w*|cita|entrevist\w*|crea\w*|agreg\w*|a[nñ]ad\w*|ponme|pon|coordin\w*|organiz\w*|calendariz\w*)\b/;

async function extraerIntencionConIA(mensaje, hoyObj, data) {
  const provs = proveedoresIA();
  const gemini = clienteGemini();
  if (!provs.length && !gemini) return null;
  const sistema = `Extraes datos para agendar en la app de un barrio de La Iglesia (Chile).
Hoy es ${DIAS_NOMBRE[hoyObj.getDay()]} ${toISO(hoyObj)}. "El viernes" = el próximo viernes a partir de hoy (o hoy si hoy es viernes).
"8 de la noche" = 20:00; "después de la sacramental" no es una hora exacta: omite la hora.
Organizaciones: ${(data.organizations || []).map((o) => o.name).join(', ')}.
Si el usuario quiere AGENDAR algo, llama a la función que corresponda con SOLO los datos que dijo (omite los que no dijo, nunca inventes).
Si solo pregunta o conversa, no llames ninguna función.`;

  if (gemini) {
    try {
      const r = await gemini.models.generateContent({
        model: GEMINI_MODEL(),
        contents: [{ role: 'user', parts: [{ text: mensaje }] }],
        config: {
          systemInstruction: sistema,
          temperature: 0,
          tools: [{
            functionDeclarations: HERRAMIENTAS_AGENDAR.map((h) => ({
              name: h.function.name,
              description: h.function.description,
              parametersJsonSchema: h.function.parameters,
            })),
          }],
        },
      });
      const call = r?.functionCalls?.[0];
      if (!call) return { tipo: null };
      return { tipo: call.name === 'agendar_entrevista' ? 'entrevista' : 'actividad', args: call.args || {} };
    } catch (err) {
      console.warn('⚠️ Gemini no pudo interpretar el pedido (paso a Groq/Cerebras):', err.message);
    }
  }

  for (const prov of provs) {
    try {
      const r = await llamarOpenAICompatible(prov, {
        messages: [{ role: 'system', content: sistema }, { role: 'user', content: mensaje }],
        tools: HERRAMIENTAS_AGENDAR,
        tool_choice: 'auto',
        temperature: 0,
        max_tokens: 300,
      });
      const call = r?.choices?.[0]?.message?.tool_calls?.[0];
      if (!call) return { tipo: null };
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
      return { tipo: call.function.name === 'agendar_entrevista' ? 'entrevista' : 'actividad', args };
    } catch (err) {
      console.warn(`⚠️ ${prov.nombre} no pudo interpretar el pedido:`, err.message);
    }
  }
  return null;
}

// Valida lo que devolvió la IA antes de usarlo (fechas y horas bien
// formadas, organización que exista, propósito permitido).
function borradorDesdeIA(intencion, data, hoyObj) {
  const a = intencion.args || {};
  const fechaOk = typeof a.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.fecha) && a.fecha >= toISO(hoyObj) ? a.fecha : null;
  const horaOk = typeof a.hora === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(a.hora) ? a.hora : null;
  const orgId = a.organizacion ? inferOrganizationId(String(a.organizacion).toLowerCase(), data.organizations) : null;
  if (intencion.tipo === 'entrevista') {
    const nombre = a.nombre ? nombreDesdeRespuesta(a.nombre) : null;
    return { memberName: nombre, fecha: fechaOk, hora: horaOk, orgId };
  }
  const titulo = typeof a.titulo === 'string' && a.titulo.trim() ? a.titulo.trim().slice(0, 80) : null;
  return {
    titulo: titulo ? titulo.charAt(0).toUpperCase() + titulo.slice(1) : null,
    fecha: fechaOk,
    hora: horaOk,
    orgId,
    purpose: PURPOSE_OPTIONS.includes(a.proposito) ? a.proposito : undefined,
  };
}

async function redactarConIA(systemInstruction, historial, mensaje) {
  const gemini = clienteGemini();
  if (gemini) {
    try {
      const historyTurns = (historial || []).flatMap((h) => ([
        { role: 'user', parts: [{ text: h.user || '' }] },
        { role: 'model', parts: [{ text: h.bot || '' }] },
      ]));
      const response = await gemini.models.generateContent({
        model: GEMINI_MODEL(),
        contents: [...historyTurns, { role: 'user', parts: [{ text: mensaje }] }],
        config: { systemInstruction },
      });
      if (response && response.text) return response.text;
    } catch (errGemini) {
      console.warn('⚠️ Gemini falló (saturación/cuota). Paso a Groq/Cerebras...', errGemini.message);
    }
  }
  for (const prov of proveedoresIA()) {
    try {
      const r = await llamarOpenAICompatible(prov, {
        messages: [
          { role: 'system', content: systemInstruction },
          ...(historial || []).flatMap((h) => ([
            { role: 'user', content: h.user || '' },
            { role: 'assistant', content: h.bot || '' },
          ])),
          { role: 'user', content: mensaje },
        ],
        temperature: 0.4,
        max_tokens: 1200, // alcanza para un análisis comparativo completo
      });
      const texto = r?.choices?.[0]?.message?.content;
      if (texto) return texto;
    } catch (err) {
      console.warn(`⚠️ ${prov.nombre} falló redactando la respuesta:`, err.message);
    }
  }
  return null;
}

// Frases con las que la IA "afirma" haber creado algo. En el módulo de
// consulta la IA NUNCA crea registros, así que si responde algo así es
// una alucinación y se reemplaza por un aviso honesto.
const AFIRMA_AGENDADO = /(\b(he|hemos|ya|lo|la|te\s+lo|te\s+la)\s+(agendado|registrado|creado|programado|guardado)\b|\b(qued[óo]|queda|fue|ha\s+sido|est[áa])\s+(correctamente\s+|exitosamente\s+)?(agendad|registrad|cread|programad|guardad)[oa]s?\b|agendad[oa]\s+(con\s+[ée]xito|exitosamente|correctamente)|¡?listo!?[^\n]{0,40}agend)/i;

function filtrarAlucinacion(texto) {
  if (!AFIRMA_AGENDADO.test(texto)) return texto;
  return '⚠️ Ojo: **no he guardado nada** todavía. Para agendar, pídemelo así: ' +
    '"agenda una entrevista con Juan Pérez el viernes a las 20:00" o ' +
    '"agenda una actividad de noche de hogar el sábado a las 19:00 para el Cuórum de Élderes".';
}

// ----------------------------------------------------------------------
// Punto 17: rango de fechas de la consulta — en vez de mandarle a la IA
// TODAS las actividades futuras, solo las del período que se preguntó
// (por defecto, los próximos 30 días) y como máximo MAX_ITEMS.
// ----------------------------------------------------------------------
const MAX_ITEMS = 15;

function rangoConsulta(norm, mensajeMin, hoyObj) {
  const hoy = toISO(hoyObj);
  if (/\bfin de semana\b/.test(norm)) {
    const sab = sumarDias(hoyObj, hoyObj.getDay() === 0 ? -1 : (6 - hoyObj.getDay() + 7) % 7);
    return { desde: toISO(sab) < hoy ? hoy : toISO(sab), hasta: toISO(sumarDias(sab, 1)), etiqueta: 'este fin de semana' };
  }
  if (/\b(proxima|siguiente) semana\b/.test(norm)) {
    const lunes = sumarDias(hoyObj, ((8 - hoyObj.getDay()) % 7) || 7);
    return { desde: toISO(lunes), hasta: toISO(sumarDias(lunes, 6)), etiqueta: 'la próxima semana' };
  }
  if (/\besta semana\b/.test(norm)) {
    return { desde: hoy, hasta: toISO(sumarDias(hoyObj, (7 - hoyObj.getDay()) % 7)), etiqueta: 'esta semana' };
  }
  if (/\b(proximo|siguiente) mes\b/.test(norm)) {
    const ini = new Date(hoyObj.getFullYear(), hoyObj.getMonth() + 1, 1, 12);
    const fin = new Date(hoyObj.getFullYear(), hoyObj.getMonth() + 2, 0, 12);
    return { desde: toISO(ini), hasta: toISO(fin), etiqueta: `en ${MESES_NOMBRE[ini.getMonth()]}` };
  }
  if (/\b(este mes|del mes|el mes)\b/.test(norm)) {
    const fin = new Date(hoyObj.getFullYear(), hoyObj.getMonth() + 1, 0, 12);
    return { desde: hoy, hasta: toISO(fin), etiqueta: 'lo que queda del mes' };
  }
  const dia = parseFecha(mensajeMin, hoyObj);
  if (dia) return { desde: dia, hasta: dia, etiqueta: fechaLegible(dia) };
  return { desde: hoy, hasta: toISO(sumarDias(hoyObj, 30)), etiqueta: 'los próximos 30 días' };
}

// ----------------------------------------------------------------------
// CRECIMIENTO DEL BARRIO (indicadores trimestrales) — "¿vamos mejorando en
// la asistencia?". Mismos permisos que GET /api/ward-growth/quarters:
// admin, cualquier líder y secretario de barrio.
// ----------------------------------------------------------------------
const VER_CRECIMIENTO = ['admin', 'leader', 'ward_clerk'];
const INDICADORES_ASISTENCIA = [7, 14, 15, 16, 17, 18, 19, 22];
const INDICADORES_POR_TEMA = [
  [/\bsacramental\b/, [7]],
  [/\b(elderes|cuorum|melquisedec)\b/, [14, 15, 12]],
  [/\b(socorro|mujeres adultas)\b/, [16, 13]],
  [/\b(jas|jovenes adultos)\b/, [17]],
  [/\bhombres jovenes\b/, [18]],
  [/\bmujeres jovenes\b/, [19]],
  [/\b(primaria|ninos)\b/, [21, 22]],
  [/\bconversos?\b/, [3, 23, 24, 25, 26]],
  [/\b(templo|recomendacion(es)?)\b/, [9, 20, 1, 2]],
  [/\b(sellad\w*|sellamientos?)\b/, [1, 5]],
  [/\b(investid\w*|investiduras?)\b/, [2]],
  [/\b(bautism\w*)\b/, [3, 8, 21]],
  [/\b(reactivad\w*|menos activos)\b/, [6]],
  [/\b(misional|misioner\w*)\b/, [4]],
  [/\b(ministracion|ministrantes?)\b/, [12, 13, 26]],
];
const etiquetaTrimestre = (q) => `T${q.quarter} ${q.year}`;

function contextoCrecimiento(norm, db) {
  const qs = sortedQuarters(db.quarterlyStats || []);
  if (!qs.length) return { contexto: '\n--- CRECIMIENTO DEL BARRIO ---\nTodavía no hay trimestres cargados en "Crecimiento del Barrio".', fallback: '📊 Todavía no hay trimestres cargados en **Crecimiento del Barrio**, así que no puedo comparar.' };
  const ultimo = qs[qs.length - 1];
  const anterior = qs.length > 1 ? qs[qs.length - 2] : null;
  const primero = qs.length > 2 ? qs[0] : null;

  let numeros = [];
  for (const [re, nums] of INDICADORES_POR_TEMA) if (re.test(norm)) numeros.push(...nums);
  if (!numeros.length && /\basist\w*/.test(norm)) numeros = INDICADORES_ASISTENCIA;
  if (!numeros.length) numeros = INDICATOR_DEFS.filter((d) => d.hasPotential).map((d) => d.number);
  numeros = [...new Set(numeros)];

  const filas = [];
  for (const n of numeros) {
    const def = INDICATOR_DEFS.find((d) => d.number === n);
    const e = ultimo.indicators?.[String(n)];
    if (!def || !e) continue;
    const pUlt = pctForIndicator(ultimo, n);
    const pAnt = anterior ? pctForIndicator(anterior, n) : null;
    const pPri = primero ? pctForIndicator(primero, n) : null;
    const eAnt = anterior?.indicators?.[String(n)];
    filas.push({
      n, label: def.label, real: e.real, pot: e.pot, pUlt, pAnt, pPri,
      realAnt: eAnt ? eAnt.real : null,
      diff: pUlt !== null && pAnt !== null ? pUlt - pAnt : null,
    });
  }
  const fmt = (f) => {
    const actual = f.pUlt !== null ? `${f.real}/${f.pot} (${f.pUlt}%)` : `${f.real}`;
    const vsAnt = f.diff !== null ? ` · vs ${etiquetaTrimestre(anterior)}: ${f.pAnt}% (${f.diff >= 0 ? '+' : ''}${f.diff} pp)`
      : (f.realAnt !== null && f.realAnt !== undefined ? ` · vs ${etiquetaTrimestre(anterior)}: ${f.realAnt}` : '');
    const vsPri = f.pPri !== null && f.pUlt !== null ? ` · desde ${etiquetaTrimestre(primero)}: ${f.pPri}% (${f.pUlt - f.pPri >= 0 ? '+' : ''}${f.pUlt - f.pPri} pp)` : '';
    return `${f.label}: ${actual}${vsAnt}${vsPri}`;
  };
  const contexto = `\n--- CRECIMIENTO DEL BARRIO (último trimestre cargado: ${etiquetaTrimestre(ultimo)}; ${qs.length} trimestres en total; "real/potencial (%)" y cambio en puntos porcentuales) ---\n`
    + filas.map(fmt).join('\n');

  const conDiff = filas.filter((f) => f.diff !== null);
  const suben = conDiff.filter((f) => f.diff > 0).length;
  const bajan = conDiff.filter((f) => f.diff < 0).length;
  const veredicto = !conDiff.length ? ''
    : suben > bajan ? `📈 En general **vamos mejorando**: ${suben} de ${conDiff.length} indicadores subieron respecto de ${etiquetaTrimestre(anterior)}.`
      : bajan > suben ? `📉 En general **vamos bajando**: ${bajan} de ${conDiff.length} indicadores bajaron respecto de ${etiquetaTrimestre(anterior)}.`
        : `↔️ Resultado **mixto**: ${suben} indicadores subieron y ${bajan} bajaron respecto de ${etiquetaTrimestre(anterior)}.`;
  const fallback = `${veredicto ? veredicto + '\n\n' : ''}**${etiquetaTrimestre(ultimo)}:**\n`
    + filas.slice(0, 10).map((f) => `• ${f.label}: **${f.pUlt !== null ? f.pUlt + '%' : f.real}**${f.diff !== null ? ` (${f.diff > 0 ? '▲ +' : f.diff < 0 ? '▼ ' : '= '}${f.diff} pp)` : ''}`).join('\n');
  return { contexto, fallback };
}

// ----------------------------------------------------------------------
// ENFOQUE MINISTRACIÓN (cuadrantes) — "¿cómo vamos en el enfoque?".
// Mismos permisos que GET /api/pastoral-focus: Administrador y Obispado
// (todos), Cuórum de Élderes (solo hombres) y Sociedad de Socorro (solo
// mujeres). Los nombres solo se mandan si se piden explícitamente.
// ----------------------------------------------------------------------
const RANGO_CUADRANTE = { Rescatar: 0, Actividad: 1, Enfoque: 1, Retener: 2 };
const RANGO_ASISTENCIA = { Bajo: 0, Medio: 1, Alto: 2 };
const DIAS_TENDENCIA = 90;

// Resumen de UN grupo (hombres del Cuórum o mujeres de la Sociedad de
// Socorro): cuadrantes, asistencia, qué les falta y tendencia. Lo usa el
// análisis comparativo — "¿cuáles son las grandes diferencias entre el
// Cuórum y la Sociedad de Socorro? ¿en qué puede mejorar cada uno?".
function resumenGrupo(nombreGrupo, miembros, db, desde) {
  const porId = new Map(miembros.map((m) => [m.id, m]));
  const g = {
    grupo: nombreGrupo, adultos: miembros.length, evaluados: 0,
    cuadrantes: Object.fromEntries(CUADRANTES.map((c) => [c, 0])),
    asistencia: { Alto: 0, Medio: 0, Bajo: 0 },
    sinLlamamiento: 0, sinRecomendacion: 0, faltaConvenio: 0,
    convenios: { investidura: 0, sellamiento: 0, ordenacion: 0 },
    // Personas en "Enfoque" (asisten) a las que les falta UNA sola cosa
    // para pasar a "Retener": el avance más rápido posible.
    enfoqueLesFaltaSolo: { llamamiento: 0, recomendacion: 0, convenio: 0 },
    mejoran: 0, empeoran: 0, asistSube: 0, asistBaja: 0,
    nombres: Object.fromEntries(CUADRANTES.map((c) => [c, []])),
    enfoqueCasiListos: [],
  };
  for (const f of db.pastoralFocus || []) {
    const m = porId.get(f.memberId);
    if (!m || !f.asistencia) continue;
    g.evaluados += 1;
    const actual = computeCuadrante(f);
    g.cuadrantes[actual] += 1;
    g.asistencia[f.asistencia] = (g.asistencia[f.asistencia] || 0) + 1;
    g.nombres[actual].push(m.name);
    if (!f.tieneLlamamiento) g.sinLlamamiento += 1;
    if (!f.recomendacionVigente) g.sinRecomendacion += 1;
    if (f.faltaConvenio) g.faltaConvenio += 1;
    for (const k of Object.keys(g.convenios)) if (f.convenios?.[k] === 'no') g.convenios[k] += 1;
    if (actual === 'Enfoque') {
      const faltas = [!f.tieneLlamamiento && 'llamamiento', !f.recomendacionVigente && 'recomendacion', f.faltaConvenio && 'convenio'].filter(Boolean);
      if (faltas.length === 1) { g.enfoqueLesFaltaSolo[faltas[0]] += 1; g.enfoqueCasiListos.push(`${m.name} (${faltas[0]})`); }
    }
    const cambios = (f.history || []).filter((h) => h.changedAt >= desde).sort((a, b) => a.changedAt.localeCompare(b.changedAt));
    if (cambios.length) {
      const antes = cambios[0];
      const dc = RANGO_CUADRANTE[actual] - RANGO_CUADRANTE[antes.cuadrante];
      if (dc > 0) g.mejoran += 1; else if (dc < 0) g.empeoran += 1;
      const da = (RANGO_ASISTENCIA[f.asistencia] ?? 0) - (RANGO_ASISTENCIA[antes.asistencia] ?? 0);
      if (da > 0) g.asistSube += 1; else if (da < 0) g.asistBaja += 1;
    }
  }
  return g;
}

const pctDe = (n, total) => (total ? Math.round((n / total) * 100) : 0);

function lineaGrupo(g) {
  const e = g.evaluados;
  return `${g.grupo}: ${e} evaluados de ${g.adultos} adultos en el Directorio (${pctDe(e, g.adultos)}% de cobertura).\n`
    + `  Cuadrantes: ${CUADRANTES.map((c) => `${c} ${g.cuadrantes[c]} (${pctDe(g.cuadrantes[c], e)}%)`).join(', ')}.\n`
    + `  Asistencia: Alto ${pctDe(g.asistencia.Alto, e)}%, Medio ${pctDe(g.asistencia.Medio, e)}%, Bajo ${pctDe(g.asistencia.Bajo, e)}%.\n`
    + `  Les falta: llamamiento ${g.sinLlamamiento} (${pctDe(g.sinLlamamiento, e)}%), recomendación del templo ${g.sinRecomendacion} (${pctDe(g.sinRecomendacion, e)}%), algún convenio ${g.faltaConvenio} (${pctDe(g.faltaConvenio, e)}%) — investidura ${g.convenios.investidura}, sellamiento ${g.convenios.sellamiento}${g.grupo.startsWith('Cuórum') ? `, ordenación ${g.convenios.ordenacion}` : ''}.\n`
    + `  En "Enfoque" a un solo paso de "Retener": ${g.enfoqueLesFaltaSolo.llamamiento} solo necesitan llamamiento, ${g.enfoqueLesFaltaSolo.recomendacion} solo recomendación, ${g.enfoqueLesFaltaSolo.convenio} solo un convenio.\n`
    + `  Últimos ${DIAS_TENDENCIA} días: ${g.mejoran} mejoraron de cuadrante, ${g.empeoran} empeoraron; asistencia subió en ${g.asistSube}, bajó en ${g.asistBaja}.`;
}

// Sugerencias concretas calculadas con los mismos datos (se usan tal cual
// si no hay IA, y la IA las recibe como base para su análisis).
function sugerenciasGrupo(g) {
  const s = [];
  const e = g.evaluados || 1;
  const palancas = Object.entries(g.enfoqueLesFaltaSolo).sort((a, b) => b[1] - a[1]);
  const [clave, n] = palancas[0];
  if (n > 0) {
    const que = { llamamiento: 'extenderles un llamamiento', recomendacion: 'acompañarlos a renovar su recomendación del templo', convenio: 'prepararlos para el convenio que les falta' }[clave];
    s.push(`${n} persona${n === 1 ? '' : 's'} en Enfoque pasaría${n === 1 ? '' : 'n'} a Retener con un solo paso: ${que}.`);
  }
  if (pctDe(g.cuadrantes.Rescatar, e) >= 30) s.push(`${pctDe(g.cuadrantes.Rescatar, e)}% está en Rescatar: priorizar visitas de ministración y una invitación personal a la reunión sacramental.`);
  if (pctDe(g.sinRecomendacion, e) >= 50) s.push(`${pctDe(g.sinRecomendacion, e)}% no tiene recomendación vigente: una clase o actividad de preparación para el templo ayudaría a varios a la vez.`);
  if (pctDe(g.sinLlamamiento, e) >= 30) s.push(`${pctDe(g.sinLlamamiento, e)}% no tiene llamamiento: revisar con el Obispado dónde pueden servir.`);
  if (g.adultos && pctDe(g.evaluados, g.adultos) < 70) s.push(`Solo ${pctDe(g.evaluados, g.adultos)}% de los adultos está evaluado: completar la evaluación del resto para tener el cuadro real.`);
  if (g.empeoran > g.mejoran) s.push(`En los últimos ${DIAS_TENDENCIA} días bajaron más personas de cuadrante (${g.empeoran}) de las que subieron (${g.mejoran}).`);
  return s.slice(0, 3);
}

function contextoMinistracion(norm, usuario, db) {
  const verH = isMinisteringFocusLeaderHombres(usuario, db);
  const verM = isMinisteringFocusLeaderMujeres(usuario, db);
  if (!verH && !verM) {
    return {
      contexto: '\n--- AVISO DE PERMISOS ---\nEl usuario preguntó por Enfoque Ministración, pero ese módulo está habilitado solo para el Administrador, el Obispado y los líderes de Cuórum de Élderes y Sociedad de Socorro. Explícaselo brevemente, sin inventar datos.',
      fallback: '🤝 **Enfoque Ministración** está disponible solo para el Administrador, el Obispado y los líderes de Cuórum de Élderes y Sociedad de Socorro.',
    };
  }
  const desde = new Date(Date.now() - DIAS_TENDENCIA * 86400000).toISOString();
  const grupos = [];
  if (verH) grupos.push(resumenGrupo('Cuórum de Élderes (hombres adultos)', (db.directoryMembers || []).filter(isAdultMale), db, desde));
  if (verM) grupos.push(resumenGrupo('Sociedad de Socorro (mujeres adultas)', (db.directoryMembers || []).filter(isAdultFemale), db, desde));
  const pideNombres = /\b(quien(es)?|nombres?|lista|cuales personas|personas)\b/.test(norm);

  let contexto = `\n--- ENFOQUE MINISTRACIÓN ---\n`
    + 'Cuadrantes, de mejor a peor: Retener (asiste y cumple todo: llamamiento, recomendación vigente y convenios al día) > Enfoque (asiste pero le falta algo) / Actividad (cumple todo pero asiste poco) > Rescatar (asiste poco y le falta algo).\n'
    + grupos.map(lineaGrupo).join('\n');

  // Indicadores trimestrales relacionados (entrevistas de ministración y asistencia).
  const qs = sortedQuarters(db.quarterlyStats || []);
  if (qs.length) {
    const ult = qs[qs.length - 1]; const ant = qs.length > 1 ? qs[qs.length - 2] : null;
    const nums = [...(verH ? [12, 14] : []), ...(verM ? [13, 16] : [])];
    const lineas = nums.map((n) => {
      const p = pctForIndicator(ult, n); const pa = ant ? pctForIndicator(ant, n) : null;
      const def = INDICATOR_DEFS.find((d) => d.number === n);
      return p === null ? null : `${def.label}: ${p}% en ${etiquetaTrimestre(ult)}${pa !== null ? ` (${etiquetaTrimestre(ant)}: ${pa}%)` : ''}`;
    }).filter(Boolean);
    if (lineas.length) contexto += `\nIndicadores trimestrales:\n${lineas.join('\n')}`;
  }
  contexto += '\nSugerencias calculadas con estos datos:\n' + grupos.map((g) => `${g.grupo}: ${sugerenciasGrupo(g).join(' ') || 'sin alertas claras'}`).join('\n');
  if (pideNombres) {
    contexto += '\n' + grupos.map((g) => CUADRANTES.map((c) => `${g.grupo} — ${c}: ${g.nombres[c].slice(0, 15).join('; ') || '—'}${g.nombres[c].length > 15 ? ` (y ${g.nombres[c].length - 15} más)` : ''}`).join('\n')).join('\n');
    const casi = grupos.flatMap((g) => g.enfoqueCasiListos.slice(0, 10).map((x) => `${x}`));
    if (casi.length) contexto += `\nA un paso de Retener: ${casi.join('; ')}`;
  }

  // Respuesta sin IA: resumen por grupo + diferencias + sugerencias.
  const bloque = (g) => {
    const e = g.evaluados;
    return `**${g.grupo}** — ${e} evaluados\n`
      + `• Retener **${pctDe(g.cuadrantes.Retener, e)}%** · Enfoque ${pctDe(g.cuadrantes.Enfoque, e)}% · Actividad ${pctDe(g.cuadrantes.Actividad, e)}% · Rescatar **${pctDe(g.cuadrantes.Rescatar, e)}%**\n`
      + `• Asistencia alta: ${pctDe(g.asistencia.Alto, e)}% · sin recomendación: ${pctDe(g.sinRecomendacion, e)}% · sin llamamiento: ${pctDe(g.sinLlamamiento, e)}%\n`
      + sugerenciasGrupo(g).map((x) => `💡 ${x}`).join('\n');
  };
  let fallback = '🤝 **Enfoque Ministración**\n\n' + grupos.map(bloque).join('\n\n');
  if (grupos.length === 2) {
    const [a, b] = grupos;
    const difs = [
      ['Retener', pctDe(a.cuadrantes.Retener, a.evaluados), pctDe(b.cuadrantes.Retener, b.evaluados)],
      ['Rescatar', pctDe(a.cuadrantes.Rescatar, a.evaluados), pctDe(b.cuadrantes.Rescatar, b.evaluados)],
      ['asistencia alta', pctDe(a.asistencia.Alto, a.evaluados), pctDe(b.asistencia.Alto, b.evaluados)],
      ['sin recomendación', pctDe(a.sinRecomendacion, a.evaluados), pctDe(b.sinRecomendacion, b.evaluados)],
      ['sin llamamiento', pctDe(a.sinLlamamiento, a.evaluados), pctDe(b.sinLlamamiento, b.evaluados)],
    ].map(([k, x, y]) => ({ k, x, y, d: Math.abs(x - y) })).sort((p, q) => q.d - p.d).slice(0, 3);
    if (a.evaluados && b.evaluados) {
      fallback += '\n\n**Grandes diferencias:**\n' + difs.map((d) => `• ${d.k}: Cuórum ${d.x}% vs Sociedad de Socorro ${d.y}%`).join('\n');
    } else {
      const sin = !a.evaluados ? a : b;
      fallback += `\n\n⚠️ **${sin.grupo}** no tiene evaluaciones cargadas todavía, así que no se puede comparar.`;
    }
  }
  return { contexto, fallback };
}

export async function procesarPreguntaChat(mensaje, historial = [], usuario = null) {
  try {
    const db = load();
    const hoyObj = hoyEnChile();
    const mensajeMinusculas = mensaje.toLowerCase().trim();
    const norm = normalizeSearchText(mensaje);

    // ------------------------------------------------------------------------
    // MÓDULO 1: AGENDAMIENTO REAL DE ACTIVIDADES/REUNIONES Y ENTREVISTAS
    // ------------------------------------------------------------------------

    // 1a. Continuación de un agendamiento a medias (respuesta a "¿a qué
    // hora?", "¿a quién?", "¿lo agendo así?", etc.).
    const borrador = leerBorrador(usuario);
    const matchAgendar = mensajeMinusculas.match(/(agendar|agenda|agéndame|agendame|crear|crea|programar|programa|añadir|añade|agregar|agrega)\s+(?:una?|la|el|mi)?\s*(actividad|reuni[oó]n|evento|entrevista|asado|convivencia|paseo|taller|capacitaci[oó]n|devocional|campamento|cena|once|noche de hogar|charla|clase)/);
    // Un pedido nuevo ("organiza un asado…") reemplaza al borrador en curso.
    const pedidoNuevo = /^(?:(?:quiero|necesito|puedes|podrias|me|por favor)\s+)*(agend|anot|organiz|program|crea|reserv|agreg|anad)\w*/.test(norm);
    if (borrador && !matchAgendar && !pedidoNuevo) {
      if (/^\s*(cancela|cancelar|olv[ií]dalo|d[ée]jalo|no\s*,?\s*gracias|mejor no)\b/i.test(mensajeMinusculas)) {
        borrarBorrador(usuario);
        return resp('👌 Listo, cancelé ese agendamiento. No se guardó nada.');
      }
      const esPreguntaNueva = /^\s*(¿|qu[ée]\s|cu[aá]l|cu[aá]nt|cu[aá]ndo|d[oó]nde|qui[ée]n(es)?\s+(tiene|hay|son)|mu[ée]strame|hay\s)/i.test(mensajeMinusculas);
      if (!esPreguntaNueva) {
        if (borrador.tipo === 'entrevista') {
          return await intentarAgendarEntrevista(mensaje, mensajeMinusculas, hoyObj, usuario, db, borrador.datos, borrador.falta);
        }
        return await intentarAgendarActividad(mensaje, mensajeMinusculas, hoyObj, usuario, db, borrador.datos, borrador.falta);
      }
      borrarBorrador(usuario);
    }

    // 1b. Pedido nuevo: primero la IA (entiende frases libres), y si no hay
    // IA configurada o no respondió, las reglas de siempre.
    if (usuario && (matchAgendar || PARECE_AGENDAR.test(norm))) {
      const intencion = await extraerIntencionConIA(mensaje, hoyObj, db);
      if (intencion && intencion.tipo) {
        borrarBorrador(usuario);
        const previo = borradorDesdeIA(intencion, db, hoyObj);
        if (intencion.tipo === 'entrevista') {
          return await intentarAgendarEntrevista(mensaje, mensajeMinusculas, hoyObj, usuario, db, previo);
        }
        if (!previo.titulo) delete previo.titulo;
        return await intentarAgendarActividad(mensaje, mensajeMinusculas, hoyObj, usuario, db, previo);
      }
    }
    if (matchAgendar) {
      borrarBorrador(usuario);
      if (matchAgendar[2] === 'entrevista') {
        return await intentarAgendarEntrevista(mensaje, mensajeMinusculas, hoyObj, usuario, db);
      }
      return await intentarAgendarActividad(mensaje, mensajeMinusculas, hoyObj, usuario, db);
    }

    // ------------------------------------------------------------------------
    // MÓDULO 2: VERIFICAR CACHÉ DE LECTURA (<10 ms) — solo consultas.
    // ------------------------------------------------------------------------
    const clave = claveCache(usuario, mensajeMinusculas);
    const cacheada = leerCache(clave);
    if (cacheada) return cacheada;

    // ------------------------------------------------------------------------
    // MÓDULO 3: CONSULTAS. Punto 18: la detección de tema se hace sobre el
    // texto sin tildes y con palabras completas ("mes" ya no coincide con
    // "mesa", "jóvenes" ya no dispara las estadísticas del templo).
    // ------------------------------------------------------------------------
    const orgMencionada = inferOrganizationId(mensajeMinusculas, db.organizations);
    const temaEntrevistas = /\bentrevistas?\b/.test(norm);
    const temaAseo = /\b(aseo|limpieza|limpiar)\b/.test(norm);
    const temaTemplo = /\b(recomendacion(es)?|templo|porcentaje|estadisticas?|cumpleanos|miembros)\b/.test(norm);
    const temaMinistracion = /\b(ministracion|ministrar|ministrantes?|enfoques?|cuadrantes?|rescatar|retener)\b/.test(norm);
    const temaCrecimiento = !temaMinistracion && /\b(asist\w*|sacramental|crecimiento|indicador(es)?|trimestres?|mejorando|empeorando|bajando|subiendo|tendencia|vamos|reactivad\w*|bautism\w*|sellad\w*|investid\w*|conversos?|misional)\b/.test(norm)
      && !/\b(actividad(es)?|calendario|eventos?|entrevistas?)\b/.test(norm);
    const pideActividades = /\b(actividad(es)?|calendario|eventos?|reunion(es)?)\b/.test(norm);
    const temaActividades = pideActividades || (!temaEntrevistas && !temaAseo && !temaTemplo && !temaMinistracion && !temaCrecimiento
      && (!!orgMencionada || /\b(fin de semana|semana|mes|proxim[oa]s?|hoy|manana|que hay|agenda)\b/.test(norm)));
    const rango = rangoConsulta(norm, mensajeMinusculas, hoyObj);

    let contextoDinamico = '';
    let respuestaLocalFallback = '';
    const items = [];

    if (temaActividades) {
      let eventos = (db.events || []).filter((e) => e.date >= rango.desde && e.date <= rango.hasta);
      if (orgMencionada) eventos = eventos.filter((e) => Number(e.organizationId) === Number(orgMencionada));
      eventos.sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')));
      const total = eventos.length;
      const lista = eventos.slice(0, MAX_ITEMS).map((e) => {
        const org = orgPorId(db, e.organizationId);
        return { tipo: 'actividad', titulo: e.title, fecha: e.date, hora: e.startTime || '', org: org ? org.name : 'General', color: org?.color || null };
      });
      items.push(...lista);
      contextoDinamico += `\n--- ACTIVIDADES (${rango.etiqueta}${orgMencionada ? ', ' + (orgPorId(db, orgMencionada)?.name || '') : ''}: ${total} en total${total > MAX_ITEMS ? `, se muestran las primeras ${MAX_ITEMS}` : ''}) ---\n`
        + lista.map((a) => `${a.fecha} ${a.hora} · ${a.titulo} · ${a.org}`).join('\n');
      respuestaLocalFallback = total
        ? `📅 Encontré **${total}** actividad${total === 1 ? '' : 'es'} para ${rango.etiqueta}${total > MAX_ITEMS ? ` (te muestro las primeras ${MAX_ITEMS})` : ''}:`
        : `📅 No hay actividades agendadas para ${rango.etiqueta}.`;
    }

    if (temaEntrevistas) {
      // Mismo criterio de privacidad que GET /api/interviews (ver
      // orgSeesAllInterviews en interviews.js).
      let visibles = (db.interviews || [])
        .filter((iv) => iv.date >= rango.desde && iv.date <= rango.hasta && (iv.status || 'scheduled') === 'scheduled');
      if (!usuario) {
        visibles = [];
      } else if (['member', 'ward_clerk', 'financial_clerk'].includes(usuario.role)) {
        visibles = visibles.filter((iv) => Number(iv.memberUserId) === Number(usuario.id));
      } else if (!orgSeesAllInterviews(usuario, db)) {
        visibles = visibles.filter((iv) => Number(iv.organizationId) === Number(usuario.organizationId) || Number(iv.memberUserId) === Number(usuario.id));
      }
      if (orgMencionada) visibles = visibles.filter((iv) => Number(iv.organizationId) === Number(orgMencionada));
      visibles.sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')));
      const total = visibles.length;
      const lista = visibles.slice(0, MAX_ITEMS).map((iv) => {
        const org = orgPorId(db, iv.organizationId);
        return { tipo: 'entrevista', titulo: iv.memberName, fecha: iv.date, hora: iv.startTime || '', org: org ? org.name : '', color: org?.color || null };
      });
      items.push(...lista);
      contextoDinamico += `\n--- ENTREVISTAS PENDIENTES (${rango.etiqueta}, ya acotadas a lo que este usuario puede ver: ${total}) ---\n`
        + lista.map((e) => `${e.fecha} ${e.hora} · ${e.titulo} · ${e.org}`).join('\n');
      respuestaLocalFallback = total
        ? `🙋 Tienes **${total}** entrevista${total === 1 ? '' : 's'} pendiente${total === 1 ? '' : 's'} para ${rango.etiqueta}:`
        : `🙋 No hay entrevistas pendientes para ${rango.etiqueta}.`;
    }

    if (temaAseo) {
      // Exclusivo de Obispado/Administrador (ver cleaning.js).
      if (isObispadoLeader(usuario, db)) {
        const turnos = (db.cleaningShifts || [])
          .filter((t) => t.date >= toISO(hoyObj))
          .sort((a, b) => a.date.localeCompare(b.date))
          .slice(0, 8)
          .map((t) => {
            const fam = (db.families || []).find((f) => Number(f.id) === Number(t.familyId));
            return { tipo: 'aseo', titulo: fam ? fam.name : 'Sin asignar', fecha: t.date, hora: '', org: 'Aseo del edificio', color: null };
          });
        items.push(...turnos);
        contextoDinamico += '\n--- PRÓXIMOS TURNOS DE ASEO ---\n' + turnos.map((t) => `${t.fecha} · ${t.titulo}`).join('\n');
        respuestaLocalFallback = turnos.length ? '🧹 **Próximos turnos de aseo del edificio:**' : '🧹 No hay turnos de aseo próximos.';
      } else {
        contextoDinamico += '\n--- AVISO DE PERMISOS ---\nEl usuario preguntó por el Aseo del Edificio, pero ese módulo es exclusivo del Administrador o el líder de Obispado. Explícaselo brevemente, sin inventar ni mostrar ningún dato de turnos o familias.';
        respuestaLocalFallback = '🧹 El módulo de Aseo del Edificio es visible solo para el Administrador o el líder de Obispado.';
      }
    }

    if (temaTemplo) {
      // Exclusivo de Obispado/Administrador (ver directory.js).
      if (isObispadoLeader(usuario, db)) {
        const miembros = db.directoryMembers || [];
        const totalMiembros = miembros.length;
        const conRecomendacion = miembros.filter((m) => m.templeRecommend).length;
        const porcentajeVigente = totalMiembros > 0 ? Math.round((conRecomendacion / totalMiembros) * 100) : 0;
        contextoDinamico += '\n--- ESTADÍSTICAS DE RECOMENDACIÓN DEL TEMPLO ---\n' + JSON.stringify({ totalMiembros, conRecomendacion, porcentajeVigente });
        respuestaLocalFallback = `🏛️ Un **${porcentajeVigente}%** de los miembros registrados tiene su recomendación del templo vigente (${conRecomendacion} de ${totalMiembros}).`;
      } else {
        contextoDinamico += '\n--- AVISO DE PERMISOS ---\nEl usuario preguntó por estadísticas del Directorio/recomendación del templo, pero esa información es exclusiva del Administrador o el líder de Obispado. Explícaselo brevemente, sin inventar ni mostrar ningún dato.';
        respuestaLocalFallback = '🏛️ Las estadísticas de recomendación del templo son visibles solo para el Administrador o el líder de Obispado.';
      }
    }

    if (temaCrecimiento) {
      if (usuario && VER_CRECIMIENTO.includes(usuario.role)) {
        const c = contextoCrecimiento(norm, db);
        contextoDinamico += c.contexto; respuestaLocalFallback = c.fallback;
      } else {
        contextoDinamico += '\n--- AVISO DE PERMISOS ---\nEl usuario preguntó por los indicadores de Crecimiento del Barrio, que solo pueden ver los líderes, el secretario de barrio y el Administrador. Explícaselo brevemente, sin inventar datos.';
        respuestaLocalFallback = '📊 Los indicadores de **Crecimiento del Barrio** están disponibles solo para líderes, el secretario de barrio y el Administrador.';
      }
    }

    if (temaMinistracion) {
      const c = contextoMinistracion(norm, usuario, db);
      contextoDinamico += c.contexto; respuestaLocalFallback = c.fallback;
    }

    if (contextoDinamico === '') {
      contextoDinamico = 'El usuario está saludando o haciendo una consulta general. Invítalo a consultar o agendar actividades/entrevistas, revisar aseo o información del barrio.';
      respuestaLocalFallback = '🐝 ¡Hola! Puedo ayudarte a consultar o **agendar** actividades y entrevistas, revisar los turnos de aseo, ver cómo vamos en **asistencia** y demás indicadores, o en el **Enfoque Ministración**. ¿Qué te gustaría hacer?';
    }

    const systemInstruction = `Eres Deseret, la abeja asistente de OrganizaSion. Hoy es ${fechaLegible(toISO(hoyObj))}.
Aquí tienes la información extraída de la base de datos:
${contextoDinamico}

REGLAS DE COMPORTAMIENTO:
1. Responde SOLO con los datos de arriba. NUNCA inventes datos que no estén ahí.
2. ${items.length ? 'La lista completa YA se le muestra al usuario como tarjetas debajo de tu respuesta: NO la repitas. Responde en 1 o 2 frases breves (un resumen o lo puntual que preguntó).' : 'Sé breve; si hay varios elementos, usa viñetas.'}
3. Pon en **negrita** títulos, nombres y fechas. Usa algún emoji amigable (🐝, 📅, 🧹, 🏛️, 🙋).
4. Tú no agendas nada en esta conversación. Si el usuario quiere agendar, dile que lo pida así: "agenda una actividad/entrevista para…". Nunca digas que ya agendaste algo.
5. Si ves un "AVISO DE PERMISOS", dile amablemente, en una frase, que esa información no está disponible para su perfil.
6. Si pregunta si "vamos mejorando" (asistencia, indicadores, ministración), parte con una conclusión clara (sí / no / mixto), y después menciona los 2 o 3 cambios más grandes con sus números (en puntos porcentuales o cantidad de personas). Cierra con una sugerencia breve y práctica si algo va bajando.
7. Si pide un ANÁLISIS o COMPARACIÓN (ej. Cuórum vs Sociedad de Socorro, "grandes diferencias", "en qué puede mejorar"), puedes extenderte más y usar esta estructura con subtítulos en negrita:
   **Panorama** (1-2 frases con la conclusión principal) · **Grandes diferencias** (2-3 viñetas, siempre con los números de ambos) · **En qué puede mejorar cada uno** (2-3 acciones concretas por organización, basadas en los datos y en las "sugerencias calculadas"; prioriza a las personas que están a un solo paso de Retener).
   Usa porcentajes para comparar grupos de distinto tamaño. Si a un grupo le faltan evaluaciones, dilo en vez de sacar conclusiones. Tono pastoral y constructivo, nunca de juicio sobre las personas.`;

    const redactado = await redactarConIA(systemInstruction, historial, mensaje);
    const resultado = redactado
      ? resp(filtrarAlucinacion(redactado), items.length ? { items } : {})
      : resp(respuestaLocalFallback, items.length ? { items } : {});
    if (redactado) guardarCache(clave, resultado);
    return resultado;
  } catch (error) {
    console.error('DETALLE DEL ERROR GENERAL:', error);
    return resp('🐝 Ocurrió un inconveniente al procesar la solicitud. Intenta de nuevo.');
  }
}
