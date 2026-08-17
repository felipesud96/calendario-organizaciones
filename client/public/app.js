// Calendario de Organizaciones — frontend sin frameworks ni build step.
// Todo el estado vive en el objeto `state`; cada cambio relevante llama a render().

const API = '/api';
const APP_NAME = 'Calendario Barrio Valle Grande';
const DOW_LABELS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MONTH_LABELS = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const ROLE_LABELS = { admin: 'Administrador', leader: 'Líder', member: 'Miembro' };
const COLOR_PALETTE = ['#0EA5E9','#6366F1','#EC4899','#F59E0B','#10B981','#A855F7','#EF4444','#F97316','#14B8A6','#84CC16','#F43F5E','#8B5CF6'];
// Debe coincidir con PURPOSE_OPTIONS en server/src/routes/events.js — el
// balance del año del módulo Estadísticas se arma según estas categorías.
const PURPOSE_OPTIONS = ['Espiritual', 'Físico', 'Académico', 'Social', 'Servicio'];

const state = {
  token: localStorage.getItem('cow_token') || null,
  user: null,
  organizations: [],
  view: 'calendar',
  calMonth: startOfMonth(new Date()),
  activeOrgIds: null, // null = todas
  events: [],
  interviews: [],
  stakeEvents: [],
  stakeCalendar: null,
  interviewOrgFilter: 'all',
  adminSubtab: 'users',
  adminUsers: [],
  loading: false,
  meetingsSubtab: 'mine',
  statsSubtab: 'pending',
  statsYear: null,
  statsOrgId: null,
};

const root = document.getElementById('app');

// ---------------- API helper ----------------
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* sin cuerpo */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Error ${res.status}`);
    err.status = res.status;
    err.data = data; // ej: { stakeConflicts, canOverride, conflictDate } — ver openEventModal
    throw err;
  }
  return data;
}

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Corta un título largo a `max` caracteres + "…" para que quepa en las
// "pastillas" angostas del calendario (el título completo sigue disponible
// en el tooltip y en el detalle al hacer clic).
function truncateTitle(s, max = 15) {
  const str = String(s || '');
  return str.length > max ? str.slice(0, max).trimEnd() + '…' : str;
}

function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---------------- Fechas ----------------
function pad2(n) { return String(n).padStart(2, '0'); }
function toISODate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
function isSameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function fmtTime(t) { return t ? t.slice(0, 5) : ''; }
function fmtDateHuman(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dow = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'][date.getDay()];
  return `${dow} ${d} de ${MONTH_LABELS[m - 1]}`;
}

// ---------------- Lugar estandarizado ----------------
const STANDARD_LOCATIONS = ['Casa Capilla', 'Capilla'];
// Salas/espacios puntuales dentro de cada edificio — para poder reservar un
// espacio específico (y detectar choques por sala, no solo por "el
// edificio" en general — ver placesConflict). "Capilla" y "Casa Capilla"
// son dos edificios distintos, así que cada uno tiene su propio listado de
// salas.
const ROOMS_BY_LOCATION = {
  'Capilla': ['Salón Cultural', 'Sacramental'],
  'Casa Capilla': ['1er Piso', 'Sala 1', 'Sala 2'],
};

function salaOptionsHtml(location, selectedSala) {
  const rooms = ROOMS_BY_LOCATION[location] || [];
  const isOtraSala = !!selectedSala && !rooms.includes(selectedSala);
  return `
    <option value="" ${!selectedSala ? 'selected' : ''}>Sin especificar (todo el edificio)</option>
    ${rooms.map((r) => `<option value="${esc(r)}" ${selectedSala === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
    <option value="OtraSala" ${isOtraSala ? 'selected' : ''}>Otra sala (especificar)</option>`;
}

function locationFieldHtml(idPrefix, existingLocation, existingSala) {
  const loc = existingLocation || '';
  const sala = existingSala || '';
  const isStandard = STANDARD_LOCATIONS.includes(loc);
  const isOtroLugar = !!loc && !isStandard;
  const hasSalaOptions = STANDARD_LOCATIONS.includes(loc);
  return `
    <div class="field">
      <label>Lugar</label>
      <select name="locationType" id="${idPrefix}-location-type" required>
        <option value="" disabled ${!loc ? 'selected' : ''}>Selecciona un lugar…</option>
        ${STANDARD_LOCATIONS.map((l) => `<option value="${esc(l)}" ${loc === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        <option value="Otro" ${isOtroLugar ? 'selected' : ''}>Otro (especificar)</option>
      </select>
    </div>
    <div class="field" id="${idPrefix}-location-other-field" style="${isOtroLugar ? '' : 'display:none;'}">
      <label>¿Cuál lugar?</label>
      <input type="text" name="locationOther" placeholder="Ej: Estacionamiento" value="${esc(isOtroLugar ? loc : '')}" />
    </div>
    <div class="field" id="${idPrefix}-sala-field" style="${hasSalaOptions ? '' : 'display:none;'}">
      <label>Sala / espacio (opcional)</label>
      <select name="salaType" id="${idPrefix}-sala-type">
        ${salaOptionsHtml(loc, sala)}
      </select>
      <div id="${idPrefix}-sala-other-field" style="margin-top:8px; ${(!!sala && !(ROOMS_BY_LOCATION[loc] || []).includes(sala)) ? '' : 'display:none;'}">
        <input type="text" name="salaOther" placeholder="Ej: Oficina del Obispo" value="${esc((!!sala && !(ROOMS_BY_LOCATION[loc] || []).includes(sala)) ? sala : '')}" />
      </div>
    </div>`;
}

function wireLocationField(idPrefix, onChange) {
  const sel = document.getElementById(`${idPrefix}-location-type`);
  const otherField = document.getElementById(`${idPrefix}-location-other-field`);
  const salaField = document.getElementById(`${idPrefix}-sala-field`);
  const salaSel = document.getElementById(`${idPrefix}-sala-type`);
  const salaOtherField = document.getElementById(`${idPrefix}-sala-other-field`);
  sel.addEventListener('change', () => {
    otherField.style.display = sel.value === 'Otro' ? '' : 'none';
    const hasSala = STANDARD_LOCATIONS.includes(sel.value);
    salaField.style.display = hasSala ? '' : 'none';
    // El listado de salas depende del lugar elegido (Capilla y Casa Capilla
    // tienen salas distintas) — se regenera cada vez que cambia el lugar, y
    // la sala elegida se limpia porque ya no aplica en la lista nueva.
    salaSel.innerHTML = salaOptionsHtml(sel.value, '');
    salaOtherField.style.display = 'none';
    if (onChange) onChange();
  });
  salaSel.addEventListener('change', () => {
    salaOtherField.style.display = salaSel.value === 'OtraSala' ? '' : 'none';
    if (onChange) onChange();
  });
}

function computeLocationFromForm(fd) {
  const type = fd.get('locationType');
  if (type === 'Otro') return String(fd.get('locationOther') || '').trim();
  return type || '';
}

// La sala solo aplica cuando el lugar elegido es "Capilla" o "Casa Capilla".
function computeSalaFromForm(fd, location) {
  if (!STANDARD_LOCATIONS.includes(location)) return '';
  const type = fd.get('salaType');
  if (type === 'OtraSala') return String(fd.get('salaOther') || '').trim();
  return type || '';
}

// Muestra el lugar junto con la sala puntual (si la hay) — para usar en
// cualquier vista de solo lectura (calendario, "Mis Actividades",
// Entrevistas, avisos de choque, etc.) sin repetir la lógica en cada una.
function locationDisplay(item) {
  if (!item || !item.location) return '';
  return item.sala ? `${item.location} · ${item.sala}` : item.location;
}

// Dos lugares "chocan" si son el mismo lugar Y (no especificaron sala en
// alguno de los dos, o especificaron la misma sala). Si ambos indicaron una
// sala puntual y son distintas, son espacios separados del mismo edificio —
// no es un choque real (ej. "Casa Capilla · Sala 1" vs "Casa Capilla · Sala
// 2"). Si a alguno le falta la sala, se asume "todo el edificio" y sí se
// avisa, para no dejar pasar un choque real por falta de dato.
function placesConflict(aLoc, aSala, bLoc, bSala) {
  if (!aLoc || !bLoc) return false;
  if (normalizeLocation(aLoc) !== normalizeLocation(bLoc)) return false;
  if (aSala && bSala && normalizeLocation(aSala) !== normalizeLocation(bSala)) return false;
  return true;
}

// ---------------- Actividades en conjunto con otras organizaciones ----------------
function involvedOrgsFieldHtml(idPrefix, existingIds) {
  const ids = (existingIds || []).map(Number);
  return `
    <div class="field" id="${idPrefix}-involved-orgs-field">
      <label>¿Participan otras organizaciones? (opcional)</label>
      <div id="${idPrefix}-involved-orgs" style="display:flex; flex-wrap:wrap; gap:8px 14px; padding:4px 2px;">
        ${state.organizations.map((o) => `
          <label data-org-id="${o.id}" style="display:flex; align-items:center; gap:5px; font-size:13px; font-weight:400; cursor:pointer;">
            <input type="checkbox" name="involvedOrganizationIds" value="${o.id}" ${ids.includes(o.id) ? 'checked' : ''} />
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${o.color};"></span>${esc(o.name)}
          </label>`).join('')}
      </div>
    </div>`;
}

// La organización principal no puede aparecer también como "participante".
function refreshInvolvedOrgOptions(idPrefix, primaryOrgId) {
  document.querySelectorAll(`#${idPrefix}-involved-orgs [data-org-id]`).forEach((row) => {
    const isPrimary = Number(row.dataset.orgId) === Number(primaryOrgId);
    row.style.display = isPrimary ? 'none' : '';
    if (isPrimary) row.querySelector('input').checked = false;
  });
}

function computeInvolvedOrgIds(fd) {
  return fd.getAll('involvedOrganizationIds').map(Number).filter((n) => Number.isFinite(n));
}

// ---------------- Actividad de todo el Barrio ----------------
// Atajo para no tener que marcar organización por organización: incluye
// automáticamente a todas. No afecta la alerta de choque (ver
// orgSetForConflictCheck) porque así una actividad de otra organización que
// se agende encima sigue mostrando la advertencia — que es justo el caso que
// se quiere evitar.
function wardActivityFieldHtml(idPrefix, checked) {
  return `
    <div class="field">
      <label style="display:flex; align-items:center; gap:7px; font-weight:600; cursor:pointer;">
        <input type="checkbox" id="${idPrefix}-ward-activity" ${checked ? 'checked' : ''} />
        🏘️ Actividad de todo el Barrio
      </label>
      <div class="hint-box" style="margin-top:4px;">Incluye automáticamente a todas las organizaciones, sin tener que marcarlas una por una.</div>
    </div>`;
}

function wireWardActivityField(idPrefix, involvedOrgsFieldSelector, onChange) {
  const checkbox = document.getElementById(`${idPrefix}-ward-activity`);
  const involvedField = document.querySelector(involvedOrgsFieldSelector);
  const applyState = () => {
    involvedField.style.display = checkbox.checked ? 'none' : '';
    if (checkbox.checked) {
      involvedField.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
    }
  };
  applyState();
  checkbox.addEventListener('change', () => { applyState(); if (onChange) onChange(); });
}

function involvedOrgsBadgesHtml(item) {
  if (item.isWardActivity) return ` · 🏘️ Actividad de todo el Barrio`;
  const involved = item.involvedOrganizations || [];
  if (!involved.length) return '';
  return ` · 🤝 ${involved.map((o) => `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${o.color};margin-right:2px;"></span>${esc(o.name)}`).join(', ')}`;
}

// Prefijo visual para distinguir una Reunión (privada) de una Actividad
// (pública) en cualquier listado.
function eventTitlePrefix(item) {
  return item.isMeeting ? '🔒 ' : '';
}

// Como eventTitlePrefix, pero también sabe mostrar el prefijo de una
// actividad de Estaca (sincronizada, sin dueño en el barrio).
function stakeAwarePrefix(item) {
  if (item.kind === 'stake') return '';
  return eventTitlePrefix(item);
}

// ---------------- Tipo de actividad: Actividad vs. Reunión ----------------
// Una "Reunión" (ej. Reunión de presidencia de Cuórum) es privada: solo la
// ven los líderes (y el administrador) de las organizaciones incluidas —
// nunca los Miembros ni los líderes de otras organizaciones. El servidor es
// quien filtra esto (ver canSeeMeeting en events.js); acá solo se elige el
// tipo al crear/editar.
function eventTypeFieldHtml(idPrefix, isMeeting) {
  return `
    <div class="field">
      <label>Tipo</label>
      <select id="${idPrefix}-type-select">
        <option value="activity" ${!isMeeting ? 'selected' : ''}>Actividad (la ve todo el barrio)</option>
        <option value="meeting" ${isMeeting ? 'selected' : ''}>🔒 Reunión (solo la ven los líderes de la organización)</option>
      </select>
    </div>`;
}

// ---------------- Repetición: semanal o fechas específicas ----------------
// Al crear (no al editar) se puede generar de una vez varias ocurrencias:
// todas las semanas hasta una fecha, o un listado de fechas puntuales
// elegidas a mano (ej. viernes de esta semana, jueves de la próxima, sábado
// en 3 semanas). Cada ocurrencia queda como una actividad independiente.
function recurrenceFieldHtml(idPrefix) {
  return `
    <div class="field">
      <label>Repetición</label>
      <select id="${idPrefix}-recurrence-select">
        <option value="none" selected>No se repite</option>
        <option value="weekly">Semanal (mismo día todas las semanas)</option>
        <option value="custom">Fechas específicas</option>
      </select>
    </div>
    <div class="field" id="${idPrefix}-recurrence-weekly-field" style="display:none;">
      <label>Repetir cada semana hasta</label>
      <input type="date" id="${idPrefix}-recurrence-until" />
    </div>
    <div class="field" id="${idPrefix}-recurrence-custom-field" style="display:none;">
      <label>Fechas adicionales (además del "Día" de más abajo)</label>
      <div id="${idPrefix}-recurrence-dates"></div>
      <button type="button" class="btn btn-secondary btn-sm" id="${idPrefix}-recurrence-add-date">+ Agregar fecha</button>
    </div>
    <div class="hint-box" id="${idPrefix}-recurrence-hint" style="display:none;">Se crea una actividad independiente por cada fecha — después puedes editar o eliminar una fecha puntual sin afectar a las demás. El aviso de choque solo revisa la primera fecha (el campo "Día"); si hace falta, revisa las demás fechas a mano. Eso sí: si alguna fecha choca con una actividad de Estaca de las que requieren autorización, el servidor va a rechazar la repetición completa al guardar — a menos que el líder de Obispado la autorice igual.</div>`;
}

function wireRecurrenceField(idPrefix) {
  const select = document.getElementById(`${idPrefix}-recurrence-select`);
  const weeklyField = document.getElementById(`${idPrefix}-recurrence-weekly-field`);
  const customField = document.getElementById(`${idPrefix}-recurrence-custom-field`);
  const hint = document.getElementById(`${idPrefix}-recurrence-hint`);
  const datesContainer = document.getElementById(`${idPrefix}-recurrence-dates`);
  const addBtn = document.getElementById(`${idPrefix}-recurrence-add-date`);
  const applyState = () => {
    weeklyField.style.display = select.value === 'weekly' ? '' : 'none';
    customField.style.display = select.value === 'custom' ? '' : 'none';
    hint.style.display = select.value === 'none' ? 'none' : '';
  };
  applyState();
  select.addEventListener('change', applyState);
  addBtn.addEventListener('click', () => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:6px; align-items:center; margin-bottom:6px;';
    row.innerHTML = `<input type="date" class="${idPrefix}-extra-date" /> <button type="button" class="btn btn-ghost btn-sm">✕</button>`;
    row.querySelector('button').addEventListener('click', () => row.remove());
    datesContainer.appendChild(row);
  });
}

// Calcula la lista final de fechas a crear según el modo de repetición
// elegido. Devuelve siempre al menos [firstDate] (o [] si no hay fecha).
function computeRecurrenceDates(idPrefix, firstDate) {
  const mode = document.getElementById(`${idPrefix}-recurrence-select`).value;
  if (mode === 'weekly') {
    const until = document.getElementById(`${idPrefix}-recurrence-until`).value;
    if (!firstDate || !until) return [firstDate].filter(Boolean);
    const dates = [];
    const cur = new Date(`${firstDate}T00:00:00`);
    const end = new Date(`${until}T00:00:00`);
    while (cur <= end) {
      dates.push(toISODate(cur));
      cur.setDate(cur.getDate() + 7);
    }
    return dates.length ? dates : [firstDate];
  }
  if (mode === 'custom') {
    const extra = Array.from(document.querySelectorAll(`.${idPrefix}-extra-date`)).map((el) => el.value).filter(Boolean);
    return [firstDate, ...extra].filter(Boolean);
  }
  return [firstDate].filter(Boolean);
}

// ---------------- Choques de horario/lugar con otras organizaciones ----------------
function toMinutes(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}
function timesOverlap(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !bStart) return false;
  const as = toMinutes(aStart), bs = toMinutes(bStart);
  const aeRaw = aEnd ? toMinutes(aEnd) : as;
  const beRaw = bEnd ? toMinutes(bEnd) : bs;
  // sin hora de término se trata como un bloque mínimo de 1 minuto, así dos
  // actividades con exactamente la misma hora de inicio siempre chocan.
  const ae = aeRaw > as ? aeRaw : as + 1;
  const be = beRaw > bs ? beRaw : bs + 1;
  return as < be && bs < ae;
}
function normalizeLocation(loc) { return String(loc || '').trim().toLowerCase(); }

// Organización "dueña" + organizaciones participantes de una actividad
// (o de lo que se está por agendar), para saber si dos actividades ya
// están coordinadas entre sí (comparten alguna organización) o no.
function orgSetForConflictCheck(item) {
  const ids = [Number(item.organizationId)];
  if (Array.isArray(item.involvedOrganizationIds)) ids.push(...item.involvedOrganizationIds.map(Number));
  if (Array.isArray(item.involvedOrganizations)) ids.push(...item.involvedOrganizations.map((o) => Number(o.id)));
  return ids;
}

// Revisa si lo que se está por agendar (actividad o entrevista) choca con
// una ACTIVIDAD de OTRA organización el mismo día (mismo horario, o
// exactamente el mismo lugar aunque el horario sea distinto — aviso general
// del barrio), y por separado si choca con una SALA ya ocupada por una
// ENTREVISTA de otra organización (ver GET /api/interviews/room-occupancy —
// a propósito solo trae lugar/sala/horario/organización, nunca a quién
// entrevistan ni quién entrevista, para no exponer información privada de
// otra organización; el aviso solo dice "ocupada por una entrevista de
// [organización]"). El choque contra entrevistas es más estricto que contra
// actividades: requiere que se solapen el horario Y la sala — a propósito,
// para no generar un aviso por cada entrevista del día que no tiene nada
// que ver con la sala que se está por usar (evitar fatiga de avisos). Si
// ambas comparten alguna organización (como dueña o como participante), no
// se considera choque — ya están coordinadas a propósito. excludeEventId/
// excludeInterviewId sirven para que, al editar una actividad o entrevista
// ya existente, no choque consigo misma.
async function findConflictingActivities(candidate, excludeEventId, excludeInterviewId) {
  if (!candidate.date || !candidate.startTime || !candidate.organizationId) return [];
  let dayEvents = [];
  let dayInterviewRooms = [];
  try { dayEvents = await api(`/events?from=${candidate.date}&to=${candidate.date}`); } catch (e) { /* si falla, sigue con lo que sí cargó */ }
  try { dayInterviewRooms = await api(`/interviews/room-occupancy?date=${candidate.date}`); } catch (e) { /* si falla, sigue con lo que sí cargó */ }
  const candidateOrgs = orgSetForConflictCheck(candidate);
  const eventConflicts = dayEvents.filter((ev) => {
    if (excludeEventId && ev.id === Number(excludeEventId)) return false;
    const evOrgs = orgSetForConflictCheck(ev);
    if (candidateOrgs.some((id) => evOrgs.includes(id))) return false;
    const timeConflict = timesOverlap(candidate.startTime, candidate.endTime, ev.startTime, ev.endTime);
    const placeConflict = placesConflict(candidate.location, candidate.sala, ev.location, ev.sala);
    return timeConflict || placeConflict;
  });
  const interviewConflicts = dayInterviewRooms
    .filter((iv) => {
      if (excludeInterviewId && iv.id === Number(excludeInterviewId)) return false;
      const ivOrgs = orgSetForConflictCheck(iv);
      if (candidateOrgs.some((id) => ivOrgs.includes(id))) return false;
      const timeConflict = timesOverlap(candidate.startTime, candidate.endTime, iv.startTime, iv.endTime);
      const placeConflict = placesConflict(candidate.location, candidate.sala, iv.location, iv.sala);
      return timeConflict && placeConflict;
    })
    .map((iv) => ({ ...iv, kind: 'interview' }));
  return [...eventConflicts, ...interviewConflicts];
}

function conflictWarningHtml(conflicts) {
  return `<div class="hint-box" style="border-color:#f59e0b; background:#fffbeb;">
    ⚠️ <strong>Posible choque con otra organización</strong> — vuelve a presionar el botón para agendar de todas formas:
    <ul style="margin:6px 0 0; padding-left:18px;">
      ${conflicts.map((c) => `<li><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c.organizationColor};margin-right:4px;"></span><strong>${esc(c.organizationName)}</strong> — ${c.kind === 'interview' ? '🔒 ocupada por una entrevista (privada)' : esc(c.title || c.memberName || '')} · ${esc(fmtTime(c.startTime))}${c.endTime ? ' - ' + esc(fmtTime(c.endTime)) : ''}${c.location ? ' · 📍 ' + esc(locationDisplay(c)) : ''}</li>`).join('')}
    </ul>
  </div>`;
}

// ---------------- Choques con actividades de Estaca (prioridad) ----------------
// No TODAS las actividades de Estaca bloquean — las puramente informativas
// (entrevistas, reuniones internas de Estaca, etc.) no cuentan como choque;
// el servidor decide cuáles sí (ver stakeCalendar.js → isBlockingStakeEvent)
// así que se le pregunta directo en vez de duplicar esa lógica acá. Devuelve
// { conflicts, canOverride } — canOverride es true si quien pregunta es el
// líder de Obispado (o Administrador), el único que puede autorizarlo igual.
// El servidor vuelve a revisar esto de todas formas al guardar (incluso para
// cada fecha de una repetición) — esta consulta es solo para avisar de
// inmediato en el caso más común (una sola fecha) sin esperar el error del
// servidor.
async function checkStakeConflicts(candidate) {
  if (!candidate.date) return { conflicts: [], canOverride: false };
  try { return await api('/stake-conflicts', { method: 'POST', body: { date: candidate.date, startTime: candidate.startTime, endTime: candidate.endTime } }); }
  catch (e) { return { conflicts: [], canOverride: false }; }
}

function stakeConflictWarningHtml(conflicts, canOverride) {
  const list = `<ul style="margin:6px 0 0; padding-left:18px;">
      ${conflicts.map((c) => `<li><strong>${esc(c.title)}</strong> · ${c.allDay ? 'Todo el día' : esc(fmtTime(c.startTime)) + (c.endTime ? ' - ' + esc(fmtTime(c.endTime)) : '')}</li>`).join('')}
    </ul>`;
  if (canOverride) {
    return `<div class="hint-box" style="border-color:#f59e0b; background:#fffbeb;">
      🏛️ <strong>Choca con ${conflicts.length > 1 ? 'actividades de Estaca' : 'una actividad de Estaca'}</strong> (tienen prioridad) — como líder de Obispado puedes autorizarlo igual: vuelve a presionar el botón para agendarlo de todas formas.
      ${list}
    </div>`;
  }
  return `<div class="hint-box" style="border-color:#b91c1c; background:#fef2f2; color:#7f1d1d;">
    🏛️ <strong>No se puede agendar sin autorización — choca con ${conflicts.length > 1 ? 'actividades de Estaca' : 'una actividad de Estaca'}</strong> (tienen prioridad sobre las de organizaciones y del Barrio):
    ${list}
    Elige otro horario o fecha, o pide autorización al líder de Obispado.
  </div>`;
}

// ---------------- Auth ----------------
function setToken(token) {
  state.token = token;
  if (token) localStorage.setItem('cow_token', token);
  else localStorage.removeItem('cow_token');
}

async function boot() {
  if (!state.token) { renderLogin(); return; }
  try {
    state.user = await api('/auth/me');
    state.organizations = await api('/organizations');
    await loadCalendarData();
    render();
    maybeShowAssignmentsAlert();
  } catch (e) {
    setToken(null);
    renderLogin();
  }
}

// ---------------- Alerta de compromisos pendientes (al iniciar sesión) ----------------
// Se muestra como mucho una vez por sesión de navegador (sessionStorage se
// borra al cerrar la pestaña) — así no interrumpe la navegación posterior
// aunque la persona siga entrando y saliendo de vistas durante el día.
async function maybeShowAssignmentsAlert() {
  if (sessionStorage.getItem('assignmentsAlertShown')) return;
  sessionStorage.setItem('assignmentsAlertShown', '1');
  if (!state.user || (state.user.role !== 'admin' && state.user.role !== 'leader')) return;
  try {
    const data = await api('/my-assignments');
    if (data.total > 0) showAssignmentsAlertModal(data.total);
  } catch (e) { /* silencioso: no molestar con un error por esto */ }
}

function showAssignmentsAlertModal(count) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="assign-alert-backdrop">
      <div class="modal" style="max-width:380px; text-align:center;">
        <div class="modal-body" style="padding-top:28px;">
          <div style="font-size:38px; margin-bottom:8px;">🔔</div>
          <p style="font-size:15px; font-weight:700; color:var(--ink); margin:0 0 6px;">Tienes ${count} compromiso${count === 1 ? '' : 's'} pendiente${count === 1 ? '' : 's'}, favor revisar</p>
          <p style="font-size:13px; color:var(--ink-soft); margin:0 0 20px;">Pestaña Reuniones → Mis Asignaciones</p>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary btn-block" id="assign-alert-later">Más tarde</button>
            <button class="btn btn-primary btn-block" id="assign-alert-view">Ver ahora</button>
          </div>
        </div>
      </div>
    </div>`;
  document.getElementById('assign-alert-later').addEventListener('click', closeModal);
  document.getElementById('assign-alert-backdrop').addEventListener('click', (e) => { if (e.target.id === 'assign-alert-backdrop') closeModal(); });
  document.getElementById('assign-alert-view').addEventListener('click', () => {
    closeModal();
    state.view = 'meetings';
    state.meetingsSubtab = 'mine';
    render();
  });
}

async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch (e) {}
  setToken(null);
  state.user = null;
  renderLogin();
}

// ---------------- Login ----------------
function renderLogin() {
  root.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-logo">📅</div>
        <h1>${esc(APP_NAME)}</h1>
        <p class="subtitle">Actividades y entrevistas de todas las organizaciones en un solo lugar</p>
        <div id="login-error"></div>
        <form id="login-form">
          <div class="field">
            <label>Usuario</label>
            <input type="text" name="email" required autocomplete="username" placeholder="ej: primaria.presidenta" />
          </div>
          <div class="field">
            <label>Contraseña</label>
            <input type="password" name="password" required autocomplete="current-password" placeholder="••••••••" />
          </div>
          <button class="btn btn-primary btn-block" type="submit">Ingresar</button>
        </form>
        <div class="hint-box">
          ¿No tienes cuenta? <a href="#" id="go-register">Solicita una aquí</a> — un administrador la debe aprobar antes de que puedas ingresar.
        </div>
      </div>
    </div>
  `;
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = e.target.querySelector('button');
    btn.disabled = true; btn.textContent = 'Ingresando…';
    try {
      const { token } = await api('/auth/login', { method: 'POST', body: { email: fd.get('email'), password: fd.get('password') } });
      setToken(token);
      await boot();
    } catch (err) {
      document.getElementById('login-error').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = 'Ingresar';
    }
  });
  document.getElementById('go-register').addEventListener('click', (e) => { e.preventDefault(); renderRegister(); });
}

// ---------------- Solicitar cuenta (autorregistro) ----------------
async function renderRegister() {
  const root2 = root;
  root2.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-logo">📅</div>
        <h1>${esc(APP_NAME)}</h1>
        <p class="subtitle">Solicita tu cuenta — un administrador la revisa y aprueba</p>
        <div id="reg-error"></div>
        <div id="reg-success" style="display:none;"></div>
        <form id="reg-form">
          <div class="field">
            <label>Nombre completo</label>
            <input type="text" name="name" required placeholder="Tu nombre y apellido" />
          </div>
          <div class="field">
            <label>Usuario</label>
            <input type="text" name="email" required autocomplete="username" placeholder="ej: juan.perez (no necesita ser un correo)" />
          </div>
          <div class="two-col">
            <div class="field">
              <label>Contraseña</label>
              <input type="password" name="password" required minlength="6" autocomplete="new-password" placeholder="mínimo 6 caracteres" />
            </div>
            <div class="field">
              <label>Repetir contraseña</label>
              <input type="password" name="password2" required minlength="6" autocomplete="new-password" placeholder="••••••••" />
            </div>
          </div>
          <div class="field">
            <label>¿Cuál es tu perfil?</label>
            <select name="requestedRole" id="reg-role">
              <option value="member">Miembro (solo consulta el calendario)</option>
              <option value="leader">Líder de una organización (edita actividades/entrevistas)</option>
            </select>
          </div>
          <div class="field" id="reg-org-field" style="display:none;">
            <label>¿De qué organización?</label>
            <select name="requestedOrganizationId" id="reg-org"></select>
          </div>
          <div class="hint-box" style="margin-top:0;">El administrador puede corregir tu perfil si lo eliges mal — no pasa nada si no estás 100% seguro.</div>
          <button class="btn btn-primary btn-block" type="submit">Enviar solicitud</button>
        </form>
        <div class="hint-box">
          ¿Ya tienes cuenta? <a href="#" id="go-login">Vuelve a ingresar</a>
        </div>
      </div>
    </div>
  `;
  document.getElementById('go-login').addEventListener('click', (e) => { e.preventDefault(); renderLogin(); });

  try {
    const orgs = await api('/public/organizations');
    const orgSelect = document.getElementById('reg-org');
    orgSelect.innerHTML = orgs.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
  } catch (e) { /* si falla, el selector queda vacío; el backend igual valida */ }

  document.getElementById('reg-role').addEventListener('change', (e) => {
    document.getElementById('reg-org-field').style.display = e.target.value === 'leader' ? '' : 'none';
  });

  document.getElementById('reg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errBox = document.getElementById('reg-error');
    errBox.innerHTML = '';
    if (fd.get('password') !== fd.get('password2')) {
      errBox.innerHTML = `<div class="error-msg">Las contraseñas no coinciden</div>`;
      return;
    }
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const body = {
        name: fd.get('name'),
        email: fd.get('email'),
        password: fd.get('password'),
        requestedRole: fd.get('requestedRole'),
        requestedOrganizationId: fd.get('requestedRole') === 'leader' ? fd.get('requestedOrganizationId') : null,
      };
      const res = await api('/auth/register', { method: 'POST', body });
      e.target.style.display = 'none';
      const successBox = document.getElementById('reg-success');
      successBox.style.display = '';
      successBox.innerHTML = `<div class="hint-box" style="border-color:var(--celeste);">✅ ${esc(res.message)}</div>`;
    } catch (err) {
      errBox.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = 'Enviar solicitud';
    }
  });
}

// ---------------- Shell / navegación ----------------
function orgById(id) { return state.organizations.find((o) => o.id === Number(id)); }

function canEditEventsFor(orgId) {
  if (!state.user) return false;
  if (state.user.role === 'admin') return true;
  if (state.user.role === 'leader' && state.user.organizationId === Number(orgId)) return true;
  return false;
}
function canManageAnyEvents() {
  return state.user.role === 'admin' || state.user.role === 'leader';
}
function canScheduleInterviewsFor(orgId) {
  if (!state.user) return false;
  if (state.user.role === 'admin') return true;
  if (state.user.role === 'leader' && state.user.organizationId === Number(orgId)) return true;
  return false;
}
function canManageAnyInterviews() {
  return state.user.role === 'admin' || state.user.role === 'leader';
}
// El módulo de Entrevistas es solo para el Administrador y los líderes de
// las organizaciones que sí agendan entrevistas (Obispado, Cuórum de
// Élderes y Sociedad de Socorro — ver allowsInterviews). Un líder de otra
// organización (ej. Primaria) no ve esta pestaña en absoluto: si a él lo
// entrevistan, esa entrevista le aparece igual en "Mis Actividades" (ver
// canSeeMyActivitiesTab), no hace falta el módulo completo para eso.
function canSeeInterviewsTab() {
  if (!state.user) return false;
  if (state.user.role === 'admin') return true;
  return state.user.role === 'leader' && !!(state.user.organization && state.user.organization.allowsInterviews);
}
function canSeeMyActivitiesTab() {
  return !!state.user && (state.user.role === 'leader' || state.user.role === 'member');
}
// El módulo de Presupuesto es para Líderes y Administrador — los Miembros
// no lo ven en absoluto.
function canSeeBudgetTab() {
  return !!state.user && state.user.role !== 'member';
}
function isObispadoUser() {
  return !!state.user && (state.user.role === 'admin' || !!(state.user.organization && state.user.organization.name === 'Obispado'));
}
// "Panel de Obispado": mismo criterio que Aseo del Edificio — solo
// Administrador o líder de Obispado, porque junta datos de TODAS las
// organizaciones (compromisos, aseo, entrevistas, presupuesto).
function canSeeBishopricPanelTab() {
  return isObispadoUser();
}
// "Reuniones y Asignaciones" y "Estadísticas": visibles para Líder y
// Administrador — los Miembros no las ven en absoluto.
function canSeeMeetingsTab() {
  return !!state.user && (state.user.role === 'admin' || state.user.role === 'leader');
}
function canSeeStatsTab() {
  return !!state.user && (state.user.role === 'admin' || state.user.role === 'leader');
}
// "Aseo del Edificio": estrictamente oculto salvo Administrador o líder de
// Obispado (reutiliza isObispadoUser, la misma regla que Estaca/Presupuesto).
function canSeeCleaningTab() {
  return isObispadoUser();
}
// Las entrevistas son privadas: cada líder solo ve las de su propia
// organización, salvo el líder de Obispado, que ve las de todas.
function canViewAllInterviews() {
  if (!state.user) return false;
  if (state.user.role === 'admin') return true;
  return !!(state.user.organization && state.user.organization.name === 'Obispado');
}

function initials(name) {
  return name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

function render() {
  if (!state.user) { renderLogin(); return; }
  const u = state.user;
  if (u.role === 'member' && state.view === 'interviews') state.view = 'calendar';
  root.innerHTML = `
    <div class="topbar">
      <div class="topbar-left">
        <div class="topbar-logo">📅</div>
        <div class="topbar-title">${esc(APP_NAME)}<small>${esc(u.organization ? u.organization.name : 'Vista general')}</small></div>
      </div>
      <div class="topbar-right">
        <div class="user-chip">
          <div class="user-avatar">${esc(initials(u.name))}</div>
          <div>
            <div style="font-weight:600;">${esc(u.name)}</div>
            <span class="role-badge role-${u.role}">${ROLE_LABELS[u.role]}</span>
          </div>
        </div>
        <button class="btn btn-ghost btn-sm" id="logout-btn">Salir</button>
      </div>
    </div>
    <div class="tabs">
      <button class="tab-btn ${state.view === 'calendar' ? 'active' : ''}" data-view="calendar">Calendario</button>
      ${canSeeBishopricPanelTab() ? `<button class="tab-btn ${state.view === 'bishopricPanel' ? 'active' : ''}" data-view="bishopricPanel">Panel de Obispado</button>` : ''}
      ${canSeeMyActivitiesTab() ? `<button class="tab-btn ${state.view === 'myActivities' ? 'active' : ''}" data-view="myActivities">Mis Actividades</button>` : ''}
      ${canSeeInterviewsTab() ? `<button class="tab-btn ${state.view === 'interviews' ? 'active' : ''}" data-view="interviews">Entrevistas</button>` : ''}
      ${canSeeBudgetTab() ? `<button class="tab-btn ${state.view === 'budget' ? 'active' : ''}" data-view="budget">Presupuesto</button>` : ''}
      ${canSeeMeetingsTab() ? `<button class="tab-btn ${state.view === 'meetings' ? 'active' : ''}" data-view="meetings">Reuniones</button>` : ''}
      ${canSeeCleaningTab() ? `<button class="tab-btn ${state.view === 'cleaning' ? 'active' : ''}" data-view="cleaning">Aseo del Edificio</button>` : ''}
      ${canSeeStatsTab() ? `<button class="tab-btn ${state.view === 'stats' ? 'active' : ''}" data-view="stats">Estadísticas</button>` : ''}
      ${u.role === 'admin' ? `<button class="tab-btn ${state.view === 'admin' ? 'active' : ''}" data-view="admin">Administración</button>` : ''}
    </div>
    <main class="view" id="view-root"></main>
    <div id="modal-root"></div>
  `;
  document.getElementById('logout-btn').addEventListener('click', logout);
  root.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => { state.view = btn.dataset.view; renderCurrentView(); });
  });
  renderCurrentView();
}

function renderCurrentView() {
  if (state.view === 'interviews' && !canSeeInterviewsTab()) state.view = 'calendar';
  if (state.view === 'myActivities' && !canSeeMyActivitiesTab()) state.view = 'calendar';
  if (state.view === 'budget' && !canSeeBudgetTab()) state.view = 'calendar';
  if (state.view === 'meetings' && !canSeeMeetingsTab()) state.view = 'calendar';
  if (state.view === 'cleaning' && !canSeeCleaningTab()) state.view = 'calendar';
  if (state.view === 'stats' && !canSeeStatsTab()) state.view = 'calendar';
  if (state.view === 'bishopricPanel' && !canSeeBishopricPanelTab()) state.view = 'calendar';
  root.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  if (state.view === 'calendar') renderCalendarView();
  else if (state.view === 'bishopricPanel') renderBishopricPanelView();
  else if (state.view === 'myActivities') renderMyActivitiesView();
  else if (state.view === 'interviews') renderInterviewsView();
  else if (state.view === 'budget') renderBudgetView();
  else if (state.view === 'meetings') renderMeetingsView();
  else if (state.view === 'cleaning') renderCleaningView();
  else if (state.view === 'stats') renderStatsView();
  else if (state.view === 'admin') renderAdminView();
}

// ---------------- Calendario ----------------
async function loadCalendarData() {
  const gridStart = gridStartDate(state.calMonth);
  const gridEnd = new Date(gridStart); gridEnd.setDate(gridEnd.getDate() + 41);
  const from = toISODate(gridStart), to = toISODate(gridEnd);
  const [events, interviews, stakeEvents] = await Promise.all([
    api(`/events?from=${from}&to=${to}`),
    api(`/interviews?from=${from}&to=${to}`),
    api(`/stake-events?from=${from}&to=${to}`).catch(() => []),
  ]);
  state.events = events;
  state.interviews = interviews;
  state.stakeEvents = stakeEvents;
}

function gridStartDate(monthDate) {
  const first = new Date(monthDate);
  const dow = (first.getDay() + 6) % 7; // lunes = 0
  const start = new Date(first);
  start.setDate(first.getDate() - dow);
  return start;
}

function orgFilterActive(orgId) {
  return state.activeOrgIds === null || state.activeOrgIds.has(Number(orgId));
}

function toggleOrgFilter(orgId) {
  orgId = Number(orgId);
  if (state.activeOrgIds === null) {
    state.activeOrgIds = new Set(state.organizations.map((o) => o.id));
  }
  if (state.activeOrgIds.has(orgId)) state.activeOrgIds.delete(orgId);
  else state.activeOrgIds.add(orgId);
  if (state.activeOrgIds.size === state.organizations.length) state.activeOrgIds = null;
  renderCalendarView();
}

async function renderCalendarView() {
  const container = document.getElementById('view-root');
  const gridStart = gridStartDate(state.calMonth);
  const today = new Date();
  const yearNow = today.getFullYear();
  const yearOptions = [];
  for (let y = yearNow - 1; y <= yearNow + 4; y++) yearOptions.push(y);

  const chips = state.organizations.map((o) => `
    <button class="org-chip ${orgFilterActive(o.id) ? 'active' : ''}" style="color:${orgFilterActive(o.id) ? o.color : '#94a3b8'}" data-org="${o.id}">
      <span class="org-dot" style="background:${o.color}"></span>${esc(o.name)}
    </button>`).join('');

  let cellsHtml = '';
  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart); cellDate.setDate(gridStart.getDate() + i);
    const iso = toISODate(cellDate);
    const otherMonth = cellDate.getMonth() !== state.calMonth.getMonth();
    const isToday = isSameDay(cellDate, today);
    const dayEvents = state.events.filter((e) => e.date === iso && orgFilterActive(e.organizationId));
    const dayInterviews = state.interviews.filter((iv) => iv.date === iso && orgFilterActive(iv.organizationId));
    // Las actividades de Estaca no pertenecen a ninguna organización del
    // barrio, así que se muestran siempre — no las esconden los filtros de
    // organización de arriba.
    const dayStake = state.stakeEvents.filter((s) => s.date === iso);
    const items = [
      ...dayEvents.map((e) => ({ ...e, kind: 'event' })),
      ...dayInterviews.map((iv) => ({ ...iv, kind: 'interview', title: iv.memberName })),
      ...dayStake.map((s) => ({ ...s, kind: 'stake' })),
    ].sort((a, b) => (a.startTime || '00:00').localeCompare(b.startTime || '00:00'));

    const MAX_SHOW = 3;
    const visible = items.slice(0, MAX_SHOW);
    const extra = items.length - visible.length;

    cellsHtml += `
      <div class="cal-cell ${otherMonth ? 'other-month' : ''} ${isToday ? 'today' : ''}" data-date="${iso}">
        <div class="cal-daynum">${cellDate.getDate()}</div>
        ${visible.map((it) => `
          <button class="cal-event ${it.kind === 'interview' ? 'is-interview' : ''} ${it.kind === 'stake' ? (it.blocking === false ? 'is-stake is-stake-info' : 'is-stake') : ''}" style="background:${it.organizationColor}" data-kind="${it.kind}" data-id="${it.id}" title="${esc(it.kind === 'stake' && it.allDay ? 'Todo el día' : fmtTime(it.startTime))} ${esc(stakeAwarePrefix(it) + it.title)}${it.location ? ' — ' + esc(locationDisplay(it)) : ''}">
            ${it.kind === 'stake' ? '🏛️ ' : ''}${esc(it.kind === 'stake' && it.allDay ? 'Todo el día' : fmtTime(it.startTime))} ${it.kind === 'interview' ? '👤' : ''} ${esc(stakeAwarePrefix(it))}${esc(truncateTitle(it.title))}
          </button>`).join('')}
        ${extra > 0 ? `<button class="cal-more" data-more="${iso}">+${extra} más</button>` : ''}
      </div>`;
  }

  container.innerHTML = `
    <div class="cal-header">
      <div class="cal-nav">
        <button class="icon-btn" id="cal-prev">‹</button>
        <select class="cal-select" id="cal-month-select">
          ${MONTH_LABELS.map((m, i) => `<option value="${i}" ${i === state.calMonth.getMonth() ? 'selected' : ''}>${m.charAt(0).toUpperCase() + m.slice(1)}</option>`).join('')}
        </select>
        <select class="cal-select" id="cal-year-select">
          ${yearOptions.map((y) => `<option value="${y}" ${y === state.calMonth.getFullYear() ? 'selected' : ''}>${y}</option>`).join('')}
        </select>
        <button class="icon-btn" id="cal-next">›</button>
        <button class="btn btn-secondary btn-sm" id="cal-today">Hoy</button>
      </div>
      <div class="cal-goto">
        <label for="cal-goto-input" class="cal-goto-label">Ir a fecha:</label>
        <input type="date" id="cal-goto-input" />
      </div>
      ${canManageAnyEvents() ? `<button class="btn btn-primary" id="cal-new-event">+ Nueva actividad</button>` : ''}
    </div>
    ${await stakeStatusBarHtml()}
    <div class="org-filters">${chips}</div>
    <div class="cal-grid-wrap">
      <div class="cal-grid">
        ${DOW_LABELS.map((d) => `<div class="cal-dow">${d}</div>`).join('')}
        ${cellsHtml}
      </div>
    </div>
  `;

  document.getElementById('cal-prev').addEventListener('click', () => shiftMonth(-1));
  document.getElementById('cal-next').addEventListener('click', () => shiftMonth(1));
  document.getElementById('cal-today').addEventListener('click', () => { state.calMonth = startOfMonth(new Date()); shiftMonth(0, true); });
  document.getElementById('cal-month-select').addEventListener('change', (e) => {
    state.calMonth = new Date(state.calMonth.getFullYear(), Number(e.target.value), 1);
    shiftMonth(0, true);
  });
  document.getElementById('cal-year-select').addEventListener('change', (e) => {
    state.calMonth = new Date(Number(e.target.value), state.calMonth.getMonth(), 1);
    shiftMonth(0, true);
  });
  document.getElementById('cal-goto-input').addEventListener('change', async (e) => {
    const val = e.target.value;
    if (!val) return;
    const [y, m] = val.split('-').map(Number);
    state.calMonth = new Date(y, m - 1, 1);
    await shiftMonth(0, true);
    openDayModal(val);
  });
  const newBtn = document.getElementById('cal-new-event');
  if (newBtn) newBtn.addEventListener('click', () => openEventModal());
  container.querySelectorAll('.org-chip').forEach((c) => c.addEventListener('click', () => toggleOrgFilter(c.dataset.org)));
  container.querySelectorAll('.cal-event').forEach((btn) => btn.addEventListener('click', () => {
    if (btn.dataset.kind === 'event') {
      openItemModal(state.events.find((e) => e.id === Number(btn.dataset.id)), 'event');
    } else if (btn.dataset.kind === 'interview') {
      openItemModal(state.interviews.find((i) => i.id === Number(btn.dataset.id)), 'interview');
    } else {
      // Las actividades de Estaca son de solo lectura para todos — nunca se
      // pueden editar ni eliminar desde acá, vienen sincronizadas.
      openReadOnlyModal(state.stakeEvents.find((s) => s.id === Number(btn.dataset.id)), 'stake');
    }
  }));
  container.querySelectorAll('[data-more]').forEach((btn) => btn.addEventListener('click', () => openDayModal(btn.dataset.more)));

  wireStakeStatusBar();
}

// ---------------- Barra de estado del calendario de Estaca ----------------
// Visible para Administrador y líder de Obispado: muestra cuándo se
// sincronizó por última vez y permite forzar una sincronización manual.
// Se llama a sí misma al renderizar el calendario porque el estado puede
// cambiar seguido (la sincronización automática corre cada 4 horas) y es
// información liviana de pedir.
async function stakeStatusBarHtml() {
  if (!isObispadoUser()) return '';
  if (!state.stakeCalendar) {
    try { state.stakeCalendar = await api('/stake-calendar'); } catch (e) { return ''; }
  }
  const sc = state.stakeCalendar;
  if (!sc || !sc.url) return '';
  let statusText;
  if (sc.lastSyncOk === true) {
    statusText = `✅ Sincronizado ${sc.lastSyncedAt ? fmtRelativeTime(sc.lastSyncedAt) : ''} · ${sc.eventCount} actividad${sc.eventCount === 1 ? '' : 'es'}`;
  } else if (sc.lastSyncOk === false) {
    statusText = `⚠️ No se pudo sincronizar (${esc(sc.lastSyncError || 'error desconocido')}) · usando la última copia guardada (${sc.eventCount})`;
  } else {
    statusText = 'Sin sincronizar todavía';
  }
  return `
    <div class="stake-status-bar">
      <span>🏛️ <strong>Calendario de ${esc(sc.displayName || 'Estaca')}</strong> — ${statusText}</span>
      <button type="button" class="btn btn-ghost btn-sm" id="stake-sync-now">Sincronizar ahora</button>
    </div>`;
}

function wireStakeStatusBar() {
  const btn = document.getElementById('stake-sync-now');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Sincronizando…';
    try {
      state.stakeCalendar = await api('/stake-calendar/sync', { method: 'POST' });
      toast(state.stakeCalendar.lastSyncOk ? 'Calendario de Estaca sincronizado' : 'No se pudo sincronizar: ' + state.stakeCalendar.lastSyncError, state.stakeCalendar.lastSyncOk ? 'success' : 'error');
      await loadCalendarData();
      renderCalendarView();
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Sincronizar ahora';
    }
  });
}

function fmtRelativeTime(iso) {
  const then = new Date(iso).getTime();
  const diffMin = Math.round((Date.now() - then) / 60000);
  if (diffMin < 1) return 'recién';
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `hace ${diffH} h`;
  const diffD = Math.round(diffH / 24);
  return `hace ${diffD} día${diffD === 1 ? '' : 's'}`;
}

async function shiftMonth(delta, forceReplace = false) {
  if (!forceReplace) state.calMonth = addMonths(state.calMonth, delta);
  await loadCalendarData();
  renderCalendarView();
}

function openDayModal(iso) {
  const items = [
    ...state.events.filter((e) => e.date === iso).map((e) => ({ ...e, kind: 'event' })),
    ...state.interviews.filter((iv) => iv.date === iso).map((iv) => ({ ...iv, kind: 'interview', title: iv.memberName })),
    ...state.stakeEvents.filter((s) => s.date === iso).map((s) => ({ ...s, kind: 'stake' })),
  ].sort((a, b) => (a.startTime || '00:00').localeCompare(b.startTime || '00:00'));
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="day-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>${esc(fmtDateHuman(iso))}</h3><button class="modal-close" id="day-modal-close">×</button></div>
        <div class="modal-body">
          <div class="card-list">
            ${items.length ? items.map((it) => `
              <div class="list-card" data-kind="${it.kind}" data-id="${it.id}" style="cursor:pointer;">
                <span class="org-dot" style="background:${it.organizationColor}"></span>
                <div class="lc-main">
                  <div class="lc-title">${it.kind === 'interview' ? '👤 ' : it.kind === 'stake' ? '🏛️ ' : eventTitlePrefix(it)}${esc(it.title)}</div>
                  <div class="lc-sub">${esc(it.organizationName)}${it.location ? ` · <span class="lc-location">📍 ${esc(locationDisplay(it))}</span>` : ''}${it.kind === 'interview' && it.interviewerName ? ` · 🧑‍💼 ${esc(it.interviewerName)}` : ''}${it.kind === 'event' ? involvedOrgsBadgesHtml(it) : ''}</div>
                </div>
                <div class="lc-when">${it.kind === 'stake' && it.allDay ? 'Todo el día' : esc(fmtTime(it.startTime))}${it.endTime ? ' - ' + esc(fmtTime(it.endTime)) : ''}</div>
              </div>`).join('') : '<div class="empty-state">Sin actividades este día</div>'}
          </div>
        </div>
      </div>
    </div>`;
  document.getElementById('day-modal-close').addEventListener('click', closeModal);
  document.getElementById('day-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'day-modal-backdrop') closeModal(); });
  modalRoot.querySelectorAll('.list-card').forEach((card) => card.addEventListener('click', () => {
    if (card.dataset.kind === 'event') openItemModal(state.events.find((e) => e.id === Number(card.dataset.id)), 'event');
    else if (card.dataset.kind === 'interview') openItemModal(state.interviews.find((i) => i.id === Number(card.dataset.id)), 'interview');
    else openReadOnlyModal(state.stakeEvents.find((s) => s.id === Number(card.dataset.id)), 'stake');
  }));
}

function closeModal() { document.getElementById('modal-root').innerHTML = ''; }

// ---------------- Exportar "Mis Actividades" a un calendario personal ----------------
// Genera (o reutiliza) un enlace .ics personal y privado con el mismo
// contenido que "Mis Actividades", para que cada persona lo agregue como
// "suscripción de calendario" en Google Calendar, Apple Calendar u Outlook y
// se mantenga sincronizado solo (no hace falta volver a exportar a mano).
async function openCalendarExportModal() {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="cal-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>📅 Exportar a mi calendario</h3><button class="modal-close" id="cal-modal-close">×</button></div>
        <div class="modal-body">
          <p style="margin-top:0;">Suscríbete con este enlace desde Google Calendar, Apple Calendar u Outlook y tus actividades de "Mis Actividades" van a aparecer ahí también, actualizándose solas (cada app revisa el enlace cada cierto tiempo, no es al instante).</p>
          <div id="cal-link-loading" class="hint-box">Generando tu enlace…</div>
          <div id="cal-link-wrap" style="display:none;">
            <div class="field">
              <label>Tu enlace personal</label>
              <input type="text" id="cal-link-input" readonly style="font-size:12.5px;" />
            </div>
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px;">
              <button type="button" class="btn btn-secondary btn-sm" id="cal-copy-btn">Copiar enlace</button>
              <a class="btn btn-secondary btn-sm" id="cal-download-btn" href="#">Descargar archivo .ics</a>
              <button type="button" class="btn btn-ghost btn-sm" id="cal-regen-btn">Generar un enlace nuevo</button>
            </div>
            <div class="hint-box">
              <strong>Google Calendar</strong> (desde un computador): "Otros calendarios" (el + de la izquierda) → "Desde URL" → pega el enlace.<br/>
              <strong>Apple Calendar</strong>: Archivo → "Nueva suscripción de calendario…" → pega el enlace.<br/>
              <strong>Outlook</strong>: "Agregar calendario" → "Suscribirse desde la web" → pega el enlace.<br/><br/>
              Este enlace es personal: cualquiera que lo tenga puede ver tus actividades y entrevistas, así que no lo compartas. Si crees que alguien más lo obtuvo, genera uno nuevo — el anterior deja de funcionar.
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <div></div>
          <div><button class="btn btn-secondary" id="cal-close">Cerrar</button></div>
        </div>
      </div>
    </div>`;
  document.getElementById('cal-modal-close').addEventListener('click', closeModal);
  document.getElementById('cal-close').addEventListener('click', closeModal);
  document.getElementById('cal-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'cal-modal-backdrop') closeModal(); });

  const renderLink = (token) => {
    const url = `${location.origin}${API}/calendar/feed.ics?token=${token}`;
    document.getElementById('cal-link-loading').style.display = 'none';
    document.getElementById('cal-link-wrap').style.display = '';
    document.getElementById('cal-link-input').value = url;
    document.getElementById('cal-download-btn').href = url;
    document.getElementById('cal-copy-btn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        toast('Enlace copiado');
      } catch (e) {
        const input = document.getElementById('cal-link-input');
        input.select();
        toast('No se pudo copiar automáticamente — selecciónalo y cópialo a mano', 'error');
      }
    });
    document.getElementById('cal-regen-btn').addEventListener('click', async () => {
      if (!confirm('¿Generar un enlace nuevo? El enlace anterior deja de funcionar — vas a tener que actualizarlo en tu calendario personal.')) return;
      try {
        const { token: newToken } = await api('/auth/me/calendar-token/regenerate', { method: 'POST' });
        renderLink(newToken);
        toast('Enlace regenerado');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  };

  try {
    const { token } = await api('/auth/me/calendar-token');
    renderLink(token);
  } catch (e) {
    document.getElementById('cal-link-loading').textContent = 'No se pudo generar el enlace: ' + e.message;
  }
}

// Abre el modal de edición si la persona tiene permiso sobre la organización
// del ítem; si no, abre una vista de solo lectura (sin botones de editar/eliminar).
function openItemModal(item, kind) {
  if (!item) return;
  const canEdit = kind === 'event' ? canEditEventsFor(item.organizationId) : canScheduleInterviewsFor(item.organizationId);
  if (canEdit) {
    if (kind === 'event') openEventModal(item); else openInterviewModal(item);
  } else {
    openReadOnlyModal(item, kind);
  }
}

function openReadOnlyModal(item, kind) {
  if (!item) return;
  const title = kind === 'interview' ? item.memberName : item.title;
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="ro-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>${kind === 'interview' ? '👤 ' : kind === 'stake' ? '🏛️ ' : eventTitlePrefix(item)}${esc(title)}</h3><button class="modal-close" id="ro-modal-close">×</button></div>
        <div class="modal-body">
          <div class="ro-detail-row"><span class="org-dot" style="background:${item.organizationColor}"></span><strong>${esc(item.organizationName)}</strong>${kind === 'event' ? involvedOrgsBadgesHtml(item) : ''}</div>
          <div class="ro-detail-row">📅 ${esc(fmtDateHuman(item.date))}</div>
          <div class="ro-detail-row">🕐 ${kind === 'stake' && item.allDay ? 'Todo el día' : esc(fmtTime(item.startTime))}${item.endTime ? ' - ' + esc(fmtTime(item.endTime)) : ''}</div>
          ${item.location ? `<div class="ro-detail-row">📍 ${esc(locationDisplay(item))}</div>` : ''}
          ${kind === 'interview' && item.interviewerName ? `<div class="ro-detail-row">🧑‍💼 ${esc(item.interviewerName)}</div>` : ''}
          ${kind === 'interview' && item.memberPhone ? `<div class="ro-detail-row">📞 ${esc(item.memberPhone)}</div>` : ''}
          ${kind === 'interview' && item.memberEmail ? `<div class="ro-detail-row">✉️ ${esc(item.memberEmail)}</div>` : ''}
          ${item.description ? `<div class="ro-detail-row ro-desc">${esc(item.description)}</div>` : ''}
          ${kind === 'stake' ? `<div class="hint-box" style="margin-top:10px;">🔗 Sincronizada automáticamente desde el calendario de Estaca — no se puede editar aquí. ${item.blocking === false ? 'Es informativa: no bloquea que se agende algo encima.' : 'Tiene prioridad: no se puede agendar algo encima sin autorización del líder de Obispado.'}</div>` : ''}
        </div>
        <div class="modal-footer" style="justify-content:flex-end;">
          <button class="btn btn-secondary" id="ro-modal-close2">Cerrar</button>
        </div>
      </div>
    </div>`;
  document.getElementById('ro-modal-close').addEventListener('click', closeModal);
  document.getElementById('ro-modal-close2').addEventListener('click', closeModal);
  document.getElementById('ro-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'ro-modal-backdrop') closeModal(); });
}

function editableOrgOptions(mode) {
  // mode: 'event' o 'interview' -> el líder de la organización o un admin (interview: solo orgs con allowsInterviews)
  if (state.user.role === 'admin') {
    return mode === 'interview' ? state.organizations.filter((o) => o.allowsInterviews) : state.organizations;
  }
  const own = orgById(state.user.organizationId);
  return own ? [own] : [];
}

async function refreshAfterEventChange() {
  if (state.view === 'myActivities') { await renderMyActivitiesView(); }
  else { await loadCalendarData(); if (state.view === 'calendar') renderCalendarView(); }
}

// ---------------- Mis Actividades ----------------
// Para Líderes: listado simple (sin navegar mes a mes) de las actividades de
// la propia organización, con acceso directo a agregar/editar.
// Para Miembros: listado de las actividades de las organizaciones que la
// persona elige seguir (por ejemplo, la propia más las de sus hijos), más
// las actividades de todo el Barrio, que siempre aparecen. Solo lectura.
async function renderMyActivitiesView() {
  if (state.user.role === 'leader') return renderMyActivitiesLeaderView();
  return renderMyActivitiesMemberView();
}

// Arma la línea de detalle (organización / ubicación / descripción) de cada
// tarjeta en la vista de Líder, uniendo solo las partes que corresponden con
// un único separador " · " entre ellas (evita separadores duplicados cuando
// se muestra el nombre de una organización seguida de la ubicación).
function myActLeaderSubHtml(it, myOrgId) {
  const parts = [];
  if (it.kind === 'interview') {
    parts.push(`Te entrevista ${esc(it.organizationName)}`);
    if (it.interviewerName) parts.push(esc(it.interviewerName));
  } else if (Number(it.organizationId) !== myOrgId) {
    parts.push(esc(it.organizationName));
  }
  if (it.location) parts.push(`<span class="lc-location">📍 ${esc(locationDisplay(it))}</span>`);
  if (it.kind === 'event' && it.description) parts.push(esc(it.description));
  return parts.join(' · ') + (it.kind === 'event' ? involvedOrgsBadgesHtml(it) : '');
}

async function renderMyActivitiesLeaderView() {
  const container = document.getElementById('view-root');
  container.innerHTML = `<div class="section-header"><div><h2>Mis Actividades</h2><p>Cargando…</p></div></div>`;
  let events, interviews;
  try { events = await api('/events'); } catch (e) { toast(e.message, 'error'); events = []; }
  // Si otra organización te entrevista a TI (por ejemplo, el líder de
  // Obispado entrevista al líder de Cuórum de Élderes), esa entrevista debe
  // aparecerte acá aunque no la haya agendado tu propia organización.
  try { interviews = await api('/interviews'); } catch (e) { interviews = []; }
  const myOrgId = Number(state.user.organizationId);
  // Además de tu propia organización (siempre, no es opcional — la
  // administras tú), podés seguir otras organizaciones igual que un
  // Miembro — por ejemplo si tienes hijos en Primaria.
  const followedIds = (state.user.followedOrganizationIds || []).map(Number);
  events = events.filter((ev) => Number(ev.organizationId) === myOrgId || ev.isWardActivity
    || followedIds.includes(Number(ev.organizationId))
    || (ev.involvedOrganizations || []).some((o) => Number(o.id) === myOrgId || followedIds.includes(Number(o.id))));
  const myOwnInterviews = interviews.filter((iv) => Number(iv.memberUserId) === Number(state.user.id));
  const todayIso = toISODate(new Date());
  // Las actividades cuya fecha ya pasó desaparecen de este listado para
  // mantener la pantalla limpia (siguen existiendo — se pueden seguir
  // viendo en el Calendario si hace falta revisar el historial).
  const list = [
    ...events.map((ev) => ({ ...ev, kind: 'event' })),
    ...myOwnInterviews.map((iv) => ({ ...iv, kind: 'interview', title: iv.description || 'Entrevista' })),
  ].filter((it) => it.date >= todayIso).sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  const grouped = {};
  for (const it of list) { (grouped[it.date] ||= []).push(it); }
  const dates = Object.keys(grouped).sort();
  const prefsOpen = state.myActivitiesPrefsOpen ?? false;
  const otherOrgs = state.organizations.filter((o) => Number(o.id) !== myOrgId);

  container.innerHTML = `
    <div class="section-header">
      <div>
        <h2>Mis Actividades</h2>
        <p>Todas las actividades de ${esc(state.user.organization ? state.user.organization.name : 'tu organización')}${followedIds.length ? ' y de las organizaciones que además elegiste seguir' : ''}, más las entrevistas en las que a ti te entrevistan — en un listado, sin tener que navegar mes a mes</p>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn btn-secondary" id="my-act-export">📅 Exportar a mi calendario</button>
        <button class="btn btn-secondary" id="my-act-prefs-toggle">${prefsOpen ? 'Ocultar selección' : '⚙️ Elegir organizaciones'}</button>
        <button class="btn btn-primary" id="my-act-new">+ Nueva actividad</button>
      </div>
    </div>
    <div id="my-act-prefs" style="${prefsOpen ? '' : 'display:none;'} margin-bottom:14px;">
      <div class="hint-box" style="margin-bottom:10px;">
        Tu propia organización (${esc(state.user.organization ? state.user.organization.name : '')}) siempre aparece acá. Marca además qué otras organizaciones te interesa seguir — por ejemplo, si tienes hijos en otra organización.
      </div>
      <div id="my-act-org-checks" style="display:flex; flex-wrap:wrap; gap:8px 16px; padding:4px 2px; margin-bottom:12px;">
        ${otherOrgs.map((o) => `
          <label style="display:flex; align-items:center; gap:6px; font-size:13.5px; cursor:pointer;">
            <input type="checkbox" name="followOrg" value="${o.id}" ${followedIds.includes(o.id) ? 'checked' : ''} />
            <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${o.color};"></span>${esc(o.name)}
          </label>`).join('')}
      </div>
      <button class="btn btn-primary btn-sm" id="my-act-prefs-save">Guardar preferencias</button>
    </div>
    <div class="card-list">
      ${dates.length ? dates.map((d) => `
        <div style="margin-bottom:6px;">
          <div style="font-size:12.5px; font-weight:700; color:var(--celeste-dark); text-transform:capitalize; margin:14px 0 6px;">${esc(fmtDateHuman(d))}${d < todayIso ? ' <span style="font-weight:500; color:var(--ink-soft); text-transform:none;">· pasada</span>' : ''}</div>
          ${grouped[d].map((it) => `
            <div class="list-card" data-kind="${it.kind}" data-id="${it.id}" style="cursor:pointer;">
              <span class="org-dot" style="background:${it.organizationColor}"></span>
              <div class="lc-main">
                <div class="lc-title">${it.kind === 'interview' ? '👤 ' : eventTitlePrefix(it)}${esc(it.title)}</div>
                <div class="lc-sub">${myActLeaderSubHtml(it, myOrgId)}</div>
              </div>
              <div class="lc-when">${esc(fmtTime(it.startTime))}${it.endTime ? ' - ' + esc(fmtTime(it.endTime)) : ''}</div>
            </div>`).join('')}
        </div>`).join('') : '<div class="empty-state">Todavía no tienes actividades agendadas</div>'}
    </div>
  `;

  document.getElementById('my-act-new').addEventListener('click', () => openEventModal());
  document.getElementById('my-act-export').addEventListener('click', () => openCalendarExportModal());
  document.getElementById('my-act-prefs-toggle').addEventListener('click', () => {
    state.myActivitiesPrefsOpen = !prefsOpen;
    renderMyActivitiesLeaderView();
  });
  document.getElementById('my-act-prefs-save').addEventListener('click', async () => {
    const checked = Array.from(document.querySelectorAll('#my-act-org-checks input[type="checkbox"]:checked')).map((cb) => Number(cb.value));
    try {
      const updatedUser = await api('/auth/me/followed-organizations', { method: 'PUT', body: { followedOrganizationIds: checked } });
      state.user = updatedUser;
      state.myActivitiesPrefsOpen = false;
      toast('Preferencias guardadas');
      await renderMyActivitiesLeaderView();
    } catch (e) { toast(e.message, 'error'); }
  });
  container.querySelectorAll('.list-card').forEach((card) => card.addEventListener('click', () => {
    const it = list.find((x) => x.kind === card.dataset.kind && x.id === Number(card.dataset.id));
    openItemModal(it, it.kind);
  }));
}

async function renderMyActivitiesMemberView() {
  const container = document.getElementById('view-root');
  container.innerHTML = `<div class="section-header"><div><h2>Mis Actividades</h2><p>Cargando…</p></div></div>`;
  let events, myInterviews;
  try { events = await api('/events'); } catch (e) { toast(e.message, 'error'); events = []; }
  // Si algún líder te agendó una entrevista eligiéndote de la lista de
  // usuarios registrados, el servidor la devuelve acá aunque la sección
  // Entrevistas no esté disponible para el perfil Miembro.
  try { myInterviews = await api('/interviews'); } catch (e) { myInterviews = []; }
  const followedIds = (state.user.followedOrganizationIds || []).map(Number);
  events = events.filter((ev) => ev.isWardActivity || followedIds.includes(Number(ev.organizationId)) || (ev.involvedOrganizations || []).some((o) => followedIds.includes(Number(o.id))));
  const todayIso = toISODate(new Date());
  // Las actividades cuya fecha ya pasó desaparecen de este listado para
  // mantener la pantalla limpia (siguen visibles en el Calendario si hace
  // falta revisar el historial).
  const list = [
    ...events.map((ev) => ({ ...ev, kind: 'event' })),
    ...myInterviews.map((iv) => ({ ...iv, kind: 'interview', title: iv.description || 'Entrevista' })),
  ].filter((it) => it.date >= todayIso).sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  const grouped = {};
  for (const it of list) { (grouped[it.date] ||= []).push(it); }
  const dates = Object.keys(grouped).sort();
  const prefsOpen = state.myActivitiesPrefsOpen ?? followedIds.length === 0;

  container.innerHTML = `
    <div class="section-header">
      <div>
        <h2>Mis Actividades</h2>
        <p>Actividades de las organizaciones que te interesan (como grupo familiar), más las actividades de todo el Barrio 🏘️ y tus propias entrevistas, que siempre aparecen acá.</p>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-secondary" id="my-act-export">📅 Exportar a mi calendario</button>
        <button class="btn btn-secondary" id="my-act-prefs-toggle">${prefsOpen ? 'Ocultar selección' : '⚙️ Elegir organizaciones'}</button>
      </div>
    </div>
    <div id="my-act-prefs" style="${prefsOpen ? '' : 'display:none;'} margin-bottom:14px;">
      <div class="hint-box" style="margin-bottom:10px;">
        Marca las organizaciones que te interesan — por ejemplo la tuya y las de tus hijos. Las actividades de todo el Barrio 🏘️ siempre van a aparecer, aunque no marques ninguna.
      </div>
      <div id="my-act-org-checks" style="display:flex; flex-wrap:wrap; gap:8px 16px; padding:4px 2px; margin-bottom:12px;">
        ${state.organizations.map((o) => `
          <label style="display:flex; align-items:center; gap:6px; font-size:13.5px; cursor:pointer;">
            <input type="checkbox" name="followOrg" value="${o.id}" ${followedIds.includes(o.id) ? 'checked' : ''} />
            <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${o.color};"></span>${esc(o.name)}
          </label>`).join('')}
      </div>
      <button class="btn btn-primary btn-sm" id="my-act-prefs-save">Guardar preferencias</button>
    </div>
    <div class="card-list">
      ${dates.length ? dates.map((d) => `
        <div style="margin-bottom:6px;">
          <div style="font-size:12.5px; font-weight:700; color:var(--celeste-dark); text-transform:capitalize; margin:14px 0 6px;">${esc(fmtDateHuman(d))}${d < todayIso ? ' <span style="font-weight:500; color:var(--ink-soft); text-transform:none;">· pasada</span>' : ''}</div>
          ${grouped[d].map((it) => `
            <div class="list-card" data-kind="${it.kind}" data-id="${it.id}" style="cursor:pointer;">
              <span class="org-dot" style="background:${it.organizationColor}"></span>
              <div class="lc-main">
                <div class="lc-title">${it.kind === 'interview' ? '👤 ' : eventTitlePrefix(it)}${esc(it.title)}</div>
                <div class="lc-sub">${esc(it.organizationName)}${it.location ? ` · <span class="lc-location">📍 ${esc(locationDisplay(it))}</span>` : ''}${it.kind === 'interview' && it.interviewerName ? ` · con ${esc(it.interviewerName)}` : ''}${it.kind === 'event' && it.description ? ' · ' + esc(it.description) : ''}${it.kind === 'event' ? involvedOrgsBadgesHtml(it) : ''}</div>
              </div>
              <div class="lc-when">${esc(fmtTime(it.startTime))}${it.endTime ? ' - ' + esc(fmtTime(it.endTime)) : ''}</div>
            </div>`).join('')}
        </div>`).join('') : `<div class="empty-state">${followedIds.length ? 'No hay actividades próximas de las organizaciones que elegiste' : 'Elige qué organizaciones te interesan para ver sus actividades acá'}</div>`}
    </div>
  `;

  document.getElementById('my-act-export').addEventListener('click', () => openCalendarExportModal());
  document.getElementById('my-act-prefs-toggle').addEventListener('click', () => {
    state.myActivitiesPrefsOpen = !prefsOpen;
    renderMyActivitiesMemberView();
  });
  document.getElementById('my-act-prefs-save').addEventListener('click', async () => {
    const checked = Array.from(document.querySelectorAll('#my-act-org-checks input[type="checkbox"]:checked')).map((cb) => Number(cb.value));
    try {
      const updatedUser = await api('/auth/me/followed-organizations', { method: 'PUT', body: { followedOrganizationIds: checked } });
      state.user = updatedUser;
      state.myActivitiesPrefsOpen = false;
      toast('Preferencias guardadas');
      await renderMyActivitiesMemberView();
    } catch (e) { toast(e.message, 'error'); }
  });
  container.querySelectorAll('.list-card').forEach((card) => card.addEventListener('click', () => {
    const it = list.find((x) => x.kind === card.dataset.kind && x.id === Number(card.dataset.id));
    openItemModal(it, it.kind);
  }));
}

function openEventModal(existing = null) {
  const options = editableOrgOptions('event');
  if (!existing && options.length === 0) { toast('No tienes una organización asignada para crear actividades', 'error'); return; }
  const isEdit = !!existing;
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="ev-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>${isEdit ? 'Editar actividad' : 'Nueva actividad'}</h3><button class="modal-close" id="ev-modal-close">×</button></div>
        <div class="modal-body">
          <div id="ev-error"></div>
          <form id="ev-form">
            <div class="field">
              <label>Organización</label>
              <select id="ev-org-select" name="${options.length === 1 ? '' : 'organizationId'}" ${options.length === 1 ? 'disabled' : ''} required>
                ${options.map((o) => `<option value="${o.id}" ${existing && existing.organizationId === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
              </select>
              ${options.length === 1 ? `<input type="hidden" name="organizationId" value="${options[0].id}" />` : ''}
            </div>
            ${eventTypeFieldHtml('ev', !!existing?.isMeeting)}
            ${wardActivityFieldHtml('ev', !!existing?.isWardActivity)}
            ${involvedOrgsFieldHtml('ev', existing?.involvedOrganizationIds || (existing?.involvedOrganizations || []).map((o) => o.id))}
            <div class="field">
              <label>Descripción de la actividad</label>
              <input type="text" name="title" required placeholder="Ej: Reunión de presidencia de Cuórum" value="${esc(existing?.title || '')}" />
            </div>
            <div class="field">
              <label>Propósito</label>
              <select name="purpose" required>
                <option value="" disabled ${!existing?.purpose ? 'selected' : ''}>Selecciona un propósito…</option>
                ${PURPOSE_OPTIONS.map((p) => `<option value="${p}" ${existing?.purpose === p ? 'selected' : ''}>${p}</option>`).join('')}
              </select>
            </div>
            ${locationFieldHtml('ev', existing?.location, existing?.sala)}
            <div id="ev-conflict-warning"></div>
            <div class="field">
              <label>Notas adicionales (opcional)</label>
              <textarea name="description">${esc(existing?.description || '')}</textarea>
            </div>
            <div class="field">
              <label>Día</label>
              <input type="date" name="date" required value="${existing?.date || ''}" />
            </div>
            <div class="two-col">
              <div class="field">
                <label>Hora de inicio</label>
                <input type="time" name="startTime" required value="${existing?.startTime || ''}" />
              </div>
              <div class="field">
                <label>Hora de término (opcional)</label>
                <input type="time" name="endTime" value="${existing?.endTime || ''}" />
              </div>
            </div>
            ${!isEdit ? recurrenceFieldHtml('ev') : ''}
          </form>
        </div>
        <div class="modal-footer">
          <div>${isEdit ? `<button class="btn btn-danger" id="ev-delete">Eliminar</button>` : ''}</div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="ev-cancel">Cancelar</button>
            <button class="btn btn-primary" id="ev-save">${isEdit ? 'Guardar cambios' : 'Crear actividad'}</button>
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById('ev-modal-close').addEventListener('click', closeModal);
  document.getElementById('ev-cancel').addEventListener('click', closeModal);
  document.getElementById('ev-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'ev-modal-backdrop') closeModal(); });
  if (isEdit) document.getElementById('ev-delete').addEventListener('click', async () => {
    if (!confirm('¿Eliminar esta actividad?')) return;
    try { await api(`/events/${existing.id}`, { method: 'DELETE' }); closeModal(); toast('Actividad eliminada'); await refreshAfterEventChange(); }
    catch (e) { toast(e.message, 'error'); }
  });

  let conflictsChecked = false;
  let stakeConflictsChecked = false; // solo puede quedar en true si el líder de Obispado ya vio el choque y confirmó
  const saveBtn = document.getElementById('ev-save');
  const resetConflictCheck = () => {
    conflictsChecked = false;
    stakeConflictsChecked = false;
    saveBtn.textContent = isEdit ? 'Guardar cambios' : 'Crear actividad';
    document.getElementById('ev-conflict-warning').innerHTML = '';
  };
  const form = document.getElementById('ev-form');
  ['date', 'startTime', 'endTime'].forEach((name) => {
    form.querySelector(`[name="${name}"]`)?.addEventListener('change', resetConflictCheck);
  });
  wireLocationField('ev', resetConflictCheck);
  document.getElementById('ev-location-other-field').querySelector('input').addEventListener('input', resetConflictCheck);

  const orgSelectEl = document.getElementById('ev-org-select');
  refreshInvolvedOrgOptions('ev', orgSelectEl.value);
  orgSelectEl.addEventListener('change', () => {
    refreshInvolvedOrgOptions('ev', orgSelectEl.value);
    resetConflictCheck();
  });
  document.querySelectorAll('#ev-involved-orgs input[type="checkbox"]').forEach((cb) => cb.addEventListener('change', resetConflictCheck));
  wireWardActivityField('ev', '#ev-involved-orgs-field', resetConflictCheck);
  if (!isEdit) wireRecurrenceField('ev');

  saveBtn.addEventListener('click', async () => {
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const location = computeLocationFromForm(fd);
    if (fd.get('locationType') === 'Otro' && !location) {
      document.getElementById('ev-error').innerHTML = `<div class="error-msg">Escribe cuál es el lugar</div>`;
      return;
    }
    const sala = computeSalaFromForm(fd, location);
    if (STANDARD_LOCATIONS.includes(location) && fd.get('salaType') === 'OtraSala' && !sala) {
      document.getElementById('ev-error').innerHTML = `<div class="error-msg">Escribe cuál es la sala</div>`;
      return;
    }
    const body = Object.fromEntries(fd.entries());
    body.location = location;
    body.sala = sala;
    delete body.locationType;
    delete body.locationOther;
    delete body.salaType;
    delete body.salaOther;
    body.isWardActivity = document.getElementById('ev-ward-activity').checked;
    body.involvedOrganizationIds = body.isWardActivity ? [] : computeInvolvedOrgIds(fd);
    body.isMeeting = document.getElementById('ev-type-select').value === 'meeting';

    document.getElementById('ev-error').innerHTML = '';

    if (!stakeConflictsChecked) {
      const stakeCheck = await checkStakeConflicts(body);
      if (stakeCheck.conflicts.length) {
        document.getElementById('ev-conflict-warning').innerHTML = stakeConflictWarningHtml(stakeCheck.conflicts, stakeCheck.canOverride);
        if (stakeCheck.canOverride) {
          stakeConflictsChecked = true;
          saveBtn.textContent = 'Agendar de todas formas';
        }
        return; // esperando confirmación (o bloqueado sin remedio si no puede autorizarlo)
      }
    }
    body.overrideStakeConflict = stakeConflictsChecked;

    if (!conflictsChecked) {
      const conflicts = await findConflictingActivities(body, existing?.id);
      if (conflicts.length) {
        document.getElementById('ev-conflict-warning').innerHTML = conflictWarningHtml(conflicts);
        conflictsChecked = true;
        saveBtn.textContent = 'Agendar de todas formas';
        return;
      }
    }
    document.getElementById('ev-conflict-warning').innerHTML = '';
    const dates = !isEdit ? computeRecurrenceDates('ev', body.date) : [body.date];
    try {
      if (isEdit) await api(`/events/${existing.id}`, { method: 'PUT', body });
      else if (dates.length > 1) await api('/events/recurring', { method: 'POST', body: { ...body, dates } });
      else await api('/events', { method: 'POST', body });
      closeModal();
      toast(isEdit ? 'Actividad actualizada' : (dates.length > 1 ? `${dates.length} actividades creadas` : 'Actividad creada'));
      await refreshAfterEventChange();
    } catch (e) {
      // Esto puede pasar sobre todo con una repetición: la revisión rápida
      // del cliente solo alcanza a chequear la primera fecha, así que el
      // servidor puede rechazar por una fecha más adelante que choca con
      // Estaca. Si quien está agendando es el líder de Obispado, se le
      // ofrece autorizarlo igual (para todo el lote) en vez de solo mostrar
      // el error y dejarlo sin salida.
      if (e.data?.stakeConflicts?.length && e.data?.canOverride) {
        const fechaTxt = e.data.conflictDate ? ` (fecha ${e.data.conflictDate})` : '';
        if (confirm(`🏛️ Choca con una actividad de Estaca${fechaTxt}. ¿Autorizar y agendar de todas formas como líder de Obispado?`)) {
          try {
            const body2 = { ...body, overrideStakeConflict: true };
            if (isEdit) await api(`/events/${existing.id}`, { method: 'PUT', body: body2 });
            else if (dates.length > 1) await api('/events/recurring', { method: 'POST', body: { ...body2, dates } });
            else await api('/events', { method: 'POST', body: body2 });
            closeModal();
            toast(isEdit ? 'Actividad actualizada' : (dates.length > 1 ? `${dates.length} actividades creadas` : 'Actividad creada'));
            await refreshAfterEventChange();
            return;
          } catch (e2) {
            document.getElementById('ev-error').innerHTML = `<div class="error-msg">${esc(e2.message)}</div>`;
            return;
          }
        }
      }
      document.getElementById('ev-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
}

// ---------------- Entrevistas ----------------
async function loadInterviewsUpcoming() {
  const from = toISODate(new Date());
  const to = toISODate(new Date(Date.now() + 1000 * 60 * 60 * 24 * 120));
  const params = state.interviewOrgFilter !== 'all' ? `&organizationId=${state.interviewOrgFilter}` : '';
  return api(`/interviews?from=${from}&to=${to}${params}`);
}

async function renderInterviewsView() {
  const container = document.getElementById('view-root');
  const seesAll = canViewAllInterviews();
  const interviewOrgs = state.organizations.filter((o) => o.allowsInterviews && (seesAll || o.id === state.user.organizationId));
  container.innerHTML = `<div class="section-header"><div><h2>Entrevistas</h2><p>Cargando…</p></div></div>`;
  let list;
  try { list = await loadInterviewsUpcoming(); } catch (e) { toast(e.message, 'error'); list = []; }

  const grouped = {};
  for (const iv of list) { (grouped[iv.date] ||= []).push(iv); }
  const dates = Object.keys(grouped).sort();

  container.innerHTML = `
    <div class="section-header">
      <div>
        <h2>Entrevistas</h2>
        <p>${seesAll ? 'Agendadas por los líderes de Obispado, Cuórum de Élderes y Sociedad de Socorro' : 'Entrevistas de tu organización · información privada, no visible para otras organizaciones'}</p>
      </div>
      ${canManageAnyInterviews() ? `<button class="btn btn-primary" id="iv-new">+ Agendar entrevista</button>` : ''}
    </div>
    ${interviewOrgs.length > 1 ? `
    <div class="subtabs">
      <button class="subtab-btn ${state.interviewOrgFilter === 'all' ? 'active' : ''}" data-org="all">Todas</button>
      ${interviewOrgs.map((o) => `<button class="subtab-btn ${String(state.interviewOrgFilter) === String(o.id) ? 'active' : ''}" data-org="${o.id}">${esc(o.name)}</button>`).join('')}
    </div>` : ''}
    <div class="card-list">
      ${dates.length ? dates.map((d) => `
        <div style="margin-bottom:6px;">
          <div style="font-size:12.5px; font-weight:700; color:var(--celeste-dark); text-transform:capitalize; margin:14px 0 6px;">${esc(fmtDateHuman(d))}</div>
          ${grouped[d].map((iv) => `
            <div class="list-card">
              <span class="org-dot" style="background:${iv.organizationColor}"></span>
              <div class="lc-main">
                <div class="lc-title">${esc(iv.memberName)}${iv.memberUserId ? ' <span title="Vinculada a un usuario registrado — le aparece en su Mis Actividades" style="font-weight:400; font-size:12px; color:var(--celeste-dark);">🔗 registrado</span>' : ''}</div>
                <div class="lc-sub">${esc(iv.organizationName)}${iv.location ? ` · <span class="lc-location">📍 ${esc(locationDisplay(iv))}</span>` : ''}${iv.interviewerName ? ` · 🧑‍💼 ${esc(iv.interviewerName)}` : ''}${iv.description ? ' · ' + esc(iv.description) : ''}${iv.memberPhone ? ' · ' + esc(iv.memberPhone) : ''}</div>
              </div>
              <div class="lc-when">${esc(fmtTime(iv.startTime))}${iv.endTime ? ' - ' + esc(fmtTime(iv.endTime)) : ''}</div>
              ${canScheduleInterviewsFor(iv.organizationId) ? `<div class="lc-actions"><button class="btn btn-secondary btn-sm" data-edit-iv="${iv.id}">Editar</button></div>` : ''}
            </div>`).join('')}
        </div>`).join('') : '<div class="empty-state">No hay entrevistas agendadas en los próximos 120 días</div>'}
    </div>
  `;

  const newBtn = document.getElementById('iv-new');
  if (newBtn) newBtn.addEventListener('click', () => openInterviewModal());
  container.querySelectorAll('.subtab-btn').forEach((b) => b.addEventListener('click', () => { state.interviewOrgFilter = b.dataset.org === 'all' ? 'all' : Number(b.dataset.org); renderInterviewsView(); }));
  container.querySelectorAll('[data-edit-iv]').forEach((b) => b.addEventListener('click', () => {
    const iv = list.find((i) => i.id === Number(b.dataset.editIv));
    openInterviewModal(iv);
  }));
}

// ---------------- Selector de miembro con autocompletado ----------------
// En vez de un <select> con todos los usuarios (inmanejable pasados los
// 100+ miembros de un barrio), se escribe el nombre y van apareciendo las
// coincidencias para hacer clic. Si la persona no está registrada, se puede
// seguir escribiendo su nombre a mano en el campo de abajo.
function normalizeSearchText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function memberPickerFieldHtml(idPrefix, selectedUserId, selectedName) {
  return `
    <div class="field">
      <label>Miembro</label>
      <div id="${idPrefix}-member-chip" style="display:${selectedUserId ? 'flex' : 'none'}; align-items:center; gap:8px; flex-wrap:wrap; padding:8px 10px; border:1px solid var(--border, #d8e3ea); border-radius:8px; background:#f4f8fb;">
        <span>🔗 Vinculado a <strong id="${idPrefix}-member-chip-name">${esc(selectedName || '')}</strong></span>
        <button type="button" class="btn btn-ghost btn-sm" id="${idPrefix}-member-unlink">Quitar / escribir a mano</button>
      </div>
      <div id="${idPrefix}-member-search-wrap" style="display:${selectedUserId ? 'none' : ''}; position:relative;">
        <input type="text" name="memberName" id="${idPrefix}-member-name" required autocomplete="off" placeholder="Nombre y apellido (si está registrado, aparecerán coincidencias para elegir)" value="${esc(selectedName || '')}" ${selectedUserId ? 'readonly' : ''} />
        <div id="${idPrefix}-member-results" style="display:none; position:absolute; left:0; right:0; z-index:30; background:#fff; border:1px solid var(--border, #d8e3ea); border-radius:8px; margin-top:2px; max-height:220px; overflow-y:auto; box-shadow:0 6px 20px rgba(0,0,0,.12);"></div>
      </div>
      <input type="hidden" name="memberUserId" id="${idPrefix}-member-user-id" value="${esc(selectedUserId || '')}" />
    </div>`;
}

function wireMemberPicker(idPrefix, directory, onChange) {
  const nameInput = document.getElementById(`${idPrefix}-member-name`);
  const resultsBox = document.getElementById(`${idPrefix}-member-results`);
  const hiddenId = document.getElementById(`${idPrefix}-member-user-id`);
  const chip = document.getElementById(`${idPrefix}-member-chip`);
  const chipName = document.getElementById(`${idPrefix}-member-chip-name`);
  const searchWrap = document.getElementById(`${idPrefix}-member-search-wrap`);
  const unlinkBtn = document.getElementById(`${idPrefix}-member-unlink`);

  const showChip = (name) => {
    chipName.textContent = name;
    chip.style.display = 'flex';
    searchWrap.style.display = 'none';
  };
  const showSearch = () => {
    chip.style.display = 'none';
    searchWrap.style.display = '';
    resultsBox.style.display = 'none';
    resultsBox.innerHTML = '';
  };
  const selectUser = (u) => {
    hiddenId.value = u.id;
    nameInput.value = u.name;
    nameInput.readOnly = true;
    showChip(u.name);
    resultsBox.style.display = 'none';
    resultsBox.innerHTML = '';
    if (onChange) onChange();
  };

  // El mismo campo sirve para buscar y para escribir el nombre a mano: si al
  // tipear aparece una coincidencia y se hace clic, queda vinculado; si nadie
  // coincide (o no se hace clic en nada), lo escrito por el líder queda tal
  // cual como nombre del miembro — no hay un campo aparte de respaldo.
  nameInput.addEventListener('input', () => {
    hiddenId.value = '';
    const q = normalizeSearchText(nameInput.value);
    if (!q) { resultsBox.style.display = 'none'; resultsBox.innerHTML = ''; return; }
    const matches = directory.filter((u) => normalizeSearchText(u.name).includes(q)).slice(0, 8);
    if (!matches.length) {
      resultsBox.innerHTML = `<div style="padding:8px 10px; color:var(--ink-soft, #888); font-size:13px;">Sin coincidencias — se guardará el nombre tal como lo escribas</div>`;
      resultsBox.style.display = '';
      return;
    }
    resultsBox.innerHTML = matches.map((u) => `<div class="ac-item" data-id="${u.id}" style="padding:8px 10px; cursor:pointer; font-size:13.5px;">${esc(u.name)}</div>`).join('');
    resultsBox.style.display = '';
    resultsBox.querySelectorAll('.ac-item').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const u = directory.find((d) => String(d.id) === el.dataset.id);
        if (u) selectUser(u);
      });
      el.addEventListener('mouseenter', () => { el.style.background = '#f0f4f8'; });
      el.addEventListener('mouseleave', () => { el.style.background = ''; });
    });
  });
  nameInput.addEventListener('focus', () => { if (!nameInput.readOnly && nameInput.value) nameInput.dispatchEvent(new Event('input')); });
  nameInput.addEventListener('blur', () => { setTimeout(() => { resultsBox.style.display = 'none'; }, 150); });
  unlinkBtn.addEventListener('click', () => {
    hiddenId.value = '';
    nameInput.readOnly = false;
    nameInput.value = '';
    showSearch();
    nameInput.focus();
    if (onChange) onChange();
  });
}

async function openInterviewModal(existing = null) {
  const options = editableOrgOptions('interview');
  if (!existing && options.length === 0) { toast('No tienes permiso para agendar entrevistas', 'error'); return; }
  const isEdit = !!existing;
  let directory = [];
  try { directory = await api('/users/directory'); } catch (e) { directory = []; }
  const modalRoot = document.getElementById('modal-root');
  const selectedUserId = existing?.memberUserId || '';
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="iv-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>${isEdit ? 'Editar entrevista' : 'Agendar entrevista'}</h3><button class="modal-close" id="iv-modal-close">×</button></div>
        <div class="modal-body">
          <div id="iv-error"></div>
          <form id="iv-form">
            <div class="field">
              <label>Organización</label>
              <select name="${options.length === 1 && !isEdit ? '' : 'organizationId'}" ${options.length === 1 || isEdit ? 'disabled' : ''} required>
                ${options.map((o) => `<option value="${o.id}" ${existing && existing.organizationId === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
              </select>
              ${options.length === 1 && !isEdit ? `<input type="hidden" name="organizationId" value="${options[0].id}" />` : ''}
            </div>
            ${memberPickerFieldHtml('iv', selectedUserId, existing?.memberName)}
            <div class="two-col">
              <div class="field">
                <label>Teléfono (opcional)</label>
                <input type="text" name="memberPhone" placeholder="+56 9 ..." value="${esc(existing?.memberPhone || '')}" />
              </div>
              <div class="field">
                <label>Email del miembro (opcional)</label>
                <input type="email" name="memberEmail" placeholder="miembro@correo.com" value="${esc(existing?.memberEmail || '')}" />
              </div>
            </div>
            <div class="field">
              <label>Descripción / motivo</label>
              <textarea name="description" placeholder="Ej: Entrevista de recomendación para el templo">${esc(existing?.description || '')}</textarea>
            </div>
            ${locationFieldHtml('iv', existing?.location, existing?.sala)}
            <div id="iv-conflict-warning"></div>
            <div class="field">
              <label>Líder que realizará la entrevista</label>
              <input type="text" name="interviewerName" required placeholder="Nombre del líder" value="${esc(existing?.interviewerName ?? (!isEdit && state.user.role !== 'admin' ? state.user.name : ''))}" />
            </div>
            <div class="two-col">
              <div class="field">
                <label>Email del líder (opcional)</label>
                <input type="email" name="interviewerEmail" placeholder="lider@correo.com" value="${esc(existing?.interviewerEmail ?? (!isEdit && state.user.role !== 'admin' ? state.user.email : ''))}" />
              </div>
              <div class="field">
                <label>WhatsApp del líder (opcional)</label>
                <input type="text" name="interviewerPhone" placeholder="+56 9 ..." value="${esc(existing?.interviewerPhone || '')}" />
              </div>
            </div>
            <div class="hint-box" style="margin-top:0;">Si cargas el email del líder y/o del miembro, ambos reciben automáticamente: un recordatorio 24 horas antes, un aviso si se cambia la fecha/hora, y un aviso si se cancela.</div>
            <div class="field">
              <label>Día</label>
              <input type="date" name="date" required value="${existing?.date || ''}" />
            </div>
            <div class="two-col">
              <div class="field">
                <label>Hora de inicio</label>
                <input type="time" name="startTime" required value="${existing?.startTime || ''}" />
              </div>
              <div class="field">
                <label>Hora de término (opcional)</label>
                <input type="time" name="endTime" value="${existing?.endTime || ''}" />
              </div>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <div>${isEdit ? `<button class="btn btn-danger" id="iv-delete">Eliminar</button>` : ''}</div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="iv-cancel">Cancelar</button>
            <button class="btn btn-primary" id="iv-save">${isEdit ? 'Guardar cambios' : 'Agendar'}</button>
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById('iv-modal-close').addEventListener('click', closeModal);
  document.getElementById('iv-cancel').addEventListener('click', closeModal);
  document.getElementById('iv-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'iv-modal-backdrop') closeModal(); });
  if (isEdit) document.getElementById('iv-delete').addEventListener('click', async () => {
    if (!confirm('¿Eliminar esta entrevista?')) return;
    try { await api(`/interviews/${existing.id}`, { method: 'DELETE' }); closeModal(); toast('Entrevista eliminada'); await refreshAfterInterviewChange(); }
    catch (e) { toast(e.message, 'error'); }
  });

  let ivConflictsChecked = false;
  const ivSaveBtn = document.getElementById('iv-save');
  const resetIvConflictCheck = () => {
    ivConflictsChecked = false;
    ivSaveBtn.textContent = isEdit ? 'Guardar cambios' : 'Agendar';
    document.getElementById('iv-conflict-warning').innerHTML = '';
  };
  const ivForm = document.getElementById('iv-form');
  ['date', 'startTime', 'endTime'].forEach((name) => {
    ivForm.querySelector(`[name="${name}"]`)?.addEventListener('change', resetIvConflictCheck);
  });
  wireLocationField('iv', resetIvConflictCheck);
  document.getElementById('iv-location-other-field').querySelector('input').addEventListener('input', resetIvConflictCheck);

  wireMemberPicker('iv', directory, resetIvConflictCheck);

  ivSaveBtn.addEventListener('click', async () => {
    if (!ivForm.reportValidity()) return;
    const fd = new FormData(ivForm);
    const location = computeLocationFromForm(fd);
    if (fd.get('locationType') === 'Otro' && !location) {
      document.getElementById('iv-error').innerHTML = `<div class="error-msg">Escribe cuál es el lugar</div>`;
      return;
    }
    const sala = computeSalaFromForm(fd, location);
    if (STANDARD_LOCATIONS.includes(location) && fd.get('salaType') === 'OtraSala' && !sala) {
      document.getElementById('iv-error').innerHTML = `<div class="error-msg">Escribe cuál es la sala</div>`;
      return;
    }
    const body = Object.fromEntries(fd.entries());
    body.memberUserId = body.memberUserId ? Number(body.memberUserId) : null;
    body.location = location;
    body.sala = sala;
    delete body.locationType;
    delete body.locationOther;
    delete body.salaType;
    delete body.salaOther;
    if (isEdit) body.organizationId = existing.organizationId;

    if (!ivConflictsChecked) {
      const conflicts = await findConflictingActivities(body, null, existing?.id);
      if (conflicts.length) {
        document.getElementById('iv-conflict-warning').innerHTML = conflictWarningHtml(conflicts);
        ivConflictsChecked = true;
        ivSaveBtn.textContent = 'Agendar de todas formas';
        return;
      }
    }
    try {
      if (isEdit) await api(`/interviews/${existing.id}`, { method: 'PUT', body });
      else await api('/interviews', { method: 'POST', body });
      closeModal();
      toast(isEdit ? 'Entrevista actualizada' : 'Entrevista agendada');
      await refreshAfterInterviewChange();
    } catch (e) {
      document.getElementById('iv-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
}

async function refreshAfterInterviewChange() {
  if (state.view === 'interviews') renderInterviewsView();
  else { await loadCalendarData(); if (state.view === 'calendar') renderCalendarView(); }
}

// ---------------- Presupuesto ----------------
// Trimestral: el líder de Obispado asigna un monto a cada organización
// (incluida la suya) y puede crear categorías extra que no son de una sola
// organización (ej. "Actividades de Barrio"). Cada líder ve el presupuesto
// asignado a su propia organización y registra sus gastos, opcionalmente
// ligados a una actividad ya creada. El líder de Obispado además puede
// registrar gastos como Obispado o en cualquier categoría de todo el
// Barrio. Al cambiar de trimestre no se borra nada: los datos de
// trimestres anteriores quedan disponibles a modo de historial (de solo
// lectura), pero no se cuentan en el saldo del trimestre actual.
function quarterLabelClient(q) {
  const m = /^(\d{4})-Q([1-4])$/.exec(q || '');
  return m ? `${m[2]}° trimestre ${m[1]}` : (q || '');
}
function fmtMoney(n) {
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(Number(n) || 0);
}
// Determina si el usuario actual puede registrar gastos en esta categoría:
// cada líder solo en la de su propia organización; el líder de Obispado
// (o el administrador) además en cualquier categoría personalizada.
function canOperateOnBudgetCategory(cat) {
  const u = state.user;
  if (!u) return false;
  if (u.role === 'admin') return true;
  if (u.role !== 'leader') return false;
  if (cat.categoryType === 'organization') return Number(cat.organizationId) === Number(u.organizationId);
  return isObispadoUser();
}

async function renderBudgetView() {
  const container = document.getElementById('view-root');
  container.innerHTML = `<div class="section-header"><div><h2>Presupuesto</h2><p>Cargando…</p></div></div>`;
  let quartersData;
  try { quartersData = await api('/budget/quarters'); }
  catch (e) { toast(e.message, 'error'); container.innerHTML = '<div class="empty-state">No se pudo cargar el presupuesto</div>'; return; }
  if (!state.budgetQuarter || !quartersData.quarters.includes(state.budgetQuarter)) {
    state.budgetQuarter = quartersData.currentQuarter;
  }
  let budgetData;
  try { budgetData = await api(`/budget?quarter=${encodeURIComponent(state.budgetQuarter)}`); }
  catch (e) { toast(e.message, 'error'); container.innerHTML = '<div class="empty-state">No se pudo cargar el presupuesto</div>'; return; }

  const { quarter, isCurrentQuarter, isObispado, categories } = budgetData;

  container.innerHTML = `
    <div class="section-header">
      <div>
        <h2>Presupuesto</h2>
        <p>${isObispado
          ? 'Asigna el presupuesto trimestral de cada organización (incluida Obispado) y registra tus propios gastos o los de actividades de todo el Barrio.'
          : 'Presupuesto asignado a tu organización para este trimestre, y registro de tus gastos.'}</p>
      </div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <select id="budget-quarter-select">
          ${quartersData.quarters.map((q) => `<option value="${q}" ${q === quarter ? 'selected' : ''}>${esc(quarterLabelClient(q))}${q === quartersData.currentQuarter ? ' (actual)' : ''}</option>`).join('')}
        </select>
        ${isObispado ? `<button class="btn btn-secondary" id="budget-new-category">+ Nueva categoría</button>` : ''}
      </div>
    </div>
    ${!isCurrentQuarter ? `<div class="hint-box">Estás viendo un trimestre anterior, a modo de historial de consulta — no se puede editar. Para agregar asignaciones o gastos, vuelve al trimestre actual con el selector de arriba.</div>` : ''}
    <div class="card-list" id="budget-cats">
      ${categories.length ? categories.map((cat) => budgetCategoryCardHtml(cat, isCurrentQuarter, isObispado)).join('') : '<div class="empty-state">Todavía no hay categorías de presupuesto</div>'}
    </div>
  `;

  document.getElementById('budget-quarter-select').addEventListener('change', (e) => {
    state.budgetQuarter = e.target.value;
    renderBudgetView();
  });
  if (isObispado) {
    document.getElementById('budget-new-category').addEventListener('click', () => openBudgetCategoryModal());
  }
  wireBudgetCategoryCards(categories, isCurrentQuarter, isObispado);
}

function budgetCategoryCardHtml(cat, isCurrentQuarter, isObispado) {
  const canAllocate = isObispado && isCurrentQuarter;
  const canExpense = canOperateOnBudgetCategory(cat) && isCurrentQuarter;
  const balanceColor = cat.balance < 0 ? 'var(--danger)' : 'inherit';
  return `
    <div class="budget-card" data-cat-type="${cat.categoryType}" data-org-id="${cat.organizationId || ''}" data-cat-id="${cat.budgetCategoryId || ''}">
      <div class="budget-card-head">
        <div class="budget-card-name">
          <span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:${cat.categoryColor};"></span>
          <strong style="font-size:15px;">${esc(cat.categoryName)}</strong>
        </div>
        <div class="budget-figures">
          <div><span class="bf-label">Asignado</span><strong>${fmtMoney(cat.assigned)}</strong></div>
          <div><span class="bf-label">Gastado</span><strong>${fmtMoney(cat.spent)}</strong></div>
          <div><span class="bf-label">Saldo</span><strong style="color:${balanceColor};">${fmtMoney(cat.balance)}</strong></div>
        </div>
      </div>
      ${canAllocate ? `
        <div class="budget-alloc-row">
          <input type="number" min="0" step="1" class="budget-alloc-input" value="${cat.assigned}" />
          <button type="button" class="btn btn-secondary btn-sm budget-alloc-save">Guardar asignación</button>
        </div>` : ''}
      <div class="budget-actions-row">
        <button type="button" class="btn btn-ghost btn-sm budget-toggle-expenses">${cat.expenses.length ? `Ver gastos (${cat.expenses.length})` : 'Sin gastos registrados'}</button>
        ${canExpense ? `<button type="button" class="btn btn-primary btn-sm budget-add-expense">+ Registrar gasto</button>` : ''}
      </div>
      <div class="budget-expenses-list" style="display:none;">
        ${cat.expenses.length ? cat.expenses.map((e) => budgetExpenseRowHtml(e, canExpense)).join('') : '<div class="empty-state" style="padding:8px;">Sin gastos registrados</div>'}
      </div>
    </div>`;
}

function budgetExpenseRowHtml(e, canEdit) {
  return `
    <div class="budget-expense-row" data-expense-id="${e.id}">
      <div>
        <div>${esc(e.description)}${e.eventTitle ? ` · <span style="color:var(--celeste-dark);">🔗 ${esc(e.eventTitle)}</span>` : ''}</div>
        <div style="color:var(--ink-soft); font-size:12px;">${esc(fmtDateHuman(e.date))}${e.registeredByName ? ' · ' + esc(e.registeredByName) : ''}</div>
      </div>
      <div style="display:flex; align-items:center; gap:10px;">
        <strong>${fmtMoney(e.amount)}</strong>
        ${canEdit ? `<button type="button" class="btn btn-ghost btn-sm budget-edit-expense" title="Editar">✏️</button><button type="button" class="btn btn-ghost btn-sm budget-delete-expense" title="Eliminar">🗑️</button>` : ''}
      </div>
    </div>`;
}

function wireBudgetCategoryCards(categories) {
  document.querySelectorAll('#budget-cats > .budget-card').forEach((card, idx) => {
    const cat = categories[idx];
    card.querySelector('.budget-toggle-expenses')?.addEventListener('click', () => {
      const list = card.querySelector('.budget-expenses-list');
      list.style.display = list.style.display === 'none' ? '' : 'none';
    });
    const allocInput = card.querySelector('.budget-alloc-input');
    const allocSaveBtn = card.querySelector('.budget-alloc-save');
    if (allocSaveBtn) {
      allocSaveBtn.addEventListener('click', async () => {
        const amount = Number(allocInput.value);
        if (!Number.isFinite(amount) || amount < 0) { toast('Monto inválido', 'error'); return; }
        try {
          await api('/budget/allocations', { method: 'PUT', body: {
            quarter: state.budgetQuarter, categoryType: cat.categoryType,
            organizationId: cat.organizationId, budgetCategoryId: cat.budgetCategoryId, amount,
          } });
          toast('Asignación guardada');
          renderBudgetView();
        } catch (e) { toast(e.message, 'error'); }
      });
    }
    card.querySelector('.budget-add-expense')?.addEventListener('click', () => openBudgetExpenseModal(cat));
    card.querySelectorAll('.budget-edit-expense').forEach((btn) => {
      const row = btn.closest('.budget-expense-row');
      const expense = cat.expenses.find((e) => e.id === Number(row.dataset.expenseId));
      btn.addEventListener('click', () => openBudgetExpenseModal(cat, expense));
    });
    card.querySelectorAll('.budget-delete-expense').forEach((btn) => {
      const row = btn.closest('.budget-expense-row');
      const expenseId = Number(row.dataset.expenseId);
      btn.addEventListener('click', async () => {
        if (!confirm('¿Eliminar este gasto?')) return;
        try { await api(`/budget/expenses/${expenseId}`, { method: 'DELETE' }); toast('Gasto eliminado'); renderBudgetView(); }
        catch (e) { toast(e.message, 'error'); }
      });
    });
  });
}

async function openBudgetExpenseModal(cat, existing = null) {
  const isEdit = !!existing;
  let events = [];
  try {
    if (cat.categoryType === 'organization') {
      events = await api(`/events?organizationId=${cat.organizationId}`);
    } else {
      const all = await api('/events');
      events = all.filter((ev) => ev.isWardActivity);
    }
  } catch (e) { events = []; }
  events = events.slice().sort((a, b) => (b.date + b.startTime).localeCompare(a.date + a.startTime));

  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="be-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>${isEdit ? 'Editar gasto' : 'Registrar gasto'} — ${esc(cat.categoryName)}</h3><button class="modal-close" id="be-modal-close">×</button></div>
        <div class="modal-body">
          <div id="be-error"></div>
          <form id="be-form">
            <div class="field">
              <label>Monto</label>
              <input type="number" name="amount" min="1" step="1" required placeholder="0" value="${existing ? existing.amount : ''}" />
            </div>
            <div class="field">
              <label>Descripción</label>
              <input type="text" name="description" required placeholder="Ej: Materiales para actividad" value="${esc(existing?.description || '')}" />
            </div>
            <div class="field">
              <label>Fecha</label>
              <input type="date" name="date" required value="${existing?.date || toISODate(new Date())}" />
            </div>
            <div class="field">
              <label>Actividad relacionada (opcional)</label>
              <select name="eventId">
                <option value="">— Ninguna —</option>
                ${events.map((ev) => `<option value="${ev.id}" ${existing?.eventId === ev.id ? 'selected' : ''}>${esc(fmtDateHuman(ev.date))} · ${esc(ev.title)}</option>`).join('')}
              </select>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <div>${isEdit ? `<button class="btn btn-danger" id="be-delete">Eliminar</button>` : ''}</div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="be-cancel">Cancelar</button>
            <button class="btn btn-primary" id="be-save">${isEdit ? 'Guardar cambios' : 'Registrar'}</button>
          </div>
        </div>
      </div>
    </div>`;
  document.getElementById('be-modal-close').addEventListener('click', closeModal);
  document.getElementById('be-cancel').addEventListener('click', closeModal);
  document.getElementById('be-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'be-modal-backdrop') closeModal(); });
  if (isEdit) document.getElementById('be-delete').addEventListener('click', async () => {
    if (!confirm('¿Eliminar este gasto?')) return;
    try { await api(`/budget/expenses/${existing.id}`, { method: 'DELETE' }); closeModal(); toast('Gasto eliminado'); renderBudgetView(); }
    catch (e) { toast(e.message, 'error'); }
  });
  const form = document.getElementById('be-form');
  document.getElementById('be-save').addEventListener('click', async () => {
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const body = Object.fromEntries(fd.entries());
    body.amount = Number(body.amount);
    body.eventId = body.eventId ? Number(body.eventId) : null;
    if (!isEdit) {
      body.categoryType = cat.categoryType;
      body.organizationId = cat.organizationId;
      body.budgetCategoryId = cat.budgetCategoryId;
    }
    try {
      if (isEdit) await api(`/budget/expenses/${existing.id}`, { method: 'PUT', body });
      else await api('/budget/expenses', { method: 'POST', body });
      closeModal();
      toast(isEdit ? 'Gasto actualizado' : 'Gasto registrado');
      renderBudgetView();
    } catch (e) {
      document.getElementById('be-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
}

function openBudgetCategoryModal() {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="bc-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>Nueva categoría de presupuesto</h3><button class="modal-close" id="bc-modal-close">×</button></div>
        <div class="modal-body">
          <div id="bc-error"></div>
          <div class="hint-box" style="margin-top:0;">Para gastos que no pertenecen a una sola organización — por ejemplo "Actividades de Barrio", "Mantenimiento del edificio", etc.</div>
          <form id="bc-form">
            <div class="field">
              <label>Nombre de la categoría</label>
              <input type="text" name="name" required placeholder="Ej: Actividades de Barrio" />
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="bc-cancel">Cancelar</button>
            <button class="btn btn-primary" id="bc-save">Crear</button>
          </div>
        </div>
      </div>
    </div>`;
  document.getElementById('bc-modal-close').addEventListener('click', closeModal);
  document.getElementById('bc-cancel').addEventListener('click', closeModal);
  document.getElementById('bc-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'bc-modal-backdrop') closeModal(); });
  const form = document.getElementById('bc-form');
  document.getElementById('bc-save').addEventListener('click', async () => {
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    try {
      await api('/budget/categories', { method: 'POST', body: { name: fd.get('name') } });
      closeModal();
      toast('Categoría creada');
      renderBudgetView();
    } catch (e) {
      document.getElementById('bc-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
}

// ---------------- Administración ----------------
async function renderAdminView() {
  const container = document.getElementById('view-root');
  let pendingCount = 0;
  try { pendingCount = (await api('/registration-requests')).length; } catch (e) { /* silencioso */ }
  container.innerHTML = `
    <div class="section-header"><div><h2>Administración</h2><p>Gestiona usuarios, organizaciones y solicitudes de cuenta</p></div></div>
    <div class="subtabs">
      <button class="subtab-btn ${state.adminSubtab === 'users' ? 'active' : ''}" data-tab="users">Usuarios</button>
      <button class="subtab-btn ${state.adminSubtab === 'orgs' ? 'active' : ''}" data-tab="orgs">Organizaciones</button>
      <button class="subtab-btn ${state.adminSubtab === 'requests' ? 'active' : ''}" data-tab="requests">Solicitudes${pendingCount > 0 ? ` <span style="background:var(--celeste);color:#fff;border-radius:999px;padding:1px 7px;font-size:11px;margin-left:4px;">${pendingCount}</span>` : ''}</button>
      <button class="subtab-btn ${state.adminSubtab === 'stake' ? 'active' : ''}" data-tab="stake">🏛️ Estaca</button>
    </div>
    <div id="admin-content"></div>
  `;
  container.querySelectorAll('.subtab-btn').forEach((b) => b.addEventListener('click', () => { state.adminSubtab = b.dataset.tab; renderAdminView(); }));
  if (state.adminSubtab === 'users') await renderAdminUsers();
  else if (state.adminSubtab === 'orgs') await renderAdminOrgs();
  else if (state.adminSubtab === 'stake') await renderAdminStake();
  else await renderAdminRequests();
}

// ---------------- Administración: enlace del calendario de Estaca ----------------
async function renderAdminStake() {
  const content = document.getElementById('admin-content');
  content.innerHTML = `<p>Cargando…</p>`;
  let sc;
  try { sc = await api('/stake-calendar'); } catch (e) { toast(e.message, 'error'); sc = { url: '', displayName: 'Estaca' }; }

  const statusHtml = sc.lastSyncOk === true
    ? `<div class="hint-box" style="border-color:#16a34a; background:#f0fdf4;">✅ Última sincronización: ${esc(fmtRelativeTime(sc.lastSyncedAt))} · ${sc.eventCount} actividad${sc.eventCount === 1 ? '' : 'es'} guardadas</div>`
    : sc.lastSyncOk === false
      ? `<div class="hint-box" style="border-color:#b91c1c; background:#fef2f2;">⚠️ Falló la última sincronización (${esc(sc.lastSyncedAt ? fmtRelativeTime(sc.lastSyncedAt) : '')}): ${esc(sc.lastSyncError || 'error desconocido')}. Se sigue usando la última copia guardada (${sc.eventCount} actividades) mientras tanto.</div>`
      : `<div class="hint-box">Todavía no se ha sincronizado.</div>`;

  const keywordsText = (sc.nonBlockingKeywords || []).join('\n');
  content.innerHTML = `
    <div class="hint-box" style="margin-bottom:14px;">
      La Estaca agrupa a varios barrios. Sus actividades que involucran coordinación entre barrios (conferencias, festivales, capacitaciones, días de servicio, etc.) tienen <strong>prioridad</strong>: nadie puede agendar algo encima sin autorización del líder de Obispado. Las actividades puramente internas de la Estaca (entrevistas, reuniones de presidencia, sumo consejo, etc.) son solo informativas y no restringen nada — abajo se elige cómo distinguirlas. Este enlace es la suscripción pública .ics del calendario de la Estaca en el sitio de la Iglesia — el barrio la sincroniza automáticamente cada pocas horas.
    </div>
    ${statusHtml}
    <form id="stake-config-form" style="max-width:560px; margin-top:14px;">
      <div class="field">
        <label>Enlace de suscripción (.ics) del calendario de Estaca</label>
        <input type="url" name="url" required placeholder="https://churchofjesuschrist.org/church-calendar/services/ext/v3.0/export/ical/subscribe/..." value="${esc(sc.url || '')}" />
      </div>
      <div class="field">
        <label>Nombre a mostrar</label>
        <input type="text" name="displayName" placeholder="Ej: Estaca Colina Chile" value="${esc(sc.displayName || '')}" />
      </div>
      <div class="field">
        <label>Palabras que NO restringen (una por línea)</label>
        <textarea name="nonBlockingKeywords" rows="5" placeholder="entrevista&#10;presidencia de estaca&#10;sumo consejo">${esc(keywordsText)}</textarea>
        <div style="font-size:12px; color:var(--ink-soft, #888); margin-top:4px;">Si el título de una actividad de Estaca contiene alguna de estas palabras (sin importar mayúsculas o tildes), NO bloquea nada — es informativa.</div>
      </div>
      <div class="field">
        <label style="display:flex; align-items:center; gap:8px; font-weight:600;">
          <input type="checkbox" id="stake-show-nonblocking" ${sc.showNonBlockingEvents !== false ? 'checked' : ''} style="width:auto;" />
          Mostrar en el calendario las actividades informativas de Estaca
        </label>
        <div style="font-size:12px; color:var(--ink-soft, #888); margin-top:4px;">Desmárcalo para que esas actividades (las que no influyen a la membresía del Barrio — entrevistas, reuniones internas, etc.) directamente no aparezcan en el calendario de nadie. Solo van a quedar visibles las actividades de Estaca que sí requieren autorización del líder de Obispado. No afecta el bloqueo: las informativas nunca bloquearon nada, esto es solo si se ven o no.</div>
      </div>
    </form>
    <div style="display:flex; gap:8px;">
      <button class="btn btn-primary" id="stake-config-save">Guardar y sincronizar</button>
      <button class="btn btn-secondary" id="stake-config-sync-now">Sincronizar ahora</button>
    </div>
    <div id="stake-config-error" style="margin-top:10px;"></div>
  `;
  document.getElementById('stake-config-save').addEventListener('click', async () => {
    const form = document.getElementById('stake-config-form');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const body = Object.fromEntries(fd.entries());
    body.nonBlockingKeywords = String(body.nonBlockingKeywords || '').split('\n').map((s) => s.trim()).filter(Boolean);
    body.showNonBlockingEvents = document.getElementById('stake-show-nonblocking').checked;
    try {
      state.stakeCalendar = await api('/stake-calendar', { method: 'PUT', body });
      // Solo se intentó descargar el feed de nuevo si el enlace cambió — si
      // no cambió (ej. solo se tocó el nombre, las palabras clave, o el
      // interruptor de "mostrar informativas"), es un guardado puramente
      // local y no tiene sentido mostrarlo como si hubiera fallado una
      // sincronización que ni siquiera se intentó.
      if (!state.stakeCalendar.resynced) toast('Guardado');
      else toast(state.stakeCalendar.lastSyncOk ? 'Guardado y sincronizado' : 'Guardado, pero la sincronización falló: ' + state.stakeCalendar.lastSyncError, state.stakeCalendar.lastSyncOk ? 'success' : 'error');
      await renderAdminStake();
    } catch (e) {
      document.getElementById('stake-config-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
  document.getElementById('stake-config-sync-now').addEventListener('click', async () => {
    try {
      state.stakeCalendar = await api('/stake-calendar/sync', { method: 'POST' });
      toast(state.stakeCalendar.lastSyncOk ? 'Sincronizado' : 'No se pudo sincronizar: ' + state.stakeCalendar.lastSyncError, state.stakeCalendar.lastSyncOk ? 'success' : 'error');
      await renderAdminStake();
    } catch (e) {
      toast(e.message, 'error');
    }
  });
}

async function renderAdminRequests() {
  const content = document.getElementById('admin-content');
  let items;
  try { items = await api('/registration-requests'); } catch (e) { toast(e.message, 'error'); items = []; }
  content.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Nombre</th><th>Usuario</th><th>Perfil solicitado</th><th>Organización</th><th>Fecha</th><th></th></tr></thead>
      <tbody>
        ${items.length ? items.map((r) => `
          <tr>
            <td>${esc(r.name)}</td>
            <td>${esc(r.email)}</td>
            <td><span class="role-badge role-${r.requestedRole}">${ROLE_LABELS[r.requestedRole]}</span></td>
            <td>${esc(r.organizationName || '—')}</td>
            <td>${esc(fmtDateHuman(r.createdAt.slice(0, 10)))}</td>
            <td style="text-align:right; white-space:nowrap;">
              <button class="btn btn-primary btn-sm" data-approve="${r.id}">Aprobar</button>
              <button class="btn btn-danger btn-sm" data-reject="${r.id}">Rechazar</button>
            </td>
          </tr>`).join('') : `<tr><td colspan="6"><div class="empty-state">No hay solicitudes pendientes</div></td></tr>`}
      </tbody>
    </table>
  `;
  content.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', () => {
    openApproveModal(items.find((r) => r.id === Number(b.dataset.approve)));
  }));
  content.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('¿Rechazar y eliminar esta solicitud?')) return;
    try { await api(`/registration-requests/${b.dataset.reject}`, { method: 'DELETE' }); toast('Solicitud rechazada'); renderAdminView(); }
    catch (e) { toast(e.message, 'error'); }
  }));
}

function openApproveModal(reqItem) {
  if (!reqItem) return;
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="ar-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>Aprobar solicitud</h3><button class="modal-close" id="ar-modal-close">×</button></div>
        <div class="modal-body">
          <div id="ar-error"></div>
          <form id="ar-form">
            <div class="field"><label>Nombre completo</label><input type="text" name="name" required value="${esc(reqItem.name)}" /></div>
            <div class="field"><label>Usuario</label><input type="text" value="${esc(reqItem.email)}" disabled /></div>
            <div class="field">
              <label>Perfil (puedes corregirlo antes de aprobar)</label>
              <select name="role" id="ar-role" required>
                <option value="admin" ${reqItem.requestedRole === 'admin' ? 'selected' : ''}>Administrador</option>
                <option value="leader" ${reqItem.requestedRole === 'leader' ? 'selected' : ''}>Líder</option>
                <option value="member" ${reqItem.requestedRole === 'member' ? 'selected' : ''}>Miembro</option>
              </select>
            </div>
            <div class="field" id="ar-org-field" style="${reqItem.requestedRole === 'leader' ? '' : 'display:none;'}">
              <label>Organización</label>
              <select name="organizationId">
                ${state.organizations.map((o) => `<option value="${o.id}" ${reqItem.requestedOrganizationId === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
              </select>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="ar-cancel">Cancelar</button>
            <button class="btn btn-primary" id="ar-save">Aprobar cuenta</button>
          </div>
        </div>
      </div>
    </div>`;
  document.getElementById('ar-modal-close').addEventListener('click', closeModal);
  document.getElementById('ar-cancel').addEventListener('click', closeModal);
  document.getElementById('ar-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'ar-modal-backdrop') closeModal(); });
  document.getElementById('ar-role').addEventListener('change', (e) => {
    document.getElementById('ar-org-field').style.display = e.target.value === 'leader' ? '' : 'none';
  });
  document.getElementById('ar-save').addEventListener('click', async () => {
    const form = document.getElementById('ar-form');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const body = { name: fd.get('name'), role: fd.get('role'), organizationId: fd.get('role') === 'leader' ? fd.get('organizationId') : null };
    try {
      await api(`/registration-requests/${reqItem.id}/approve`, { method: 'POST', body });
      closeModal();
      toast('Cuenta aprobada — ya puede ingresar con su usuario y contraseña');
      renderAdminView();
    } catch (e) {
      document.getElementById('ar-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
}

async function renderAdminUsers() {
  const content = document.getElementById('admin-content');
  let users;
  try { users = await api('/users'); } catch (e) { toast(e.message, 'error'); users = []; }
  state.adminUsers = users;
  content.innerHTML = `
    <div style="display:flex; justify-content:flex-end; margin-bottom:10px;">
      <button class="btn btn-primary btn-sm" id="user-new">+ Nuevo usuario</button>
    </div>
    <table class="data-table">
      <thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Organización</th><th></th></tr></thead>
      <tbody>
        ${users.map((u) => `
          <tr>
            <td>${esc(u.name)}</td>
            <td>${esc(u.email)}</td>
            <td><span class="role-badge role-${u.role}">${ROLE_LABELS[u.role]}</span></td>
            <td>${esc(u.organizationName || '—')}</td>
            <td style="text-align:right; white-space:nowrap;">
              <button class="btn btn-secondary btn-sm" data-edit-user="${u.id}">Editar</button>
              ${u.id !== state.user.id ? `<button class="btn btn-danger btn-sm" data-del-user="${u.id}">Eliminar</button>` : ''}
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;
  document.getElementById('user-new').addEventListener('click', () => openUserModal());
  content.querySelectorAll('[data-edit-user]').forEach((b) => b.addEventListener('click', () => openUserModal(users.find((u) => u.id === Number(b.dataset.editUser)))));
  content.querySelectorAll('[data-del-user]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('¿Eliminar este usuario?')) return;
    try { await api(`/users/${b.dataset.delUser}`, { method: 'DELETE' }); toast('Usuario eliminado'); renderAdminUsers(); }
    catch (e) { toast(e.message, 'error'); }
  }));
}

function openUserModal(existing = null) {
  const isEdit = !!existing;
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="u-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>${isEdit ? 'Editar usuario' : 'Nuevo usuario'}</h3><button class="modal-close" id="u-modal-close">×</button></div>
        <div class="modal-body">
          <div id="u-error"></div>
          <form id="u-form">
            <div class="field"><label>Nombre completo</label><input type="text" name="name" required value="${esc(existing?.name || '')}" /></div>
            <div class="field"><label>Usuario (nombre de acceso)</label><input type="text" name="email" required value="${esc(existing?.email || '')}" placeholder="ej: primaria.presidenta" /></div>
            <div class="hint-box" style="margin-top:-4px;">Puede ser un nombre simple, no necesita ser un correo real (ej: "sociedad.socorro"). Solo debe ser único entre todos los usuarios.</div>
            <div class="field"><label>Contraseña ${isEdit ? '(dejar vacío para no cambiar)' : ''}</label><input type="password" name="password" ${isEdit ? '' : 'required'} /></div>
            <div class="field">
              <label>Rol</label>
              <select name="role" id="u-role" required>
                <option value="admin" ${existing?.role === 'admin' ? 'selected' : ''}>Administrador (edita todo y los perfiles)</option>
                <option value="leader" ${existing?.role === 'leader' ? 'selected' : ''}>Líder (edita actividades y entrevistas de su organización)</option>
                <option value="member" ${existing?.role === 'member' ? 'selected' : ''}>Miembro (solo consulta)</option>
              </select>
            </div>
            <div class="field" id="u-org-field">
              <label>Organización</label>
              <select name="organizationId">
                <option value="">— Ninguna —</option>
                ${state.organizations.map((o) => `<option value="${o.id}" ${existing?.organizationId === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>Teléfono (opcional)</label><input type="text" name="phone" value="${esc(existing?.phone || '')}" /></div>
          </form>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="u-cancel">Cancelar</button>
            <button class="btn btn-primary" id="u-save">${isEdit ? 'Guardar cambios' : 'Crear usuario'}</button>
          </div>
        </div>
      </div>
    </div>`;
  document.getElementById('u-modal-close').addEventListener('click', closeModal);
  document.getElementById('u-cancel').addEventListener('click', closeModal);
  document.getElementById('u-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'u-modal-backdrop') closeModal(); });
  document.getElementById('u-save').addEventListener('click', async () => {
    const form = document.getElementById('u-form');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const body = Object.fromEntries(fd.entries());
    if (!body.password) delete body.password;
    if (!body.organizationId) body.organizationId = null;
    try {
      if (isEdit) await api(`/users/${existing.id}`, { method: 'PUT', body });
      else await api('/users', { method: 'POST', body });
      closeModal();
      toast(isEdit ? 'Usuario actualizado' : 'Usuario creado');
      renderAdminUsers();
    } catch (e) {
      document.getElementById('u-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
}

async function renderAdminOrgs() {
  const content = document.getElementById('admin-content');
  content.innerHTML = `
    <div style="display:flex; justify-content:flex-end; margin-bottom:10px;">
      <button class="btn btn-primary btn-sm" id="org-new">+ Nueva organización</button>
    </div>
    <table class="data-table">
      <thead><tr><th>Color</th><th>Organización</th><th>Agenda entrevistas</th><th></th></tr></thead>
      <tbody>
        ${state.organizations.map((o) => `
          <tr>
            <td><span class="org-dot" style="background:${o.color}; display:inline-block;"></span></td>
            <td>${esc(o.name)}</td>
            <td>${o.allowsInterviews ? 'Sí' : 'No'}</td>
            <td style="text-align:right;"><button class="btn btn-secondary btn-sm" data-edit-org="${o.id}">Editar</button></td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;
  document.getElementById('org-new').addEventListener('click', () => openOrgModal());
  content.querySelectorAll('[data-edit-org]').forEach((b) => b.addEventListener('click', () => openOrgModal(orgById(b.dataset.editOrg))));
}

function openOrgModal(existing = null) {
  const isEdit = !!existing;
  let selectedColor = existing?.color || COLOR_PALETTE[0];
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="org-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>${isEdit ? 'Editar organización' : 'Nueva organización'}</h3><button class="modal-close" id="org-modal-close">×</button></div>
        <div class="modal-body">
          <div id="org-error"></div>
          <form id="org-form">
            <div class="field"><label>Nombre</label><input type="text" name="name" required value="${esc(existing?.name || '')}" /></div>
            <div class="field">
              <label>Color distintivo</label>
              <div class="color-swatches" id="org-swatches">
                ${COLOR_PALETTE.map((c) => `<div class="color-swatch ${c === selectedColor ? 'selected' : ''}" style="background:${c}" data-color="${c}"></div>`).join('')}
              </div>
              <input type="hidden" name="color" id="org-color-input" value="${selectedColor}" />
            </div>
            <div class="field">
              <label style="display:flex; align-items:center; gap:8px; font-weight:600;">
                <input type="checkbox" name="allowsInterviews" style="width:auto;" ${existing?.allowsInterviews ? 'checked' : ''} />
                Esta organización agenda entrevistas
              </label>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <div>${isEdit ? `<button class="btn btn-danger" id="org-delete">Eliminar</button>` : ''}</div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="org-cancel">Cancelar</button>
            <button class="btn btn-primary" id="org-save">${isEdit ? 'Guardar cambios' : 'Crear'}</button>
          </div>
        </div>
      </div>
    </div>`;
  document.getElementById('org-modal-close').addEventListener('click', closeModal);
  document.getElementById('org-cancel').addEventListener('click', closeModal);
  document.getElementById('org-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'org-modal-backdrop') closeModal(); });
  document.getElementById('org-swatches').querySelectorAll('.color-swatch').forEach((sw) => sw.addEventListener('click', () => {
    document.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
    sw.classList.add('selected');
    document.getElementById('org-color-input').value = sw.dataset.color;
  }));
  if (isEdit) document.getElementById('org-delete').addEventListener('click', async () => {
    if (!confirm('¿Eliminar esta organización? Esto no elimina sus actividades existentes.')) return;
    try { await api(`/organizations/${existing.id}`, { method: 'DELETE' }); closeModal(); toast('Organización eliminada'); state.organizations = await api('/organizations'); renderAdminOrgs(); }
    catch (e) { toast(e.message, 'error'); }
  });
  document.getElementById('org-save').addEventListener('click', async () => {
    const form = document.getElementById('org-form');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const body = { name: fd.get('name'), color: fd.get('color'), allowsInterviews: fd.get('allowsInterviews') === 'on' };
    try {
      if (isEdit) await api(`/organizations/${existing.id}`, { method: 'PUT', body });
      else await api('/organizations', { method: 'POST', body });
      closeModal();
      toast(isEdit ? 'Organización actualizada' : 'Organización creada');
      state.organizations = await api('/organizations');
      renderAdminOrgs();
    } catch (e) {
      document.getElementById('org-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
}

// ==================================================================
// ---------------- Reuniones y Asignaciones ----------------
// ==================================================================
// "Mis Asignaciones": panel personal de compromisos pendientes/atrasados.
// "Reuniones": actas — crear, agregar compromisos, ver detalle y archivar
// ("Verificar y Archivar" cierra el acta; los compromisos que sigan
// pendientes quedan documentados como "no cumplida" en el historial).

async function renderMeetingsView() {
  const container = document.getElementById('view-root');
  container.innerHTML = `
    <div class="section-header"><div><h2>Reuniones y Asignaciones</h2><p>Actas de reuniones, compromisos y tus propias asignaciones pendientes</p></div></div>
    <div class="subtabs">
      <button class="subtab-btn ${state.meetingsSubtab === 'mine' ? 'active' : ''}" data-tab="mine">Mis Asignaciones</button>
      <button class="subtab-btn ${state.meetingsSubtab === 'manage' ? 'active' : ''}" data-tab="manage">Reuniones</button>
    </div>
    <div id="meetings-content"></div>
  `;
  container.querySelectorAll('.subtab-btn').forEach((b) => b.addEventListener('click', () => { state.meetingsSubtab = b.dataset.tab; renderMeetingsView(); }));
  if (state.meetingsSubtab === 'mine') await renderMyAssignments();
  else await renderMeetingsManage();
}

async function renderMyAssignments() {
  const content = document.getElementById('meetings-content');
  content.innerHTML = '<div class="empty-state">Cargando…</div>';
  let data;
  try { data = await api('/my-assignments'); }
  catch (e) { toast(e.message, 'error'); content.innerHTML = '<div class="empty-state">No se pudo cargar</div>'; return; }
  content.innerHTML = data.commitments.length
    ? `<div class="card-list">${data.commitments.map(assignmentCardHtml).join('')}</div>`
    : '<div class="empty-state">No tienes compromisos pendientes 🎉</div>';
  wireAssignmentCards();
}

function assignmentCardHtml(c) {
  const isOverdue = c.displayStatus === 'overdue';
  return `
    <div class="list-card assignment-card" data-id="${c.id}" style="align-items:flex-start; flex-direction:column; gap:8px;">
      <div style="display:flex; justify-content:space-between; width:100%; gap:10px; align-items:flex-start;">
        <div class="lc-main">
          <div class="lc-title">${esc(c.description)}</div>
          <div class="lc-sub">${esc(c.meetingTitle)} · vence ${esc(fmtDateHuman(c.dueDate))}</div>
        </div>
        <span class="status-pill ${isOverdue ? 'status-red' : 'status-amber'}">${isOverdue ? 'Atrasado' : 'Pendiente'}</span>
      </div>
      <div>
        <button type="button" class="btn btn-secondary btn-sm assignment-complete-toggle">✅ Completar</button>
      </div>
      <div class="assignment-complete-form" style="display:none; width:100%;">
        <textarea class="assignment-comment" placeholder="Comentario breve (opcional)" rows="2" style="width:100%; margin-bottom:8px;"></textarea>
        <button type="button" class="btn btn-primary btn-sm assignment-complete-save">Guardar</button>
      </div>
    </div>`;
}

function wireAssignmentCards() {
  document.querySelectorAll('.assignment-card').forEach((card) => {
    const id = Number(card.dataset.id);
    const form = card.querySelector('.assignment-complete-form');
    card.querySelector('.assignment-complete-toggle').addEventListener('click', () => {
      form.style.display = form.style.display === 'none' ? '' : 'none';
    });
    card.querySelector('.assignment-complete-save').addEventListener('click', async (e) => {
      const btn = e.target;
      btn.disabled = true;
      const comment = card.querySelector('.assignment-comment').value.trim();
      try {
        await api(`/commitments/${id}/complete`, { method: 'PUT', body: { comment } });
        toast('Compromiso completado');
        await renderMyAssignments();
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    });
  });
}

async function renderMeetingsManage() {
  const content = document.getElementById('meetings-content');
  content.innerHTML = '<div class="empty-state">Cargando…</div>';
  let meetings;
  try { meetings = await api('/meetings'); }
  catch (e) { toast(e.message, 'error'); content.innerHTML = '<div class="empty-state">No se pudo cargar</div>'; return; }
  const active = meetings.filter((m) => m.status === 'active');
  const archived = meetings.filter((m) => m.status === 'archived');
  content.innerHTML = `
    <div style="display:flex; justify-content:flex-end; margin-bottom:12px;">
      <button class="btn btn-primary" id="meeting-new">+ Nueva acta</button>
    </div>
    <div class="card-list">
      ${active.length ? active.map((m) => meetingCardHtml(m)).join('') : '<div class="empty-state">No hay actas activas</div>'}
    </div>
    ${archived.length ? `
      <div style="margin-top:22px;">
        <h3 style="font-size:14px; color:var(--celeste-darker); margin-bottom:8px;">📁 Reuniones Pasadas</h3>
        <div class="card-list">${archived.map((m) => meetingCardHtml(m)).join('')}</div>
      </div>` : ''}
  `;
  document.getElementById('meeting-new').addEventListener('click', () => openMeetingModal());
  wireMeetingCards(meetings);
}

function meetingCardHtml(m) {
  const done = m.commitments.filter((c) => c.status === 'completed').length;
  const total = m.commitments.length;
  return `
    <div class="list-card meeting-card" data-id="${m.id}" style="cursor:pointer;">
      <div class="lc-main">
        <div class="lc-title">${esc(m.title)}${m.status === 'archived' ? ' <span style="font-weight:400; font-size:12px; color:var(--ink-soft);">(archivada)</span>' : ''}</div>
        <div class="lc-sub">${esc(m.organizationName)} · ${esc(fmtDateHuman(m.date))} · ${done}/${total} compromiso${total === 1 ? '' : 's'} completado${total === 1 ? '' : 's'}</div>
      </div>
    </div>`;
}

function wireMeetingCards(meetings) {
  document.querySelectorAll('.meeting-card').forEach((card) => {
    card.addEventListener('click', () => {
      const m = meetings.find((x) => x.id === Number(card.dataset.id));
      if (m) openMeetingDetailModal(m);
    });
  });
}

function commitmentStatusPillHtml(c) {
  const map = {
    pending: ['status-amber', 'Pendiente'],
    overdue: ['status-red', 'Atrasado'],
    completed: ['status-green', 'Completado'],
    not_fulfilled: ['status-gray', 'No cumplida'],
  };
  const [cls, label] = map[c.displayStatus] || ['status-gray', c.status];
  return `<span class="status-pill ${cls}">${label}</span>`;
}

async function openMeetingModal() {
  let assignable;
  try { assignable = await api('/meetings/assignable-users'); }
  catch (e) { toast(e.message, 'error'); return; }
  if (!assignable.length) { toast('No hay líderes disponibles para asignar compromisos todavía', 'error'); return; }

  const commitmentRowHtml = () => `
    <div class="commitment-row">
      <div class="field" style="margin-bottom:8px;">
        <label>Compromiso</label>
        <input type="text" class="cr-desc" required placeholder="Ej: Coordinar transporte" />
      </div>
      <div class="two-col">
        <div class="field">
          <label>Responsable</label>
          <select class="cr-assignee" required>
            <option value="" disabled selected>Elegir…</option>
            ${assignable.map((u) => `<option value="${u.id}">${esc(u.name)}${u.role === 'admin' ? ' (Administrador)' : ''}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Fecha límite / verificación</label>
          <input type="date" class="cr-due" required />
        </div>
      </div>
      <button type="button" class="btn btn-ghost btn-sm cr-remove">🗑️ Quitar compromiso</button>
    </div>`;

  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="mt-modal-backdrop">
      <div class="modal" style="max-width:560px;">
        <div class="modal-header"><h3>Nueva acta</h3><button class="modal-close" id="mt-modal-close">×</button></div>
        <div class="modal-body">
          <div id="mt-error"></div>
          <form id="mt-form">
            <div class="field">
              <label>Título del acta</label>
              <input type="text" name="title" required placeholder="Ej: Consejo de Barrio" />
            </div>
            <div class="field">
              <label>Fecha de la reunión</label>
              <input type="date" name="date" required value="${toISODate(new Date())}" />
            </div>
            <div class="field">
              <label>Compromisos (opcional — también se pueden agregar después)</label>
              <div id="mt-commitments"></div>
              <button type="button" class="btn btn-secondary btn-sm" id="mt-add-commitment">+ Agregar compromiso</button>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="mt-cancel">Cancelar</button>
            <button class="btn btn-primary" id="mt-save">Crear acta</button>
          </div>
        </div>
      </div>
    </div>`;

  const commitmentsBox = document.getElementById('mt-commitments');
  const wireRow = (row) => {
    row.querySelector('.cr-remove').addEventListener('click', () => row.remove());
  };
  const addRow = () => {
    commitmentsBox.insertAdjacentHTML('beforeend', commitmentRowHtml());
    wireRow(commitmentsBox.lastElementChild);
  };
  document.getElementById('mt-add-commitment').addEventListener('click', addRow);
  addRow();

  document.getElementById('mt-modal-close').addEventListener('click', closeModal);
  document.getElementById('mt-cancel').addEventListener('click', closeModal);
  document.getElementById('mt-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'mt-modal-backdrop') closeModal(); });

  document.getElementById('mt-save').addEventListener('click', async () => {
    const form = document.getElementById('mt-form');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const commitments = Array.from(document.querySelectorAll('#mt-commitments .commitment-row'))
      .map((row) => ({
        description: row.querySelector('.cr-desc').value.trim(),
        assignedToUserId: Number(row.querySelector('.cr-assignee').value),
        dueDate: row.querySelector('.cr-due').value,
      }))
      .filter((c) => c.description);
    try {
      await api('/meetings', { method: 'POST', body: { title: fd.get('title'), date: fd.get('date'), commitments } });
      closeModal();
      toast('Acta creada');
      await renderMeetingsManage();
    } catch (e) {
      document.getElementById('mt-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
}

async function openMeetingDetailModal(m) {
  const canEdit = (state.user.role === 'admin' || Number(state.user.id) === Number(m.createdBy)) && m.status === 'active';
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="md-modal-backdrop">
      <div class="modal" style="max-width:560px;">
        <div class="modal-header"><h3>${esc(m.title)}</h3><button class="modal-close" id="md-modal-close">×</button></div>
        <div class="modal-body">
          <div class="hint-box" style="margin-top:0;">${esc(m.organizationName)} · ${esc(fmtDateHuman(m.date))} · Creada por ${esc(m.createdByName)}${m.status === 'archived' ? ' · 📁 Archivada' : ''}</div>
          <div id="md-commitments">
            ${m.commitments.length ? m.commitments.map((c) => `
              <div class="commitment-detail-row">
                <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
                  <div style="min-width:0;">
                    <div style="font-weight:600; font-size:13.5px;">${esc(c.description)}</div>
                    <div style="font-size:12px; color:var(--ink-soft); margin-top:2px;">Responsable: ${esc(c.assignedToName)} · vence ${esc(fmtDateHuman(c.dueDate))}</div>
                    ${c.status === 'completed' && c.completionComment ? `<div style="font-size:12px; color:var(--ink-soft); margin-top:4px; font-style:italic;">💬 "${esc(c.completionComment)}"</div>` : ''}
                  </div>
                  ${commitmentStatusPillHtml(c)}
                </div>
              </div>`).join('') : '<div class="empty-state">Sin compromisos todavía</div>'}
          </div>
          ${canEdit ? `<div style="margin-top:14px;"><button type="button" class="btn btn-secondary btn-sm" id="md-add-commitment">+ Agregar compromiso</button></div>` : ''}
        </div>
        <div class="modal-footer">
          <div>${canEdit ? `<button class="btn btn-danger" id="md-archive">✅ Verificar y Archivar</button>` : ''}</div>
          <div><button class="btn btn-secondary" id="md-close">Cerrar</button></div>
        </div>
      </div>
    </div>`;
  document.getElementById('md-modal-close').addEventListener('click', closeModal);
  document.getElementById('md-close').addEventListener('click', closeModal);
  document.getElementById('md-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'md-modal-backdrop') closeModal(); });
  if (canEdit) {
    document.getElementById('md-add-commitment').addEventListener('click', () => openAddCommitmentModal(m));
    document.getElementById('md-archive').addEventListener('click', async () => {
      if (!confirm('¿Verificar y archivar esta acta? Los compromisos que sigan pendientes quedarán documentados como "no cumplida" y ya no aparecerán en "Mis Asignaciones" de nadie.')) return;
      try {
        await api(`/meetings/${m.id}/archive`, { method: 'PUT' });
        closeModal();
        toast('Acta archivada');
        await renderMeetingsManage();
      } catch (e) { toast(e.message, 'error'); }
    });
  }
}

async function openAddCommitmentModal(m) {
  let assignable;
  try { assignable = await api('/meetings/assignable-users'); }
  catch (e) { toast(e.message, 'error'); return; }
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="ac-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>Agregar compromiso</h3><button class="modal-close" id="ac-modal-close">×</button></div>
        <div class="modal-body">
          <div id="ac-error"></div>
          <form id="ac-form">
            <div class="field"><label>Compromiso</label><input type="text" name="description" required placeholder="Ej: Coordinar transporte" /></div>
            <div class="field">
              <label>Responsable</label>
              <select name="assignedToUserId" required>
                <option value="" disabled selected>Elegir…</option>
                ${assignable.map((u) => `<option value="${u.id}">${esc(u.name)}${u.role === 'admin' ? ' (Administrador)' : ''}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>Fecha límite / verificación</label><input type="date" name="dueDate" required /></div>
          </form>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="ac-cancel">Cancelar</button>
            <button class="btn btn-primary" id="ac-save">Agregar</button>
          </div>
        </div>
      </div>
    </div>`;
  document.getElementById('ac-modal-close').addEventListener('click', closeModal);
  document.getElementById('ac-cancel').addEventListener('click', closeModal);
  document.getElementById('ac-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'ac-modal-backdrop') closeModal(); });
  document.getElementById('ac-save').addEventListener('click', async () => {
    const form = document.getElementById('ac-form');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    try {
      const updated = await api(`/meetings/${m.id}/commitments`, { method: 'POST', body: Object.fromEntries(fd.entries()) });
      closeModal();
      toast('Compromiso agregado');
      openMeetingDetailModal(updated);
    } catch (e) {
      document.getElementById('ac-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
}

// ==================================================================
// ---------------- Aseo del Edificio ----------------
// ==================================================================
// Estrictamente oculto salvo Administrador o líder de Obispado (ver
// canSeeCleaningTab). Turnos de aseo de los sábados asignados a una
// familia, con autocompletado (y creación automática la primera vez que se
// escribe un nombre nuevo) más estadística histórica en vivo.

async function renderCleaningView() {
  const container = document.getElementById('view-root');
  container.innerHTML = `<div class="section-header"><div><h2>Aseo del Edificio</h2><p>Cargando…</p></div></div>`;
  let shifts;
  try { shifts = await api('/cleaning/shifts'); }
  catch (e) { toast(e.message, 'error'); container.innerHTML = '<div class="empty-state">No se pudo cargar</div>'; return; }
  // Un turno es una fecha (el sábado de aseo) con una o varias familias
  // asignadas ese mismo día — se agrupa acá por fecha para que el listado
  // muestre una tarjeta por sábado, no una fila por cada familia.
  const byDate = new Map();
  shifts.forEach((s) => { if (!byDate.has(s.date)) byDate.set(s.date, []); byDate.get(s.date).push(s); });
  const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));
  container.innerHTML = `
    <div class="section-header">
      <div><h2>Aseo del Edificio</h2><p>Turnos de aseo de los sábados — cada turno puede tener una o varias familias asignadas</p></div>
      <button class="btn btn-primary" id="cs-new">+ Nuevo turno</button>
    </div>
    <div class="card-list">
      ${dates.length ? dates.map((d) => cleaningDateCardHtml(d, byDate.get(d))).join('') : '<div class="empty-state">Todavía no hay turnos asignados</div>'}
    </div>
  `;
  document.getElementById('cs-new').addEventListener('click', () => openCleaningShiftModal());
  wireCleaningShiftCards();
}

function cleaningStatusPillHtml(status) {
  if (status === 'done') return `<span class="status-pill status-green">✅ Sí fue</span>`;
  if (status === 'not_done') return `<span class="status-pill status-red">❌ No fue</span>`;
  return `<span class="status-pill status-amber">Por confirmar</span>`;
}

function cleaningDateCardHtml(date, entries) {
  return `
    <div class="list-card cleaning-date-card">
      <div class="lc-main" style="width:100%;">
        <div class="lc-title">🧹 ${esc(fmtDateHuman(date))}</div>
        <div class="cleaning-family-rows">
          ${entries.map(cleaningFamilyRowHtml).join('')}
        </div>
        <button type="button" class="btn btn-secondary btn-sm cs-add-family" data-date="${esc(date)}" style="margin-top:10px;">+ Agregar familia a este turno</button>
      </div>
    </div>`;
}

function cleaningFamilyRowHtml(s) {
  return `
    <div class="cleaning-family-row" data-id="${s.id}">
      <div class="cfr-main">
        <div class="cfr-name">${esc(s.familyName)}</div>
        <div class="cfr-sub">${s.timesDone} vez${s.timesDone === 1 ? '' : 'es'} en total${s.lastDoneDate ? ' · última vez ' + esc(fmtDateHuman(s.lastDoneDate)) : ''}</div>
      </div>
      ${cleaningStatusPillHtml(s.status)}
      <div class="cfr-actions">
        <button type="button" class="btn btn-ghost btn-sm cs-mark" data-status="done" title="Sí fue">✅</button>
        <button type="button" class="btn btn-ghost btn-sm cs-mark" data-status="not_done" title="No fue">❌</button>
        <button type="button" class="btn btn-ghost btn-sm cs-remove" title="Quitar del turno">🗑️</button>
      </div>
    </div>`;
}

function wireCleaningShiftCards() {
  document.querySelectorAll('.cleaning-family-row').forEach((row) => {
    const id = Number(row.dataset.id);
    row.querySelectorAll('.cs-mark').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/cleaning/shifts/${id}/mark`, { method: 'PUT', body: { status: btn.dataset.status } });
          toast('Turno actualizado');
          await renderCleaningView();
        } catch (e) { toast(e.message, 'error'); }
      });
    });
    row.querySelector('.cs-remove').addEventListener('click', async () => {
      if (!confirm('¿Quitar esta familia del turno?')) return;
      try {
        await api(`/cleaning/shifts/${id}`, { method: 'DELETE' });
        toast('Familia quitada del turno');
        await renderCleaningView();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
  document.querySelectorAll('.cs-add-family').forEach((btn) => {
    btn.addEventListener('click', () => openCleaningShiftModal(btn.dataset.date));
  });
}

// presetDate: si viene con valor, el modal funciona en modo "agregar
// familia a un turno que ya existe" (fecha fija, no editable); si no,
// funciona en modo "turno nuevo" (se elige la fecha, y se le pueden
// agregar de una varias familias con "+ Agregar otra familia" — así el
// turno de un sábado puede quedar con más de una familia sin tener que
// crear un turno aparte por cada una).
async function openCleaningShiftModal(presetDate) {
  let families;
  try { families = await api('/cleaning/families'); } catch (e) { families = []; }
  const isAdd = !!presetDate;
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="cs-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>${isAdd ? 'Agregar familia al turno' : 'Nuevo turno de aseo'}</h3><button class="modal-close" id="cs-modal-close">×</button></div>
        <div class="modal-body">
          <div id="cs-error"></div>
          <form id="cs-form">
            <div class="field">
              <label>Sábado de aseo</label>
              <input type="date" name="date" required value="${esc(presetDate || '')}" ${isAdd ? 'readonly' : ''} />
            </div>
            <div class="field">
              <label>Familias</label>
              <div id="cs-family-rows"></div>
              <button type="button" class="btn btn-secondary btn-sm" id="cs-add-row">+ Agregar otra familia</button>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="cs-cancel">Cancelar</button>
            <button class="btn btn-primary" id="cs-save">${isAdd ? 'Agregar' : 'Crear turno'}</button>
          </div>
        </div>
      </div>
    </div>`;
  document.getElementById('cs-modal-close').addEventListener('click', closeModal);
  document.getElementById('cs-cancel').addEventListener('click', closeModal);
  document.getElementById('cs-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'cs-modal-backdrop') closeModal(); });

  const familyRowHtml = () => `
    <div class="family-row">
      <div style="display:flex; gap:8px; align-items:flex-start;">
        <div style="flex:1; position:relative;">
          <input type="text" class="fr-name" required autocomplete="off" placeholder="Ej: Familia Pino" />
          <div class="fr-results" style="display:none; position:absolute; left:0; right:0; z-index:30; background:#fff; border:1px solid var(--border); border-radius:8px; margin-top:2px; max-height:200px; overflow-y:auto; box-shadow:0 6px 20px rgba(0,0,0,.12);"></div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm fr-remove" title="Quitar esta familia">🗑️</button>
      </div>
      <div class="fr-stats hint-box" style="margin-top:6px; display:none;"></div>
    </div>`;

  const wireFamilyRow = (row) => {
    const nameInput = row.querySelector('.fr-name');
    const resultsBox = row.querySelector('.fr-results');
    const statsBox = row.querySelector('.fr-stats');
    const showStatsFor = (family) => {
      if (!family) { statsBox.style.display = 'none'; return; }
      statsBox.style.display = '';
      statsBox.textContent = family.timesDone > 0
        ? `Ha ido ${family.timesDone} ${family.timesDone === 1 ? 'vez' : 'veces'} · Última vez: ${fmtDateHuman(family.lastDoneDate)}`
        : 'Nunca ha participado';
    };
    nameInput.addEventListener('input', () => {
      const q = normalizeSearchText(nameInput.value);
      if (!q) { resultsBox.style.display = 'none'; resultsBox.innerHTML = ''; statsBox.style.display = 'none'; return; }
      const matches = families.filter((f) => normalizeSearchText(f.name).includes(q)).slice(0, 8);
      const exact = families.find((f) => normalizeSearchText(f.name) === q);
      // Si no hay coincidencia exacta todavía, es una familia nueva — nunca
      // participó, por definición (recién se va a crear al guardar el turno).
      showStatsFor(exact || { timesDone: 0, lastDoneDate: null });
      if (!matches.length) { resultsBox.style.display = 'none'; resultsBox.innerHTML = ''; return; }
      resultsBox.innerHTML = matches.map((f) => `<div class="ac-item" data-id="${f.id}" style="padding:8px 10px; cursor:pointer; font-size:13.5px;">${esc(f.name)}</div>`).join('');
      resultsBox.style.display = '';
      resultsBox.querySelectorAll('.ac-item').forEach((el) => {
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const f = families.find((x) => String(x.id) === el.dataset.id);
          if (f) { nameInput.value = f.name; showStatsFor(f); resultsBox.style.display = 'none'; }
        });
      });
    });
    nameInput.addEventListener('blur', () => setTimeout(() => { resultsBox.style.display = 'none'; }, 150));
    row.querySelector('.fr-remove').addEventListener('click', () => {
      const box = row.parentElement;
      if (box.children.length > 1) row.remove(); // siempre queda al menos una fila
    });
  };

  const rowsBox = document.getElementById('cs-family-rows');
  const addRow = () => {
    rowsBox.insertAdjacentHTML('beforeend', familyRowHtml());
    wireFamilyRow(rowsBox.lastElementChild);
  };
  document.getElementById('cs-add-row').addEventListener('click', addRow);
  addRow();

  document.getElementById('cs-save').addEventListener('click', async () => {
    const form = document.getElementById('cs-form');
    if (!form.reportValidity()) return;
    const names = Array.from(rowsBox.querySelectorAll('.fr-name')).map((i) => i.value.trim()).filter(Boolean);
    if (!names.length) { document.getElementById('cs-error').innerHTML = '<div class="error-msg">Agrega al menos una familia</div>'; return; }
    try {
      await api('/cleaning/shifts', { method: 'POST', body: { date: form.date.value, families: names } });
      closeModal();
      toast(isAdd ? 'Familia agregada al turno' : 'Turno creado');
      await renderCleaningView();
    } catch (e) {
      document.getElementById('cs-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
}

// ==================================================================
// ---------------- Estadísticas ----------------
// ==================================================================
// "Bandeja de Evaluación": actividades propias ya pasadas sin evaluar.
// "Panel de Control": balance del año por Propósito, % de éxito de
// asistencia, y ranking de la actividad más y menos exitosa.

async function renderStatsView() {
  const container = document.getElementById('view-root');
  container.innerHTML = `
    <div class="section-header"><div><h2>Estadísticas</h2><p>Evalúa tus actividades pasadas y revisa el resumen del año</p></div></div>
    <div class="subtabs">
      <button class="subtab-btn ${state.statsSubtab === 'pending' ? 'active' : ''}" data-tab="pending">Bandeja de Evaluación</button>
      <button class="subtab-btn ${state.statsSubtab === 'dashboard' ? 'active' : ''}" data-tab="dashboard">Panel de Control</button>
    </div>
    <div id="stats-content"></div>
  `;
  container.querySelectorAll('.subtab-btn').forEach((b) => b.addEventListener('click', () => { state.statsSubtab = b.dataset.tab; renderStatsView(); }));
  if (state.statsSubtab === 'pending') await renderStatsPending();
  else await renderStatsDashboard();
}

async function renderStatsPending() {
  const content = document.getElementById('stats-content');
  content.innerHTML = '<div class="empty-state">Cargando…</div>';
  let items;
  try { items = await api('/stats/pending-evaluations'); }
  catch (e) { toast(e.message, 'error'); content.innerHTML = '<div class="empty-state">No se pudo cargar</div>'; return; }
  content.innerHTML = items.length
    ? `<div class="card-list">${items.map(pendingEvalCardHtml).join('')}</div>`
    : '<div class="empty-state">No hay actividades pendientes de evaluar 🎉</div>';
  content.querySelectorAll('.pe-evaluate').forEach((btn) => {
    const ev = items.find((e) => e.id === Number(btn.dataset.id));
    if (ev) btn.addEventListener('click', () => openEvaluationModal(ev));
  });
}

function pendingEvalCardHtml(ev) {
  return `
    <div class="list-card">
      <span class="org-dot" style="background:${ev.organizationColor}"></span>
      <div class="lc-main">
        <div class="lc-title">${esc(ev.title)}</div>
        <div class="lc-sub">${esc(ev.organizationName)} · ${esc(fmtDateHuman(ev.date))}${ev.purpose ? ' · ' + esc(ev.purpose) : ''}</div>
      </div>
      <button type="button" class="btn btn-primary btn-sm pe-evaluate" data-id="${ev.id}">Evaluar</button>
    </div>`;
}

async function openEvaluationModal(ev) {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="pe-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>Evaluar — ${esc(ev.title)}</h3><button class="modal-close" id="pe-modal-close">×</button></div>
        <div class="modal-body">
          <div id="pe-error"></div>
          <form id="pe-form">
            <div class="two-col">
              <div class="field"><label>Asistencia esperada</label><input type="number" name="expectedAttendance" min="0" step="1" required /></div>
              <div class="field"><label>Asistencia real</label><input type="number" name="actualAttendance" min="0" step="1" required /></div>
            </div>
            <div class="field"><label>Feedback</label><textarea name="feedback" placeholder="¿Cómo resultó la actividad?"></textarea></div>
          </form>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="pe-cancel">Cancelar</button>
            <button class="btn btn-primary" id="pe-save">Guardar evaluación</button>
          </div>
        </div>
      </div>
    </div>`;
  document.getElementById('pe-modal-close').addEventListener('click', closeModal);
  document.getElementById('pe-cancel').addEventListener('click', closeModal);
  document.getElementById('pe-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'pe-modal-backdrop') closeModal(); });
  document.getElementById('pe-save').addEventListener('click', async () => {
    const form = document.getElementById('pe-form');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    try {
      await api('/stats/evaluations', { method: 'POST', body: { eventId: ev.id, expectedAttendance: fd.get('expectedAttendance'), actualAttendance: fd.get('actualAttendance'), feedback: fd.get('feedback') } });
      closeModal();
      toast('Evaluación guardada');
      await renderStatsPending();
    } catch (e) {
      document.getElementById('pe-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
}

async function renderStatsDashboard() {
  const content = document.getElementById('stats-content');
  content.innerHTML = '<div class="empty-state">Cargando…</div>';
  const params = [];
  if (state.statsYear) params.push(`year=${state.statsYear}`);
  if (state.user.role === 'admin' && state.statsOrgId) params.push(`organizationId=${state.statsOrgId}`);
  let data;
  try { data = await api(`/stats/dashboard${params.length ? '?' + params.join('&') : ''}`); }
  catch (e) { toast(e.message, 'error'); content.innerHTML = '<div class="empty-state">No se pudo cargar</div>'; return; }
  state.statsYear = data.year;
  const purposeEntries = Object.entries(data.purposeBalance);
  const maxCount = Math.max(1, ...purposeEntries.map(([, v]) => v));
  content.innerHTML = `
    <div style="display:flex; justify-content:flex-end; gap:8px; margin-bottom:16px; flex-wrap:wrap;">
      ${data.canPickOrganization ? `
        <select id="stats-org-select">
          <option value="">Todo el Barrio</option>
          ${state.organizations.map((o) => `<option value="${o.id}" ${String(data.organizationId) === String(o.id) ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
        </select>` : ''}
      <select id="stats-year-select">
        ${data.years.map((y) => `<option value="${y}" ${y === data.year ? 'selected' : ''}>${y}</option>`).join('')}
      </select>
    </div>
    <div class="stats-cards">
      <div class="stat-card">
        <div class="stat-card-label">Actividades evaluadas</div>
        <div class="stat-card-value">${data.evaluatedCount} <span style="font-size:13px; font-weight:400; color:var(--ink-soft);">de ${data.totalActivitiesInYear}</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">% de éxito de asistencia</div>
        <div class="stat-card-value">${data.overallSuccessPct !== null ? data.overallSuccessPct + '%' : '—'}</div>
      </div>
    </div>
    <div class="hint-box" style="margin-top:18px; margin-bottom:0;"><strong>Balance del año por Propósito</strong></div>
    <div class="purpose-balance">
      ${purposeEntries.map(([p, v]) => `
        <div class="purpose-row">
          <span class="purpose-label">${esc(p)}</span>
          <div class="purpose-bar-wrap"><div class="purpose-bar" style="width:${(v / maxCount) * 100}%;"></div></div>
          <span class="purpose-count">${v}</span>
        </div>`).join('')}
    </div>
    <div class="ranking-row">
      <div class="ranking-card ranking-top">
        <div class="ranking-label">🏆 Más exitosa</div>
        ${data.topActivity ? `<div class="ranking-title">${esc(data.topActivity.title)}</div><div class="ranking-sub">${esc(fmtDateHuman(data.topActivity.date))} · ${data.topActivity.pct}% (${data.topActivity.actualAttendance}/${data.topActivity.expectedAttendance})</div>` : '<div class="ranking-sub">Sin datos suficientes</div>'}
      </div>
      <div class="ranking-card ranking-bottom">
        <div class="ranking-label">📉 Menos exitosa</div>
        ${data.bottomActivity ? `<div class="ranking-title">${esc(data.bottomActivity.title)}</div><div class="ranking-sub">${esc(fmtDateHuman(data.bottomActivity.date))} · ${data.bottomActivity.pct}% (${data.bottomActivity.actualAttendance}/${data.bottomActivity.expectedAttendance})</div>` : '<div class="ranking-sub">Sin datos suficientes</div>'}
      </div>
    </div>
  `;
  document.getElementById('stats-year-select').addEventListener('change', (e) => { state.statsYear = Number(e.target.value); renderStatsDashboard(); });
  const orgSelect = document.getElementById('stats-org-select');
  if (orgSelect) orgSelect.addEventListener('change', (e) => { state.statsOrgId = e.target.value || null; renderStatsDashboard(); });
}

// ==================================================================
// ---------------- Panel de Obispado ----------------
// ==================================================================
// Resumen de una sola pantalla con lo más urgente de TODAS las
// organizaciones — compromisos atrasados, turnos de aseo sin confirmar,
// entrevistas próximas y el presupuesto del trimestre — para no tener que
// entrar módulo por módulo a armarse una idea general. Solo lo ve el
// Administrador o el líder de Obispado (canSeeBishopricPanelTab).

async function renderBishopricPanelView() {
  const container = document.getElementById('view-root');
  container.innerHTML = `<div class="section-header"><div><h2>Panel de Obispado</h2><p>Cargando…</p></div></div>`;
  let data;
  try { data = await api('/dashboard/overview'); }
  catch (e) { toast(e.message, 'error'); container.innerHTML = '<div class="empty-state">No se pudo cargar</div>'; return; }

  container.innerHTML = `
    <div class="section-header">
      <div><h2>Panel de Obispado</h2><p>Resumen de todas las organizaciones — para no tener que revisar módulo por módulo</p></div>
    </div>
    <div class="stats-cards" style="margin-bottom:22px;">
      <div class="stat-card"><div class="stat-card-label">Compromisos atrasados</div><div class="stat-card-value">${data.overdueCommitments.length}</div></div>
      <div class="stat-card"><div class="stat-card-label">Turnos de aseo sin confirmar</div><div class="stat-card-value">${data.cleaningPending.length}</div></div>
      <div class="stat-card"><div class="stat-card-label">Entrevistas — próximos 7 días</div><div class="stat-card-value">${data.upcomingInterviews.length}</div></div>
      <div class="stat-card"><div class="stat-card-label">Actividades — próximos 7 días</div><div class="stat-card-value">${data.activitiesThisWeek}</div></div>
    </div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px;" class="bp-grid">
      <div>
        <h3 style="font-size:14px; color:var(--celeste-darker); margin-bottom:8px;">⏰ Compromisos atrasados</h3>
        <div class="card-list">${data.overdueCommitments.length ? data.overdueCommitments.map(bpCommitmentRowHtml).join('') : '<div class="empty-state">Ninguno — al día 🎉</div>'}</div>
      </div>
      <div>
        <h3 style="font-size:14px; color:var(--celeste-darker); margin-bottom:8px;">🧹 Turnos de aseo sin confirmar</h3>
        <div class="card-list">${data.cleaningPending.length ? data.cleaningPending.map(bpCleaningRowHtml).join('') : '<div class="empty-state">Ninguno pendiente</div>'}</div>
      </div>
      <div>
        <h3 style="font-size:14px; color:var(--celeste-darker); margin-bottom:8px;">👤 Entrevistas de los próximos 7 días</h3>
        <div class="card-list">${data.upcomingInterviews.length ? data.upcomingInterviews.map(bpInterviewRowHtml).join('') : '<div class="empty-state">Ninguna agendada</div>'}</div>
      </div>
      <div>
        <h3 style="font-size:14px; color:var(--celeste-darker); margin-bottom:8px;">💰 Presupuesto — ${esc(data.budget.quarterLabel)}</h3>
        <div class="budget-card">
          <div class="budget-figures">
            <div><span class="bf-label">Asignado</span>${fmtMoney(data.budget.totalAssigned)}</div>
            <div><span class="bf-label">Gastado</span>${fmtMoney(data.budget.totalSpent)}</div>
            <div><span class="bf-label">Saldo</span>${fmtMoney(data.budget.totalBalance)}</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function bpCommitmentRowHtml(c) {
  return `
    <div class="list-card">
      <div class="lc-main">
        <div class="lc-title">${esc(c.description)}</div>
        <div class="lc-sub">${esc(c.organizationName)} · "${esc(c.meetingTitle)}" · responsable: ${esc(c.assignedToName)} · vencía ${esc(fmtDateHuman(c.dueDate))}</div>
      </div>
      <span class="status-pill status-red">Atrasado</span>
    </div>`;
}

function bpCleaningRowHtml(s) {
  return `
    <div class="list-card">
      <div class="lc-main">
        <div class="lc-title">${esc(s.familyName)}</div>
        <div class="lc-sub">Turno del ${esc(fmtDateHuman(s.date))}</div>
      </div>
      <span class="status-pill status-amber">Sin confirmar</span>
    </div>`;
}

function bpInterviewRowHtml(iv) {
  return `
    <div class="list-card">
      <div class="lc-main">
        <div class="lc-title">${esc(iv.memberName)}</div>
        <div class="lc-sub">${esc(iv.organizationName)}${iv.interviewerName ? ' · con ' + esc(iv.interviewerName) : ''}</div>
      </div>
      <div class="lc-when">${esc(fmtDateHuman(iv.date))}<br>${esc(fmtTime(iv.startTime))}</div>
    </div>`;
}

boot();
