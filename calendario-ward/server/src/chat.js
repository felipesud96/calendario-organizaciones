import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import { load, withDb, nextId, interviewEligibility } from './db.js';
import { canEditOrg, PURPOSE_OPTIONS, orgRequiresSupervisingAdults } from './routes/events.js';
import { canScheduleOrg, orgAllowsInterviews, orgSeesAllInterviews } from './routes/interviews.js';
import { findStakeConflicts } from './stakeCalendar.js';
import { isObispadoLeader } from './routes/stake.js';

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

function buscarMiembros(nombre, data) {
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
// AGENDAMIENTO REAL — usa las MISMAS reglas de permisos y los MISMOS
// campos obligatorios que exige POST /api/events y POST /api/interviews
// (ver events.js / interviews.js), y escribe con nextId()+withDb() como
// el resto de la app.
// ----------------------------------------------------------------------

async function intentarAgendarActividad(mensaje, mensajeMin, hoyObj, usuario, data, previo = null) {
  if (!usuario) return '🔒 Para agendar actividades necesitas haber iniciado sesión.';

  const d = { ...(previo || {}) };
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
  d.purpose = d.purpose || (previo ? purposeDesdeRespuesta(mensajeMin) : inferPurpose(mensajeMin));

  const titulo = d.titulo;
  const preguntar = (falta, texto) => { guardarBorrador(usuario, 'actividad', d, falta); return texto; };

  if (!d.fecha) return preguntar('fecha', `📅 Me falta la **fecha** para agendar "${titulo}". ¿Para qué día? (puedes decir "mañana", "el sábado", "15 de octubre"…)`);
  if (!d.hora) return preguntar('hora', `🕐 Me falta la **hora** para "${titulo}" el ${d.fecha}. ¿A qué hora es?`);
  if (!d.orgId) return preguntar('organizacion', `🏷️ ¿Para qué organización es "${titulo}"? (Cuórum de Élderes, Sociedad de Socorro, Primaria, Hombres Jóvenes, Mujeres Jóvenes, Jóvenes Adultos Solteros, Obispado…)`);

  if (!canEditOrg(usuario, d.orgId)) { borrarBorrador(usuario); return `🚫 No tienes permiso para agendar actividades de esa organización (solo su líder o un Administrador pueden).`; }

  if (!d.purpose) return preguntar('proposito', `🎯 ¿Cuál es el propósito de "${titulo}"? (${PURPOSE_OPTIONS.join(', ')})`);
  if (!PURPOSE_OPTIONS.includes(d.purpose)) return preguntar('proposito', `🎯 No reconocí el propósito — debe ser uno de: ${PURPOSE_OPTIONS.join(', ')}.`);

  // Desde acá cualquier salida termina el flujo (se guarda o se deriva al formulario).
  borrarBorrador(usuario);

  if (orgRequiresSupervisingAdults(data.organizations, d.orgId)) {
    return `👥 Esta organización requiere el nombre de al menos **dos adultos supervisores** presentes (Manual General 20.7.1). Agéndala desde el formulario de **Mis Actividades** para poder indicarlos — no la guardé todavía.`;
  }

  const conflicts = findStakeConflicts(data, { date: d.fecha, startTime: d.hora, endTime: null });
  if (conflicts.length && !isObispadoLeader(usuario, data)) {
    const lista = conflicts.map((c) => `"${c.title}"`).join(', ');
    return `⚠️ Esa fecha/hora choca con ${conflicts.length > 1 ? 'actividades de Estaca' : 'una actividad de Estaca'} (${lista}), que tienen prioridad. Solo el líder de Obispado o un Administrador puede autorizarlo — agéndala desde el formulario normal para poder confirmarlo. No la guardé.`;
  }

  const org = data.organizations.find((o) => o.id === Number(d.orgId));
  const now = new Date().toISOString();
  const evento = await withDb((db) => {
    const e = {
      id: nextId(db, 'events'),
      title: titulo,
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

  return `✅ **¡Listo! Actividad agendada:**\n\n` +
    `• **${evento.title}**\n` +
    `• 📅 ${evento.date} a las ${evento.startTime}\n` +
    `• 🏷️ ${org?.name || ''} · Propósito: ${d.purpose}\n\n` +
    `_Ya aparece en el calendario. Si algo no calza, edítala desde el calendario._`;
}

async function intentarAgendarEntrevista(mensaje, mensajeMin, hoyObj, usuario, data, previo = null, falta = null) {
  if (!usuario) return '🔒 Para agendar entrevistas necesitas haber iniciado sesión.';

  const d = { ...(previo || {}) };
  const preguntar = (f, texto) => { guardarBorrador(usuario, 'entrevista', d, f); return texto; };

  // Respuestas a "¿cuál de estas personas?" y "¿lo agendo igual?".
  if (falta === 'elegirMiembro' && Array.isArray(d.opciones)) {
    const num = mensajeMin.match(/^\s*(?:el|la|opci[oó]n|n[uú]mero)?\s*(\d{1,2})\b/);
    const primeraPalabra = normalizeSearchText(mensajeMin).split(/\s+/)[0];
    if (num && d.opciones[Number(num[1]) - 1]) {
      const elegido = d.opciones[Number(num[1]) - 1];
      d.memberName = elegido.name; d.memberUserId = elegido.userId; d.miembroResuelto = true;
    } else if (/^(ninguno|ninguna|ningun)$/.test(primeraPalabra)) {
      d.miembroResuelto = true; // se deja el nombre tal como lo escribió
    } else {
      d.memberName = nombreDesdeRespuesta(mensaje); d.miembroResuelto = false;
    }
    delete d.opciones;
  } else if (falta === 'confirmarNombre') {
    if (/^\s*(s[ií]|dale|ok|okay|confirmo|agend[aá]\w*|as[ií] est[aá] bien|correcto)(?=[\s,.!]|$)/i.test(mensajeMin)) {
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
  if (!d.orgId && usuario.role === 'leader') d.orgId = Number(usuario.organizationId);

  if (!d.memberName) return preguntar('nombre', `🙋 ¿A quién quieres entrevistar?${d.fecha ? ` (ya tengo el ${d.fecha}${d.hora ? ' a las ' + d.hora : ''})` : ''}`);
  if (!d.fecha) return preguntar('fecha', `📅 Me falta la **fecha** para la entrevista con **${d.memberName}**. ¿Qué día?`);
  if (!d.hora) return preguntar('hora', `🕐 Me falta la **hora** para la entrevista con **${d.memberName}** el ${d.fecha}. ¿A qué hora?`);
  if (!d.orgId) return preguntar('organizacion', `🏷️ ¿De qué organización es esta entrevista?`);

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
      return preguntar('elegirMiembro', `🔎 Encontré varias personas que coinciden con **${d.memberName}**:\n\n${listaOpciones(d.opciones)}${extra}\n\nResponde con el **número**, o "ninguno" para dejarlo como lo escribiste.`);
    } else {
      return preguntar('confirmarNombre', `🔎 No encontré a **${d.memberName}** en el Directorio ni entre los usuarios registrados. ¿La agendo igual con ese nombre? (responde **sí**, o escríbeme el nombre correcto)`);
    }
  }

  borrarBorrador(usuario);
  if (!orgAllowsInterviews(data, d.orgId)) return `🚫 Esa organización no agenda entrevistas en la app. No la guardé.`;
  if (!canScheduleOrg(usuario, d.orgId)) return `🚫 No tienes permiso para agendar entrevistas de esa organización. No la guardé.`;

  // Misma validación del Manual General que el formulario (solo se puede
  // revisar si la persona tiene cuenta registrada con su perfil completo).
  const orgEntrevista = data.organizations.find((o) => o.id === Number(d.orgId));
  const cuenta = d.memberUserId ? (data.users || []).find((u) => u.id === Number(d.memberUserId)) : null;
  if (cuenta && orgEntrevista && interviewEligibility(orgEntrevista.name, cuenta) === false) {
    return `🚫 Esta entrevista es de ${orgEntrevista.name} y **${cuenta.name}** no corresponde según su perfil (sexo/edad) — según el Manual General, agéndala con el Obispado. No la guardé.`;
  }

  const org = data.organizations.find((o) => o.id === Number(d.orgId));
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

  return `✅ **¡Listo! Entrevista agendada:**\n\n` +
    `• **${interview.memberName}**${interview.memberUserId ? ' 🔗 vinculado a su cuenta' : ''}\n` +
    `• 📅 ${interview.date} a las ${interview.startTime}\n` +
    `• 🏷️ ${org?.name || ''}\n\n` +
    `_Ya aparece en el módulo de Entrevistas. Si algo no es correcto, edítala desde ahí._`;
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

export async function procesarPreguntaChat(mensaje, historial = [], usuario = null) {
  try {
    const db = load();
    const hoyObj = hoyEnChile();
    const hoy = toISO(hoyObj);
    const mensajeMinusculas = mensaje.toLowerCase().trim();

    // ------------------------------------------------------------------------
    // MÓDULO 1: AGENDAMIENTO REAL DE ACTIVIDADES/REUNIONES Y ENTREVISTAS
    // ------------------------------------------------------------------------
    const matchAgendar = mensajeMinusculas.match(/(agendar|agenda|agéndame|agendame|crear|crea|programar|programa|añadir|añade|agregar|agrega)\s+(?:una?|la|el|mi)?\s*(actividad|reuni[oó]n|evento|entrevista|asado|convivencia|paseo|taller|capacitaci[oó]n|devocional|campamento|cena|once|noche de hogar|charla|clase)/);
    if (matchAgendar) {
      borrarBorrador(usuario); // un pedido nuevo reemplaza cualquier borrador anterior
      if (matchAgendar[2] === 'entrevista') {
        return await intentarAgendarEntrevista(mensaje, mensajeMinusculas, hoyObj, usuario, db);
      }
      return await intentarAgendarActividad(mensaje, mensajeMinusculas, hoyObj, usuario, db);
    }

    // Continuación de un agendamiento a medias (respuesta a "¿a qué hora?",
    // "¿a quién?", etc.).
    const borrador = leerBorrador(usuario);
    if (borrador) {
      if (/^\s*(cancela|cancelar|olv[ií]dalo|d[ée]jalo|no\s*,?\s*gracias|mejor no)\b/i.test(mensajeMinusculas)) {
        borrarBorrador(usuario);
        return '👌 Listo, cancelé ese agendamiento. No se guardó nada.';
      }
      const esPreguntaNueva = /^\s*(¿|qu[ée]\s|cu[aá]l|cu[aá]nt|cu[aá]ndo|d[oó]nde|qui[ée]n(es)?\s+(tiene|hay|son)|mu[ée]strame|hay\s)/i.test(mensajeMinusculas);
      if (!esPreguntaNueva) {
        if (borrador.tipo === 'entrevista') {
          return await intentarAgendarEntrevista(mensaje, mensajeMinusculas, hoyObj, usuario, db, borrador.datos, borrador.falta);
        }
        return await intentarAgendarActividad(mensaje, mensajeMinusculas, hoyObj, usuario, db, borrador.datos);
      }
      borrarBorrador(usuario);
    }

    // ------------------------------------------------------------------------
    // MÓDULO 2: VERIFICAR CACHÉ DE LECTURA (<10 ms) — solo consultas, nunca
    // acciones (el bloque de arriba ya retornó si era agendamiento).
    // ------------------------------------------------------------------------
    const clave = claveCache(usuario, mensajeMinusculas);
    const cacheada = leerCache(clave);
    if (cacheada) return cacheada;

    let contextoDinamico = '';
    let respuestaLocalFallback = '';

    if (mensajeMinusculas.match(/(actividad|actividades|calendario|cuórum|cuorum|élderes|elderes|sociedad|primaria|jóvenes|jovenes|fin de semana|mes|próximo|proximo)/)) {
      let filtroEventos = (db.events || []).filter((e) => e.date >= hoy);
      if (mensajeMinusculas.includes('fin de semana')) {
        const sabado = new Date(hoyObj);
        // Un domingo, "este fin de semana" es ayer (sábado) + hoy.
        sabado.setDate(hoyObj.getDate() + (hoyObj.getDay() === 0 ? -1 : (6 - hoyObj.getDay() + 7) % 7));
        const domingo = new Date(sabado);
        domingo.setDate(sabado.getDate() + 1);
        const fSab = toISO(sabado);
        const fDom = toISO(domingo);
        filtroEventos = filtroEventos.filter((e) => e.date === fSab || e.date === fDom);
      }
      const actividades = filtroEventos.map((e) => {
        const org = (db.organizations || []).find((o) => Number(o.id) === Number(e.organizationId));
        return { titulo: e.title, fecha: e.date, hora: e.startTime || '', organizacion: org ? org.name : 'General' };
      });
      contextoDinamico += '\n--- ACTIVIDADES ENCONTRADAS EN EL CALENDARIO ---\n' + JSON.stringify(actividades);
      respuestaLocalFallback = actividades.length
        ? '📅 **Actividades encontradas en el calendario:**\n\n' + actividades.map((a) => `• **${a.titulo}** (${a.organizacion}) - ${a.fecha}${a.hora ? ' ' + a.hora : ''}`).join('\n')
        : '📅 No encontré actividades agendadas para el periodo consultado.';
    }

    if (mensajeMinusculas.match(/(entrevista|entrevistas)/)) {
      // Mismo criterio de privacidad que GET /api/interviews (ver
      // orgSeesAllInterviews en interviews.js): las entrevistas son
      // información privada de los miembros. Antes este bloque traía TODAS
      // las entrevistas de TODO el barrio sin importar quién preguntara —
      // acá se acota exactamente igual que el endpoint REST equivalente.
      let entrevistasVisibles = (db.interviews || [])
        .filter((iv) => iv.date >= hoy && (iv.status || 'scheduled') === 'scheduled');
      if (!usuario) {
        entrevistasVisibles = [];
      } else if (['member', 'ward_clerk', 'financial_clerk'].includes(usuario.role)) {
        entrevistasVisibles = entrevistasVisibles.filter((iv) => Number(iv.memberUserId) === Number(usuario.id));
      } else if (!orgSeesAllInterviews(usuario, db)) {
        entrevistasVisibles = entrevistasVisibles.filter((iv) => Number(iv.organizationId) === Number(usuario.organizationId) || Number(iv.memberUserId) === Number(usuario.id));
      }
      const entrevistas = entrevistasVisibles.map((iv) => {
        const org = (db.organizations || []).find((o) => Number(o.id) === Number(iv.organizationId));
        return { nombre: iv.memberName, fecha: iv.date, hora: iv.startTime, organizacion: org ? org.name : '' };
      });
      contextoDinamico += '\n--- ENTREVISTAS AGENDADAS (pendientes, ya acotadas a lo que este usuario puede ver) ---\n' + JSON.stringify(entrevistas);
      respuestaLocalFallback = entrevistas.length
        ? '🙋 **Próximas entrevistas agendadas:**\n\n' + entrevistas.map((e) => `• **${e.nombre}** (${e.organizacion}) - ${e.fecha} ${e.hora}`).join('\n')
        : '🙋 No hay entrevistas pendientes agendadas para ti.';
    }

    if (mensajeMinusculas.match(/(aseo|limpieza|limpiar|edificio|capilla|turno|familia)/)) {
      // El módulo de Aseo del Edificio es exclusivo de Obispado/Administrador
      // (ver cleaning.js, isObispadoLeader) — antes este bloque le mostraba
      // los turnos y las familias asignadas a cualquier usuario logueado que
      // preguntara, sin verificar el permiso.
      if (isObispadoLeader(usuario, db)) {
        const turnosAseo = (db.cleaningShifts || [])
          .filter((t) => t.date >= hoy)
          .map((t) => {
            const fam = (db.families || []).find((f) => Number(f.id) === Number(t.familyId));
            return { fecha: t.date, familia: fam ? fam.name : 'Sin asignar' };
          });
        contextoDinamico += '\n--- TURNOS DE ASEO ---\n' + JSON.stringify(turnosAseo);
        if (turnosAseo.length > 0) {
          respuestaLocalFallback = '🧹 **Próximos turnos de aseo del edificio:**\n\n' + turnosAseo.map((t) => `• Fecha: **${t.fecha}** - Familia: **${t.familia}**`).join('\n');
        }
      } else {
        contextoDinamico += '\n--- AVISO DE PERMISOS ---\nEl usuario preguntó por el Aseo del Edificio, pero ese módulo es exclusivo del Administrador o el líder de Obispado. Explícaselo brevemente, sin inventar ni mostrar ningún dato de turnos o familias.';
        respuestaLocalFallback = '🧹 El módulo de Aseo del Edificio es visible solo para el Administrador o el líder de Obispado.';
      }
    }

    if (mensajeMinusculas.match(/(recomendación|recomendacion|templo|porcentaje|cuántos|cuantos|jóvenes|jovenes|adultos|cumpleaños|miembros)/)) {
      // El Directorio y "Enfoque Ministración" (de donde sale este dato) son
      // exclusivos de Obispado/Administrador (ver directory.js,
      // isObispadoLeader) — antes cualquier usuario logueado podía pedirle
      // esto a Deseret sin tener acceso al módulo real.
      if (isObispadoLeader(usuario, db)) {
        const miembros = db.directoryMembers || [];
        const totalMiembros = miembros.length;
        const conRecomendacion = miembros.filter((m) => m.templeRecommend).length;
        const porcentajeVigente = totalMiembros > 0 ? Math.round((conRecomendacion / totalMiembros) * 100) : 0;
        contextoDinamico += '\n--- ESTADÍSTICAS DE RECOMENDACIÓN DEL TEMPLO ---\n' + JSON.stringify({ totalMiembros, conRecomendacion, porcentajeVigente });
        if (mensajeMinusculas.includes('porcentaje') || mensajeMinusculas.includes('cuántos') || mensajeMinusculas.includes('cuantos')) {
          respuestaLocalFallback = `🏛️ **Estadísticas de Recomendación del Templo:**\n\n• Un **${porcentajeVigente}%** de los miembros registrados tiene su recomendación del templo vigente (${conRecomendacion} de ${totalMiembros}).`;
        }
      } else {
        contextoDinamico += '\n--- AVISO DE PERMISOS ---\nEl usuario preguntó por estadísticas del Directorio/recomendación del templo, pero esa información es exclusiva del Administrador o el líder de Obispado. Explícaselo brevemente, sin inventar ni mostrar ningún dato.';
        if (mensajeMinusculas.includes('porcentaje') || mensajeMinusculas.includes('cuántos') || mensajeMinusculas.includes('cuantos')) {
          respuestaLocalFallback = '🏛️ Las estadísticas de recomendación del templo son visibles solo para el Administrador o el líder de Obispado.';
        }
      }
    }

    if (contextoDinamico === '') {
      contextoDinamico = 'El usuario está saludando o haciendo una consulta general. Invítalo a consultar o agendar actividades/entrevistas, revisar aseo o información del barrio.';
      respuestaLocalFallback = '🐝 ¡Hola! Puedo ayudarte a consultar o **agendar** actividades y entrevistas, revisar los turnos de aseo o verificar recomendaciones del templo. ¿Qué te gustaría hacer?';
    }

    const systemInstruction = `Eres Deseret, la abeja asistente de OrganizaSion.
Aquí tienes la información extraída de la base de datos:
${contextoDinamico}

REGLAS DE COMPORTAMIENTO:
1. Responde preguntas de CONSULTA E INFORMACIÓN directamente, usando SOLO los datos de la sección de arriba. NUNCA inventes datos que no estén ahí.
2. NUNCA respondas en un solo párrafo gigante. Usa listas ordenadas con viñetas.
3. Pon en **negrita** los títulos de actividades, nombres de familias, personas y fechas.
4. Usa emojis amigables (🐝, 📅, 🧹, 🏛️, 🙋).
5. Esta conversación es de SOLO CONSULTA — tú no agendas nada acá directamente. Si el usuario quiere agendar algo, dile que lo pida así de claro: "agenda una actividad/entrevista para…" — eso sí crea el registro de verdad. Nunca digas que ya agendaste algo si no te lo confirmó el sistema.
6. Si ves un "AVISO DE PERMISOS" en la información de arriba, es una EXCEPCIÓN a la regla 1: en ese caso SÍ debes decirle al usuario, en una frase breve y amable, que esa información no está disponible para su perfil — nunca inventes ni te acerques a dar el dato de todas formas.`;

    // Historial reciente (últimas interacciones) para que la IA tenga contexto
    // de lo que se habló antes — antes se armaba en el frontend pero nunca
    // llegaba a esta función por un bug de cableado en server.js.
    const historyTurns = (historial || []).flatMap((h) => ([
      { role: 'user', parts: [{ text: h.user || '' }] },
      { role: 'model', parts: [{ text: h.bot || '' }] },
    ]));

    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const ai = new GoogleGenAI({ apiKey: geminiKey });
        const response = await ai.models.generateContent({
          model: 'gemini-3.6-flash',
          contents: [...historyTurns, { role: 'user', parts: [{ text: mensaje }] }],
          config: { systemInstruction },
        });
        if (response && response.text) {
          const texto = filtrarAlucinacion(response.text);
          guardarCache(clave, texto);
          return texto;
        }
      } catch (errGemini) {
        console.warn('⚠️ Gemini falló (saturación/cuota). Pasando a Groq...', errGemini.message);
      }
    }

    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      try {
        const groq = new Groq({ apiKey: groqKey });
        const completion = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: systemInstruction },
            ...(historial || []).flatMap((h) => ([
              { role: 'user', content: h.user || '' },
              { role: 'assistant', content: h.bot || '' },
            ])),
            { role: 'user', content: mensaje },
          ],
          temperature: 0.5,
          max_tokens: 1024,
        });
        const respuestaGroq = completion.choices[0]?.message?.content;
        if (respuestaGroq) {
          const texto = filtrarAlucinacion(respuestaGroq);
          guardarCache(clave, texto);
          return texto;
        }
      } catch (errGroq) {
        console.warn('⚠️ Groq falló. Usando Fallback Local...', errGroq.message);
      }
    }

    if (respuestaLocalFallback) return respuestaLocalFallback;
    return '🐝 No pude procesar tu solicitud en este momento. Por favor intenta de nuevo.';
  } catch (error) {
    console.error('DETALLE DEL ERROR GENERAL:', error);
    return '🐝 Ocurrió un inconveniente al procesar la solicitud. Intenta de nuevo.';
  }
}
