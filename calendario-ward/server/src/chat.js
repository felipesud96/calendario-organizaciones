import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import { load, withDb, nextId } from './db.js';
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

function scopeCacheParaUsuario(usuario) {
  if (!usuario) return 'anon';
  return `${usuario.role || ''}:${usuario.organizationId ?? ''}`;
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

function toISO(d) { return d.toISOString().slice(0, 10); }

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
    const d = new Date(year, month, day);
    if (!Number.isNaN(d.getTime())) return toISO(d);
  }

  const deMes = mensajeMin.match(/\b(\d{1,2})\s+de\s+([a-záéíóúñ]+)(?:\s+de\s+(\d{4}))?\b/);
  if (deMes && MESES[deMes[2]] !== undefined) {
    const day = Number(deMes[1]);
    const month = MESES[deMes[2]];
    const year = deMes[3] ? Number(deMes[3]) : hoyObj.getFullYear();
    const d = new Date(year, month, day);
    if (!deMes[3] && d < hoyObj) d.setFullYear(year + 1); // ya pasó este año y no dijo año -> asume el próximo
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
  let m = mensajeMin.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/);
  if (m) {
    let h = Number(m[1]);
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m[2]}`;
  }
  m = mensajeMin.match(/\ba\s+las?\s+(\d{1,2})\s*(am|pm)?\b/) || mensajeMin.match(/\b(\d{1,2})\s*(am|pm)\b/);
  if (m) {
    let h = Number(m[1]);
    const ampm = m[2];
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

function inferOrganizationId(mensajeMin, orgs) {
  const norm = normalizeSearchText(mensajeMin);
  for (const [alias, nombreReal] of Object.entries(ORG_ALIASES)) {
    if (norm.includes(normalizeSearchText(alias))) {
      const org = orgs.find((o) => o.name === nombreReal);
      if (org) return org.id;
    }
  }
  for (const org of orgs) {
    const n = normalizeSearchText(org.name);
    if (n && norm.includes(n)) return org.id;
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
// AGENDAMIENTO REAL — usa las MISMAS reglas de permisos y los MISMOS
// campos obligatorios que exige POST /api/events y POST /api/interviews
// (ver events.js / interviews.js), y escribe con nextId()+withDb() como
// el resto de la app — a diferencia de la versión anterior, que escribía
// directo con save() e ID de Date.now(), saltándose todo esto.
// ----------------------------------------------------------------------

async function intentarAgendarActividad(mensaje, mensajeMin, hoyObj, usuario, data) {
  if (!usuario) return '🔒 Para agendar actividades necesitas haber iniciado sesión.';

  let titulo = mensaje
    .replace(/(agendar|agenda|agéndame|agendame|crear|crea|programar|programa|añadir|añade|agregar|agrega)\s+(una?|la|el|mi)?\s*(actividad|reuni[oó]n|evento)?\s*(de|para|del)?/i, '')
    .trim();
  titulo = limpiarTitulo(titulo);
  if (!titulo) titulo = 'Actividad';
  titulo = titulo.charAt(0).toUpperCase() + titulo.slice(1);

  const fecha = parseFecha(mensajeMin, hoyObj);
  if (!fecha) return `📅 Me falta la **fecha** para agendar "${titulo}". ¿Para qué día? (puedes decir "mañana", "el sábado", "15 de octubre"…)`;

  const hora = parseHora(mensajeMin);
  if (!hora) return `🕐 Me falta la **hora** para "${titulo}" el ${fecha}. ¿A qué hora es?`;

  const orgId = inferOrganizationId(mensajeMin, data.organizations);
  if (!orgId) return `🏷️ ¿Para qué organización es "${titulo}"? (Cuórum de Élderes, Sociedad de Socorro, Primaria, Hombres Jóvenes, Mujeres Jóvenes, Jóvenes Adultos Solteros, Obispado…)`;

  if (!canEditOrg(usuario, orgId)) return `🚫 No tienes permiso para agendar actividades de esa organización (solo su líder o un Administrador pueden).`;

  const purpose = inferPurpose(mensajeMin);
  if (!purpose) return `🎯 ¿Cuál es el propósito de "${titulo}"? (Espiritual, Físico, Académico, Social o Servicio)`;
  if (!PURPOSE_OPTIONS.includes(purpose)) return `🎯 No reconocí el propósito — debe ser uno de: ${PURPOSE_OPTIONS.join(', ')}.`;

  if (orgRequiresSupervisingAdults(data.organizations, orgId)) {
    return `👥 Esta organización requiere el nombre de al menos **dos adultos supervisores** presentes (Manual General 20.7.1) antes de poder guardar la actividad — dime sus nombres y la agendo.`;
  }

  const conflicts = findStakeConflicts(data, { date: fecha, startTime: hora, endTime: null });
  if (conflicts.length && !isObispadoLeader(usuario, data)) {
    const lista = conflicts.map((c) => `"${c.title}"`).join(', ');
    return `⚠️ Esa fecha/hora choca con ${conflicts.length > 1 ? 'actividades de Estaca' : 'una actividad de Estaca'} (${lista}), que tienen prioridad. Solo el líder de Obispado o un Administrador puede autorizarlo — agéndala desde el formulario normal para poder confirmarlo.`;
  }

  const org = data.organizations.find((o) => o.id === Number(orgId));
  const now = new Date().toISOString();
  const evento = await withDb((d) => {
    const e = {
      id: nextId(d, 'events'),
      title: titulo,
      date: fecha,
      startTime: hora,
      organizationId: Number(orgId),
      purpose,
      createdBy: usuario.id,
      createdAt: now,
      updatedAt: now,
    };
    d.events.push(e);
    return e;
  });

  return `✅ **¡Listo! Actividad agendada:**\n\n` +
    `• **${evento.title}**\n` +
    `• 📅 ${evento.date} a las ${evento.startTime}\n` +
    `• 🏷️ ${org?.name || ''} · Propósito: ${purpose}\n\n` +
    `_Si algo no calza (fecha, hora, propósito u organización), dímelo y lo corrijo._`;
}

async function intentarAgendarEntrevista(mensaje, mensajeMin, hoyObj, usuario, data) {
  if (!usuario) return '🔒 Para agendar entrevistas necesitas haber iniciado sesión.';

  const nombreMatch = mensaje.match(/entrevist\w*\s+(?:a|con)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ.'\- ]+?)(?:\s+(?:el|para|a las?|el d[ií]a|ma[ñn]ana|hoy|pasado|este|próxim\w*)\b|[.,]|$)/i);
  const memberName = nombreMatch ? nombreMatch[1].trim() : null;
  if (!memberName) return `🙋 ¿A quién quieres entrevistar? Dime algo como "agenda una entrevista con Juan Pérez el jueves a las 19:00".`;

  const fecha = parseFecha(mensajeMin, hoyObj);
  if (!fecha) return `📅 Me falta la **fecha** para la entrevista con **${memberName}**. ¿Qué día?`;

  const hora = parseHora(mensajeMin);
  if (!hora) return `🕐 Me falta la **hora** para la entrevista con **${memberName}** el ${fecha}. ¿A qué hora?`;

  let orgId = inferOrganizationId(mensajeMin, data.organizations);
  if (!orgId && usuario.role === 'leader') orgId = Number(usuario.organizationId);
  if (!orgId) return `🏷️ ¿De qué organización es esta entrevista?`;

  if (!orgAllowsInterviews(data, orgId)) return `🚫 Esa organización no agenda entrevistas en la app.`;
  if (!canScheduleOrg(usuario, orgId)) return `🚫 No tienes permiso para agendar entrevistas de esa organización.`;

  const org = data.organizations.find((o) => o.id === Number(orgId));
  const now = new Date().toISOString();
  const interview = await withDb((d) => {
    const id = nextId(d, 'interviews');
    const iv = {
      id,
      groupId: id,
      memberName,
      memberUserId: null,
      memberPhone: '',
      memberEmail: '',
      description: '',
      location: '',
      sala: '',
      interviewerName: usuario.name || '',
      interviewerEmail: '',
      interviewerPhone: '',
      date: fecha,
      startTime: hora,
      endTime: null,
      organizationId: Number(orgId),
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
    d.interviews.push(iv);
    return iv;
  });

  return `✅ **¡Listo! Entrevista agendada:**\n\n` +
    `• **${interview.memberName}**\n` +
    `• 📅 ${interview.date} a las ${interview.startTime}\n` +
    `• 🏷️ ${org?.name || ''}\n\n` +
    `_Si el nombre, la fecha, la hora o la organización no son correctos, dímelo y lo corrijo._`;
}

export async function procesarPreguntaChat(mensaje, historial = [], usuario = null) {
  try {
    const db = load();
    const hoyObj = new Date();
    const hoy = hoyObj.toISOString().split('T')[0];
    const mensajeMinusculas = mensaje.toLowerCase().trim();

    // ------------------------------------------------------------------------
    // MÓDULO 1: AGENDAMIENTO REAL DE ACTIVIDADES/REUNIONES Y ENTREVISTAS
    // ------------------------------------------------------------------------
    // El verbo y el sustantivo ya NO necesitan estar pegados — "agendar UNA
    // actividad" ahora sí dispara esto (antes solo "agendar actividad", sin
    // artículo, lo cual casi nunca es como se habla naturalmente).
    // Además de "actividad/reunión/evento/entrevista" literales, se
    // reconocen los sinónimos más comunes con los que la gente realmente
    // pide agendar algo (asado, convivencia, paseo, taller, capacitación,
    // devocional, campamento, cena, once) — todos ruteados como actividad,
    // salvo "entrevista" que tiene su propio flujo.
    const matchAgendar = mensajeMinusculas.match(/(agendar|agenda|agéndame|agendame|crear|crea|programar|programa|añadir|añade|agregar|agrega)\s+(?:una?|la|el|mi)?\s*(actividad|reuni[oó]n|evento|entrevista|asado|convivencia|paseo|taller|capacitaci[oó]n|devocional|campamento|cena|once|noche de hogar|charla|clase)/);
    if (matchAgendar) {
      if (matchAgendar[2] === 'entrevista') {
        return await intentarAgendarEntrevista(mensaje, mensajeMinusculas, hoyObj, usuario, db);
      }
      return await intentarAgendarActividad(mensaje, mensajeMinusculas, hoyObj, usuario, db);
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
        sabado.setDate(hoyObj.getDate() + ((6 - hoyObj.getDay() + 7) % 7));
        const domingo = new Date(sabado);
        domingo.setDate(sabado.getDate() + 1);
        const fSab = sabado.toISOString().split('T')[0];
        const fDom = domingo.toISOString().split('T')[0];
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
          guardarCache(clave, response.text);
          return response.text;
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
          guardarCache(clave, respuestaGroq);
          return respuestaGroq;
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
