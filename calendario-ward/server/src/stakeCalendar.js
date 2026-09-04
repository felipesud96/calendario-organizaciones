// Sincronización con el calendario de Estaca (calendar.ChurchofJesusChrist.org),
// vía su enlace público de suscripción iCalendar (.ics). La Estaca agrupa a
// varios barrios. No TODAS sus actividades importan por igual:
//   - Actividades de coordinación real entre barrios (conferencias de
//     estaca, festivales, capacitaciones, días de servicio, etc.) SÍ
//     bloquean: ningún barrio/organización puede agendar algo encima sin
//     autorización del líder de Obispado (ver findStakeConflicts, usado
//     desde routes/events.js).
//   - Actividades puramente internas de la Estaca (entrevistas, reuniones de
//     presidencia de Estaca, de sumo consejo, presentación anual de la
//     Primaria, etc.) son solo informativas: se muestran en el calendario
//     pero NO bloquean nada — no involucran a los barrios.
// Qué título cuenta como "informativo" (no bloquea) se decide comparando el
// SUMMARY del evento contra una lista de palabras clave configurable desde
// Administración → Estaca (ver isBlockingStakeEvent más abajo).
//
// No se usa ninguna librería externa para leer el .ics: el formato que
// entrega el calendario de la Iglesia es simple (RFC 5545 sin RRULE), así que
// alcanza con un parser mínimo hecho a mano.

import { load, withDb, nextId } from './db.js';

export const STAKE_COLOR = '#7c3aed';
const FETCH_TIMEOUT_MS = 20000;
const SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000; // cada 4 horas

export const DEFAULT_NON_BLOCKING_KEYWORDS = ['entrevista', 'presidencia de estaca', 'sumo consejo', 'presentación anual'];

// Minúsculas y sin tildes, para que "Presentación" y "presentacion" (o
// mayúsculas) se traten igual al comparar.
export function normalizeText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// Un evento de Estaca "bloquea" (impide agendar algo encima sin autorización
// del líder de Obispado) salvo que su título contenga alguna de las palabras
// clave "no restrictivas" configuradas — esas son puramente informativas
// (reuniones internas de la Estaca, entrevistas, etc.) y no involucran a los
// barrios, así que no tiene sentido que compitan por horario con ellos.
export function isBlockingStakeEvent(ev, keywords) {
  const list = Array.isArray(keywords) && keywords.length ? keywords : DEFAULT_NON_BLOCKING_KEYWORDS;
  const title = normalizeText(ev?.title);
  if (!title) return true;
  return !list.some((kw) => {
    const k = normalizeText(kw);
    return k && title.includes(k);
  });
}

// ---------------- Parser de .ics (mínimo, sin librerías) ----------------

// RFC 5545: una línea "plegada" continúa en la siguiente si esta empieza con
// un espacio o un tab — hay que "desplegarla" antes de parsear cada campo.
function unfoldIcsLines(text) {
  const rawLines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const lines = [];
  for (const line of rawLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length) {
      lines.push(line);
    }
  }
  return lines;
}

function unescapeIcsText(str) {
  return String(str || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// Separa "PROP;PARAM1=V1;PARAM2=V2:VALOR" en { name, params, value }.
function parseIcsLine(line) {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;
  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const [name, ...paramParts] = head.split(';');
  const params = {};
  for (const p of paramParts) {
    const eqIdx = p.indexOf('=');
    if (eqIdx === -1) continue;
    params[p.slice(0, eqIdx).toUpperCase()] = p.slice(eqIdx + 1);
  }
  return { name: name.toUpperCase(), params, value };
}

// Convierte un valor DTSTART/DTEND (con sus parámetros) en { date, time,
// allDay }. Igual que el resto de la plataforma (ver ics.js), las horas se
// tratan como "hora flotante": no se hace conversión de huso horario, se
// toman los dígitos tal cual vienen (la Estaca y el barrio comparten zona
// horaria en la práctica).
function parseIcsDateValue(value, params) {
  const v = String(value || '').replace(/Z$/, '');
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(v)) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (!m) return null;
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null, allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?$/.exec(v);
  if (!m) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}`, allDay: false };
}

// items: [{ uid, title, date, startTime, endTime, allDay, description }]
export function parseIcsEvents(icsText) {
  const lines = unfoldIcsLines(icsText);
  const items = [];
  let cur = null;
  for (const rawLine of lines) {
    if (rawLine === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (rawLine === 'END:VEVENT') {
      if (cur && cur.date) {
        items.push({
          uid: cur.uid || `${cur.date}-${cur.startTime || 'allday'}-${cur.title || ''}`,
          title: cur.title || '(Sin título)',
          date: cur.date,
          startTime: cur.startTime || null,
          endTime: cur.endTime || null,
          allDay: !!cur.allDay,
          description: cur.description || '',
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const parsed = parseIcsLine(rawLine);
    if (!parsed) continue;
    if (parsed.name === 'UID') cur.uid = parsed.value.trim();
    else if (parsed.name === 'SUMMARY') cur.title = unescapeIcsText(parsed.value).trim();
    else if (parsed.name === 'DESCRIPTION') cur.description = unescapeIcsText(parsed.value).trim();
    else if (parsed.name === 'DTSTART') {
      const d = parseIcsDateValue(parsed.value, parsed.params);
      if (d) { cur.date = d.date; cur.startTime = d.time; cur.allDay = d.allDay; }
    } else if (parsed.name === 'DTEND') {
      const d = parseIcsDateValue(parsed.value, parsed.params);
      if (d) cur.endTime = d.time;
    }
  }
  return items;
}

// ---------------- Descarga del feed ----------------

// Devuelve { notModified: true } si el servidor respondió 304 (el feed
// sigue igual a la última vez — no es un error, es que no hay nada nuevo
// que descargar), o { notModified: false, text } con el contenido si hay
// que parsearlo de nuevo.
async function fetchIcsText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'CalendarioBarrioValleGrande/1.0 (+sincronizacion de calendario de Estaca)',
        // Le pedimos al servidor (o a cualquier CDN/caché intermedio) que no
        // nos conteste con una copia en caché — igual manejamos el 304 más
        // abajo por si de todas formas llega uno.
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });
    if (res.status === 304) return { notModified: true };
    if (!res.ok) throw new Error(`El calendario de Estaca respondió con error ${res.status}`);
    return { notModified: false, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- Sincronización ----------------
// Reemplaza por completo la lista de actividades de Estaca guardadas con lo
// que devuelva el feed en este momento. Si la descarga o el parseo fallan,
// NO se borran las actividades ya guardadas (para no perder la protección
// contra choques por una falla pasajera de red) — solo se registra el error.
export async function syncStakeCalendar() {
  const data0 = load();
  const url = data0.stakeCalendar?.url;
  if (!url) {
    return withDb((data) => {
      data.stakeCalendar = { ...data.stakeCalendar, lastSyncedAt: new Date().toISOString(), lastSyncOk: null, lastSyncError: 'No hay un enlace de calendario de Estaca configurado', eventCount: data.stakeEvents.length };
      return data.stakeCalendar;
    });
  }
  const now = new Date().toISOString();
  try {
    const result = await fetchIcsText(url);
    if (result.notModified) {
      // El feed no cambió desde la última vez que se sincronizó — se deja
      // tal cual lo que ya había guardado (sigue siendo válido) y solo se
      // actualiza la marca de tiempo. Esto NO es una falla.
      return withDb((data) => {
        data.stakeCalendar = { ...data.stakeCalendar, lastSyncedAt: now, lastSyncOk: true, lastSyncError: null, eventCount: data.stakeEvents.length };
        return data.stakeCalendar;
      });
    }
    const parsed = parseIcsEvents(result.text);
    return withDb((data) => {
      data.stakeEvents = parsed.map((ev) => ({ id: nextId(data, 'stakeEvents'), ...ev, syncedAt: now }));
      data.stakeCalendar = { ...data.stakeCalendar, lastSyncedAt: now, lastSyncOk: true, lastSyncError: null, eventCount: data.stakeEvents.length };
      return data.stakeCalendar;
    });
  } catch (e) {
    return withDb((data) => {
      data.stakeCalendar = { ...data.stakeCalendar, lastSyncedAt: now, lastSyncOk: false, lastSyncError: e.message || 'No se pudo descargar el calendario de Estaca', eventCount: data.stakeEvents.length };
      return data.stakeCalendar;
    });
  }
}

let schedulerStarted = false;
export function startStakeSyncScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  syncStakeCalendar().catch(() => {});
  setInterval(() => { syncStakeCalendar().catch(() => {}); }, SYNC_INTERVAL_MS);
}

// ---------------- Choques con actividades de Estaca (prioridad) ----------------
function toMinutes(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}
function timesOverlap(aStart, aEnd, bStart, bEnd) {
  // A diferencia del aviso de choque "suave" entre organizaciones (que ante
  // la duda prefiere NO avisar, para no molestar de más), acá se prefiere
  // bloquear ante la duda: la actividad de Estaca tiene prioridad, así que
  // si falta algún horario se trata como si ocupara el día completo.
  if (!aStart || !bStart) return true;
  const as = toMinutes(aStart), bs = toMinutes(bStart);
  const aeRaw = aEnd ? toMinutes(aEnd) : as;
  const beRaw = bEnd ? toMinutes(bEnd) : bs;
  const ae = aeRaw > as ? aeRaw : as + 1;
  const be = beRaw > bs ? beRaw : bs + 1;
  return as < be && bs < ae;
}

// candidate: { date, startTime, endTime }. Devuelve la lista de actividades
// de Estaca ese día que chocan en horario (o el día completo si alguna de
// las dos no tiene hora, ej. un evento de todo el día) — sin contar las que
// son puramente informativas (ver isBlockingStakeEvent).
export function findStakeConflicts(data, candidate) {
  if (!candidate?.date) return [];
  const keywords = data.stakeCalendar?.nonBlockingKeywords;
  const dayStakeEvents = (data.stakeEvents || []).filter((s) => s.date === candidate.date && isBlockingStakeEvent(s, keywords));
  if (!dayStakeEvents.length) return [];
  return dayStakeEvents.filter((s) => {
    if (s.allDay || !s.startTime) return true;
    return timesOverlap(candidate.startTime, candidate.endTime, s.startTime, s.endTime);
  });
}
