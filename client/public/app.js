// OrganizaSion — frontend sin frameworks ni build step.
// Todo el estado vive en el objeto `state`; cada cambio relevante llama a render().

const API = '/api';
const APP_NAME = 'OrganizaSion';
// Wordmark de dos colores ("Organiza" + "Sion") reutilizado en el login, el
// registro y la barra superior — ver .brand-organiza/.brand-sion en
// styles.css, que usan los mismos --ink y --celeste de siempre.
const BRAND_WORDMARK_HTML = `<span class="brand-organiza">Organiza</span><span class="brand-sion">Sion</span>`;
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
  interviewsSubtab: 'pending', // Entrevistas: 'pending' (agenda) o 'requests' (solicitudes por confirmar)
  adminSubtab: 'users',
  adminUsers: [],
  loading: false,
  meetingsSubtab: 'mine',
  assignmentsSubtab: 'cleaning',
  talksHistoryOpen: false, // Discursos: el histórico de meses pasados arranca colapsado
  interviewsHistoryOpen: false, // Entrevistas: el historial de ya verificadas arranca colapsado
  interviewRequestsHistoryOpen: false, // Entrevistas → Solicitudes: historial de ya decididas arranca colapsado
  expenseRequestsHistoryOpen: false, // Presupuesto: historial de solicitudes de gasto ya decididas arranca colapsado
  statsSubtab: 'pending',
  statsYear: null,
  statsOrgId: null,
  achPeriod: 'month', // Rachas y Logros: mes / quarter / semester / year / allTime
  achView: 'current', // 'current' (en curso) o 'history' (períodos ya cerrados)
  calViewMode: 'month', // Calendario: 'month' (grilla) o 'agenda' (lista cronológica)
  searchOpen: false,
  notifOpen: false,
  miniCalOpen: false,
  miniCalMonth: null, // mes que muestra el mini calendario emergente (se inicializa al abrirlo)
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

// Estado vacío con una acción directa opcional (ej: "+ Agregar turno") —
// evita que la persona tenga que ir a buscar el botón correspondiente en
// otra parte de la pantalla. `cta` es opcional: { id, label }. Después de
// insertar el HTML hay que llamar wireEmptyStateCta(cta, fn) para conectar
// el clic (el propio caller decide qué acción corresponde).
function emptyStateHtml(message, cta) {
  return `<div class="empty-state">
    <div>${esc(message)}</div>
    ${cta ? `<button type="button" class="btn btn-primary btn-sm" id="${cta.id}" style="margin-top:12px;">${esc(cta.label)}</button>` : ''}
  </div>`;
}
function wireEmptyStateCta(id, fn) {
  const btn = document.getElementById(id);
  if (btn) btn.addEventListener('click', fn);
}

// "Mostrar más opciones": colapsa los campos menos usados de un formulario
// (tipo Reunión, actividad de todo el Barrio, otras organizaciones
// involucradas, repetición) detrás de un toggle, para que el formulario no
// abrume de entrada con campos que la mayoría de las veces no hacen falta.
// `startOpen` lo deja expandido desde el principio cuando el registro que se
// está editando ya tiene algo cargado ahí (ver hasAdvancedData en cada
// caller) — así nunca se esconde una configuración que la persona ya eligió.
function advancedOptionsToggleHtml(idPrefix, startOpen) {
  return `<button type="button" class="btn btn-ghost btn-sm advanced-toggle-btn" id="${idPrefix}-advanced-toggle">${startOpen ? '▴ Ocultar opciones avanzadas' : '▾ Mostrar más opciones (tipo, otras organizaciones, repetición…)'}</button>`;
}
function wireAdvancedOptionsToggle(idPrefix) {
  const toggle = document.getElementById(`${idPrefix}-advanced-toggle`);
  const panel = document.getElementById(`${idPrefix}-advanced-fields`);
  if (!toggle || !panel) return;
  toggle.addEventListener('click', () => {
    const nowOpen = panel.style.display === 'none';
    panel.style.display = nowOpen ? '' : 'none';
    toggle.textContent = nowOpen ? '▴ Ocultar opciones avanzadas' : '▾ Mostrar más opciones (tipo, otras organizaciones, repetición…)';
  });
}

// Skeleton loaders: en vez de dejar un simple texto "Cargando…" mientras se
// espera la respuesta del servidor, se muestra una vista previa animada con
// la FORMA aproximada del contenido real (tarjetas, título, subtítulo) —
// se percibe más rápido y evita el "salto" brusco cuando llega la data.
function skeletonCardsHtml(count = 3) {
  return `<div class="card-list" aria-hidden="true">${Array.from({ length: count }, () => `
    <div class="list-card skeleton-card">
      <div class="lc-main">
        <div class="skeleton-line" style="width:${55 + Math.round(Math.random() * 20)}%; height:14px;"></div>
        <div class="skeleton-line" style="width:${30 + Math.round(Math.random() * 20)}%; height:11px; margin-top:8px;"></div>
      </div>
    </div>`).join('')}</div>`;
}
function skeletonStatsHtml(count = 4) {
  return `<div class="stats-cards" style="margin-bottom:22px;" aria-hidden="true">${Array.from({ length: count }, () => `
    <div class="stat-card">
      <div class="skeleton-line" style="width:70%; height:10px;"></div>
      <div class="skeleton-line" style="width:40%; height:22px; margin-top:10px;"></div>
    </div>`).join('')}</div>`;
}
// Skeleton de una vista completa: título fijo (se sabe de entrada, no hace
// falta animarlo) + subtítulo y contenido animados. `stats` agrega una fila
// de tarjetas-resumen arriba de las tarjetas de lista (para vistas tipo
// Panel de Obispado que muestran números destacados primero).
function skeletonViewHtml(title, { cards = 3, stats = 0 } = {}) {
  return `
    <div class="section-header"><div><h2>${esc(title)}</h2><p class="skeleton-line" style="width:130px; height:11px; display:inline-block;"></p></div></div>
    ${stats ? skeletonStatsHtml(stats) : ''}
    ${skeletonCardsHtml(cards)}
  `;
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
const WEEKDAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function fmtDateHuman(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dow = WEEKDAY_NAMES[date.getDay()];
  return `${dow} ${d} de ${MONTH_LABELS[m - 1]}`;
}
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Igual que timesOverlap() en el servidor (db.js): si falta la hora de
// término se asume una duración típica de 30 minutos, solo para poder
// comparar si dos horarios se superponen.
function timeToMinutes(t) { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; }
function effectiveEndMinutes(startTime, endTime) { return endTime ? timeToMinutes(endTime) : timeToMinutes(startTime) + 30; }
function timesOverlap(aStart, aEnd, bStart, bEnd) {
  return timeToMinutes(aStart) < effectiveEndMinutes(bStart, bEnd) && timeToMinutes(bStart) < effectiveEndMinutes(aStart, aEnd);
}
// Punto 4 (ampliación): a partir de la agenda semanal declarada por un líder
// (weekday + rango de horas), calcula las próximas fechas concretas que
// calzan dentro de las próximas 6 semanas — para que el miembro elija un día
// real ("martes 25 de agosto") en vez de tener que adivinar cuál de sus
// propios días de la semana es un martes o un jueves. `busy` (entrevistas ya
// agendadas con ese líder, ver GET /interview-requests/orgs) descarta las
// fechas cuyo horario ya está ocupado, para no ofrecer como "disponible" un
// día que en realidad ya tiene una entrevista encima.
function computeUpcomingAvailableDates(windows, busy) {
  if (!Array.isArray(windows) || !windows.length) return [];
  const busyList = Array.isArray(busy) ? busy : [];
  const out = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 1; i <= 42; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const weekday = d.getDay();
    const dateStr = isoDate(d);
    for (const w of windows) {
      if (Number(w.weekday) !== weekday) continue;
      const occupied = busyList.some((b) => b.date === dateStr && timesOverlap(w.startTime, w.endTime, b.startTime, b.endTime));
      if (!occupied) out.push({ date: dateStr, weekday, startTime: w.startTime, endTime: w.endTime });
    }
  }
  return out;
}
// Texto corto tipo "martes y jueves, 20:00–22:00" a partir de la agenda
// semanal declarada — agrupa los días que comparten exactamente el mismo
// rango de horas para no repetirlo, que es el caso más común (un líder que
// entrevista siempre a la misma hora, distintos días).
function availabilityWindowsSummary(windows) {
  if (!Array.isArray(windows) || !windows.length) return '';
  const byRange = {};
  for (const w of windows) {
    const key = `${w.startTime}-${w.endTime}`;
    (byRange[key] ||= []).push(w.weekday);
  }
  return Object.entries(byRange).map(([range, days]) => {
    const [start, end] = range.split('-');
    const dayNames = [...new Set(days)].sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d]);
    return `${dayNames.join(', ')} de ${start} a ${end}`;
  }).join(' · ');
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
  wireOfflineBanner();
  if (!state.token) { renderLogin(); return; }
  try {
    state.user = await api('/auth/me');
    state.organizations = await api('/organizations');
    await loadCalendarData();
    render();
    maybeShowMandatoryProfileModal(() => maybeStartOnboardingTour());
  } catch (e) {
    setToken(null);
    renderLogin();
  }
}

// Banner discreto que avisa cuando el navegador pierde la conexión (por
// ejemplo, en una sala sin buena señal) — así la persona no se pregunta por
// qué un guardado no funcionó. navigator.onLine ya refleja el estado actual
// al cargar la página, así que el banner arranca visible si corresponde.
function wireOfflineBanner() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  const update = () => { banner.style.display = navigator.onLine ? 'none' : 'block'; };
  window.addEventListener('online', () => { update(); toast('Conexión recuperada'); });
  window.addEventListener('offline', update);
  update();
}

// ---------------- Recorrido guiado (primera vez) ----------------
// Un carrusel corto (no un spotlight sobre el DOM real, que es frágil entre
// distintos anchos de pantalla) explicando, paso a paso, solo las pestañas
// que ESTA persona puede ver — así el recorrido nunca menciona algo a lo
// que no tiene acceso. Se muestra una sola vez por navegador (localStorage);
// el ícono "❓" de la barra superior lo vuelve a lanzar cuando quiera.
function tourStepsForUser() {
  const steps = [
    { icon: '📅', title: 'Calendario', text: 'Todas las actividades de todas las organizaciones, en un solo lugar. Usa los filtros de colores para mostrar solo las que te interesan, o cambia a la vista "Agenda" para verlas en una lista.' },
  ];
  if (canSeeBishopricPanelTab()) steps.push({ icon: '🏠', title: 'Panel de Obispado', text: 'Un resumen de una sola pantalla con lo más urgente de todo el Barrio: compromisos atrasados, aseo sin confirmar, entrevistas y presupuesto.' });
  if (canSeeMyActivitiesTab()) steps.push({ icon: '📋', title: 'Mis Actividades', text: 'Tus actividades y entrevistas en una lista simple, sin tener que navegar mes a mes.' });
  if (canSeeInterviewsTab()) steps.push({ icon: '👤', title: 'Entrevistas', text: 'Agenda y consulta entrevistas — información privada de tu organización.' });
  if (canSeeBudgetTab()) steps.push({ icon: '💰', title: 'Presupuesto', text: 'Asignaciones y gastos del trimestre, por organización.' });
  if (canSeeMeetingsTab()) steps.push({ icon: '📝', title: 'Reuniones y Consejos', text: 'Actas, compromisos, y tus propias asignaciones pendientes.' });
  if (canSeeAssignmentsTab()) steps.push({ icon: '🧹', title: 'Asignaciones', text: 'Turnos de aseo y registro de discursos de la reunión sacramental.' });
  if (canSeeStatsTab()) steps.push({ icon: '📊', title: 'Estadísticas', text: 'Evalúa actividades pasadas y consulta Rachas y Logros.' });
  steps.push({ icon: '🔍', title: 'Búsqueda', text: 'La lupa de arriba busca en toda la app a la vez — actividades, entrevistas, actas y discursos.' });
  steps.push({ icon: '🔔', title: 'Notificaciones', text: 'La campana te avisa lo que tienes pendiente en un solo lugar, sin tener que revisar pestaña por pestaña.' });
  return steps;
}

function markTourSeen() { localStorage.setItem('organizasion_tour_seen', '1'); }

function maybeStartOnboardingTour() {
  if (localStorage.getItem('organizasion_tour_seen')) return;
  setTimeout(() => startOnboardingTour(), 400);
}

function startOnboardingTour() {
  const steps = tourStepsForUser();
  let idx = 0;
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  const renderStep = () => {
    const s = steps[idx];
    modalRoot.innerHTML = `
      <div class="modal-backdrop" id="tour-backdrop">
        <div class="modal" style="max-width:420px; text-align:center;">
          <div class="modal-body" style="padding-top:26px;">
            <div style="font-size:40px; margin-bottom:10px;">${s.icon}</div>
            <h3 style="margin:0 0 8px;">${esc(s.title)}</h3>
            <p style="font-size:13.5px; color:var(--ink-soft); margin:0 0 18px;">${esc(s.text)}</p>
            <div style="font-size:12px; color:var(--ink-soft); margin-bottom:14px;">${idx + 1} / ${steps.length}</div>
            <div style="display:flex; gap:8px;">
              ${idx > 0 ? `<button class="btn btn-secondary btn-block" id="tour-prev">Atrás</button>` : ''}
              <button class="btn btn-primary btn-block" id="tour-next">${idx === steps.length - 1 ? 'Entendido' : 'Siguiente'}</button>
            </div>
            <button class="btn btn-ghost btn-sm" id="tour-skip" style="margin-top:10px;">Saltar recorrido</button>
          </div>
        </div>
      </div>`;
    document.getElementById('tour-next').addEventListener('click', () => {
      if (idx === steps.length - 1) { closeModal(); markTourSeen(); }
      else { idx++; renderStep(); }
    });
    const prevBtn = document.getElementById('tour-prev');
    if (prevBtn) prevBtn.addEventListener('click', () => { idx--; renderStep(); });
    document.getElementById('tour-skip').addEventListener('click', () => { closeModal(); markTourSeen(); });
    document.getElementById('tour-backdrop').addEventListener('click', (e) => { if (e.target.id === 'tour-backdrop') { closeModal(); markTourSeen(); } });
  };
  renderStep();
}

// ---------------- Mi Perfil ----------------
// Fecha de nacimiento, sexo, teléfono y foto de perfil — la fecha de
// nacimiento y el sexo son los que determinan con qué organización se
// puede agendar una entrevista (ver interviewEligibility en el servidor):
// un hombre adulto con Cuórum de Élderes o con el Obispado; una mujer
// adulta con Sociedad de Socorro o con el Obispado; un joven o una joven
// solo con el Obispado (el Obispo y sus consejeros pueden entrevistar a
// cualquiera, sin restricción).
//
// Comprime la foto en el propio navegador (un canvas, recortada a cuadrado
// y reducida a un máximo de 320px de lado) antes de mandarla como data URI
// en base64 — así no hace falta ninguna librería de subida de archivos ni
// almacenamiento aparte: la foto queda guardada directo en el usuario,
// igual que el resto de sus datos.
function compressImageFile(file, maxSize = 320) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer la imagen'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Archivo de imagen inválido'));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const outSize = Math.min(maxSize, side);
        const canvas = document.createElement('canvas');
        canvas.width = outSize; canvas.height = outSize;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, side, side, 0, 0, outSize, outSize);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Punto 8 (ampliación): ¿a esta persona le corresponde declarar un
// llamamiento (Presidente/Obispo, Consejero o Secretario)? Solo si es líder
// de Obispado, Cuórum de Élderes o Sociedad de Socorro.
function callingApplies(u) {
  if (!u || u.role !== 'leader' || !u.organizationId) return false;
  const org = orgById(u.organizationId);
  return !!(org && PRESIDENT_ORGS.includes(org.name));
}

// Al ingresar, si a la cuenta le falta la fecha de nacimiento, el sexo, o —
// para líderes de Obispado/Cuórum de Élderes/Sociedad de Socorro — el
// llamamiento (cuentas creadas antes de que existieran estos campos), se le
// pide completarlo con un modal que no se puede cerrar sin guardar — recién
// después de eso sigue el resto (recorrido guiado, etc.). `onDone` se
// llama tanto si hacía falta completarlo (después de guardar) como si el
// perfil ya estaba completo (de inmediato).
function maybeShowMandatoryProfileModal(onDone) {
  const needsCalling = callingApplies(state.user) && !state.user.calling;
  if (state.user.birthDate && state.user.sex && !needsCalling) { onDone(); return; }
  openProfileModal({ mandatory: true, onDone });
}

function openProfileModal({ mandatory = false, onDone } = {}) {
  const u = state.user;
  let photoDataUri = u.profilePhoto || null;
  const showCalling = callingApplies(u);
  const callingOrg = showCalling ? orgById(u.organizationId) : null;
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="prof-modal-backdrop">
      <div class="modal">
        <div class="modal-header">
          <h3>${mandatory ? 'Completa tu perfil' : 'Mi Perfil'}</h3>
          ${mandatory ? '' : '<button class="modal-close" id="prof-modal-close">×</button>'}
        </div>
        <div class="modal-body">
          <div id="prof-error"></div>
          ${mandatory ? `<div class="hint-box" style="margin-top:0;">Antes de seguir, nos falta ${(!u.birthDate || !u.sex) ? 'tu fecha de nacimiento y tu sexo' : ''}${(!u.birthDate || !u.sex) && showCalling && !u.calling ? ' y ' : ''}${showCalling && !u.calling ? 'tu llamamiento' : ''} — se usan para saber con quién puedes agendar una entrevista (por ejemplo, un hombre adulto con Cuórum de Élderes o con el Obispado; una mujer adulta con Sociedad de Socorro o con el Obispado; un joven o una joven solo con el Obispado)${showCalling ? ', y quién de la presidencia realiza entrevistas' : ''}.</div>` : ''}
          <form id="prof-form">
            <div class="field" style="text-align:center;">
              <label>Foto de perfil (opcional)</label>
              <div id="prof-photo-preview" style="margin:6px auto 10px;">${photoDataUri ? `<img src="${esc(photoDataUri)}" style="width:96px;height:96px;border-radius:50%;object-fit:cover;" />` : `<div class="user-avatar" style="width:96px;height:96px;font-size:28px;margin:0 auto;">${esc(initials(u.name))}</div>`}</div>
              <input type="file" id="prof-photo-input" accept="image/*" style="display:block; margin:0 auto;" />
              ${photoDataUri ? '<button type="button" class="btn btn-ghost btn-sm" id="prof-photo-remove" style="margin-top:6px;">Quitar foto</button>' : ''}
            </div>
            <div class="two-col">
              <div class="field">
                <label>Fecha de nacimiento</label>
                <input type="date" name="birthDate" required value="${esc(u.birthDate || '')}" />
              </div>
              <div class="field">
                <label>Sexo</label>
                <select name="sex" required>
                  <option value="" disabled ${!u.sex ? 'selected' : ''}>Selecciona…</option>
                  <option value="M" ${u.sex === 'M' ? 'selected' : ''}>Hombre</option>
                  <option value="F" ${u.sex === 'F' ? 'selected' : ''}>Mujer</option>
                </select>
              </div>
            </div>
            ${showCalling ? `
            <div class="field">
              <label>Llamamiento en ${esc(callingOrg.name)}</label>
              <select name="calling" ${mandatory && !u.calling ? 'required' : ''}>
                <option value="" disabled ${!u.calling ? 'selected' : ''}>Selecciona…</option>
                <option value="Presidente" ${u.calling === 'Presidente' ? 'selected' : ''}>${esc(callingLabel(callingOrg.name, 'Presidente'))}</option>
                <option value="Consejero" ${u.calling === 'Consejero' ? 'selected' : ''}>${esc(callingLabel(callingOrg.name, 'Consejero'))}</option>
                <option value="Secretario" ${u.calling === 'Secretario' ? 'selected' : ''}>${esc(callingLabel(callingOrg.name, 'Secretario'))}</option>
              </select>
              <div class="hint-box" style="margin-top:6px;">Se usa para saber a quién se le puede pedir una entrevista (el Secretario/a no entrevista, según el Manual General) y para dirigir avisos como la Coordinación de Ministración trimestral a la persona correcta. Si te marcas como ${esc(callingLabel(callingOrg.name, 'Presidente'))}, se desmarca automáticamente a quien lo fuera antes.</div>
            </div>` : ''}
            <div class="field">
              <label>Teléfono (opcional)</label>
              <input type="text" name="phone" value="${esc(u.phone || '')}" placeholder="Ej: +56 9 1234 5678" />
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex; gap:8px;">
            ${mandatory ? '' : '<button class="btn btn-secondary" id="prof-cancel">Cancelar</button>'}
            <button class="btn btn-primary" id="prof-save">Guardar</button>
          </div>
        </div>
      </div>
    </div>`;
  if (!mandatory) {
    const guardedClose = wireUnsavedChangesGuard(document.getElementById('prof-form'));
    document.getElementById('prof-modal-close').addEventListener('click', guardedClose);
    document.getElementById('prof-cancel').addEventListener('click', guardedClose);
    document.getElementById('prof-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'prof-modal-backdrop') guardedClose(); });
  }
  document.getElementById('prof-photo-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      photoDataUri = await compressImageFile(file);
      document.getElementById('prof-photo-preview').innerHTML = `<img src="${esc(photoDataUri)}" style="width:96px;height:96px;border-radius:50%;object-fit:cover;" />`;
    } catch (err) {
      document.getElementById('prof-error').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    }
  });
  const removeBtn = document.getElementById('prof-photo-remove');
  if (removeBtn) removeBtn.addEventListener('click', () => {
    photoDataUri = null;
    document.getElementById('prof-photo-preview').innerHTML = `<div class="user-avatar" style="width:96px;height:96px;font-size:28px;margin:0 auto;">${esc(initials(u.name))}</div>`;
  });
  document.getElementById('prof-save').addEventListener('click', async () => {
    const form = document.getElementById('prof-form');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const body = { birthDate: fd.get('birthDate'), sex: fd.get('sex'), phone: fd.get('phone') || null, profilePhoto: photoDataUri };
    try {
      let updated = await api('/auth/me/profile', { method: 'PUT', body });
      if (showCalling && fd.get('calling')) {
        updated = await api('/auth/me/calling', { method: 'PUT', body: { calling: fd.get('calling') } });
      }
      state.user = updated;
      closeModal();
      toast('Perfil guardado');
      render();
      if (onDone) onDone();
    } catch (err) {
      document.getElementById('prof-error').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    }
  });
}

// ---------------- Búsqueda global (barra superior) ----------------
// Una sola caja de texto que busca a la vez en actividades/reuniones,
// entrevistas, actas/compromisos y discursos — cada categoría ya viene
// filtrada por el servidor según lo que esa persona puede ver (ver
// server/src/routes/search.js), así que el cliente solo tiene que mostrar
// lo que le llega. El panel se abre EN EL FLUJO NORMAL de la página (no
// flotando encima) para que nunca tape ni se corte con otro recuadro,
// sobre todo en el celular.
let searchDebounceTimer = null;

function toggleSearchPanel(forceOpen) {
  state.searchOpen = forceOpen !== undefined ? forceOpen : !state.searchOpen;
  if (state.searchOpen) state.notifOpen = false;
  const searchPanel = document.getElementById('search-panel');
  const notifPanel = document.getElementById('notif-panel');
  if (!searchPanel) return;
  searchPanel.hidden = !state.searchOpen;
  if (notifPanel) notifPanel.hidden = true;
  if (state.searchOpen) {
    const input = document.getElementById('search-input');
    if (input) input.focus();
  }
}

function renderSearchResults(results, query) {
  const el = document.getElementById('search-results');
  if (!el) return;
  if (!query || query.trim().length < 2) {
    el.innerHTML = '<div class="search-hint">Escribe al menos 2 letras para buscar</div>';
    return;
  }
  if (!results.length) {
    el.innerHTML = '<div class="search-hint">Sin resultados para "' + esc(query) + '"</div>';
    return;
  }
  el.innerHTML = results.map((r) => `
    <button type="button" class="search-result-row" data-category="${r.category}" data-id="${r.id}" data-date="${esc(r.date || '')}">
      <span class="search-result-icon">${r.icon}</span>
      <span class="search-result-main">
        <span class="search-result-title">${esc(r.title)}</span>
        <span class="search-result-sub">${r.categoryLabel} · ${esc(r.subtitle)}</span>
      </span>
    </button>`).join('');
  el.querySelectorAll('.search-result-row').forEach((row) => {
    row.addEventListener('click', () => goToSearchResult(row.dataset.category, Number(row.dataset.id), row.dataset.date));
  });
}

async function runSearch(query) {
  try {
    const data = await api('/search?q=' + encodeURIComponent(query));
    renderSearchResults(data.results, query);
  } catch (e) {
    const el = document.getElementById('search-results');
    if (el) el.innerHTML = '<div class="search-hint">No se pudo buscar</div>';
  }
}

async function goToSearchResult(category, id, date) {
  toggleSearchPanel(false);
  if (category === 'events') {
    state.view = 'calendar';
    state.calMonth = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, 1);
    await loadCalendarData();
    render();
    openDayModal(date);
    return;
  }
  if (category === 'interviews') {
    state.view = 'interviews';
    render();
    return;
  }
  if (category === 'meetings') {
    state.view = 'meetings';
    state.meetingsSubtab = 'manage';
    render();
    try {
      const meeting = await api(`/meetings/${id}`);
      openMeetingDetailModal(meeting);
    } catch (e) { /* si no se puede abrir el detalle, igual queda en la pestaña correcta */ }
    return;
  }
  if (category === 'talks') {
    state.view = 'cleaning';
    state.assignmentsSubtab = 'talks';
    render();
    return;
  }
  render();
}

// Atajo desde los avisos del Panel de Obispado (Puntos 8 y 10): lleva a
// Reuniones y Consejos y abre directo el modal de "Nueva acta" con el tipo
// ya preseleccionado, para no tener que buscarlo en el combo.
function goCreateMeetingOfType(type) {
  state.view = 'meetings';
  state.meetingsSubtab = 'manage';
  render();
  openMeetingModal(type);
}

// ---------------- Campana de notificaciones ----------------
// Resumen liviano (no en vivo — se vuelve a pedir cada vez que se abre)
// reutilizando exactamente los mismos cálculos que ya usan sus propias
// pestañas (ver server/src/routes/notifications-summary.js), para que el
// número de la campana siempre calce con lo que se ve al entrar a esa
// pestaña.
async function refreshNotifBadge() {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  try {
    const data = await api('/notifications/summary');
    state.notifCache = data;
    if (data.total > 0) {
      badge.textContent = data.total > 99 ? '99+' : String(data.total);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  } catch (e) { badge.hidden = true; }
}

function toggleNotifPanel(forceOpen) {
  state.notifOpen = forceOpen !== undefined ? forceOpen : !state.notifOpen;
  if (state.notifOpen) state.searchOpen = false;
  const notifPanel = document.getElementById('notif-panel');
  const searchPanel = document.getElementById('search-panel');
  if (!notifPanel) return;
  notifPanel.hidden = !state.notifOpen;
  if (searchPanel) searchPanel.hidden = true;
  if (state.notifOpen) renderNotifPanel();
}

async function renderNotifPanel() {
  const el = document.getElementById('notif-results');
  if (!el) return;
  el.innerHTML = skeletonCardsHtml(2);
  let data;
  try { data = await api('/notifications/summary'); } catch (e) { el.innerHTML = '<div class="search-hint">No se pudo cargar</div>'; return; }
  state.notifCache = data;
  if (!data.items.length) {
    el.innerHTML = '<div class="search-hint">🎉 Nada pendiente por ahora</div>';
    return;
  }
  el.innerHTML = data.items.map((it) => `
    <button type="button" class="search-result-row" data-view="${it.view}" data-subtab="${it.subtab || ''}">
      <span class="search-result-icon">${it.icon}</span>
      <span class="search-result-main">
        <span class="search-result-title">${it.count} — ${esc(it.label)}</span>
      </span>
    </button>`).join('');
  el.querySelectorAll('.search-result-row').forEach((row) => {
    row.addEventListener('click', () => {
      toggleNotifPanel(false);
      state.view = row.dataset.view;
      if (row.dataset.subtab) {
        if (state.view === 'meetings') state.meetingsSubtab = row.dataset.subtab;
        else if (state.view === 'stats') state.statsSubtab = row.dataset.subtab;
        else if (state.view === 'cleaning') state.assignmentsSubtab = row.dataset.subtab;
        else if (state.view === 'interviews') state.interviewsSubtab = row.dataset.subtab;
      }
      render();
    });
  });
}

function wireTopbarUtilities() {
  const searchToggle = document.getElementById('search-toggle');
  const notifToggle = document.getElementById('notif-toggle');
  const tourToggle = document.getElementById('tour-toggle');
  if (searchToggle) searchToggle.addEventListener('click', () => toggleSearchPanel());
  if (notifToggle) notifToggle.addEventListener('click', () => toggleNotifPanel());
  if (tourToggle) tourToggle.addEventListener('click', () => startOnboardingTour());
  const searchClose = document.getElementById('search-close');
  if (searchClose) searchClose.addEventListener('click', () => toggleSearchPanel(false));
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value;
      clearTimeout(searchDebounceTimer);
      if (q.trim().length < 2) { renderSearchResults([], q); return; }
      searchDebounceTimer = setTimeout(() => runSearch(q), 300);
    });
  }
  refreshNotifBadge();
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
        <img class="login-logo" src="/logo-bee.png" alt="${esc(APP_NAME)}" />
        <h1 class="brand-wordmark">${BRAND_WORDMARK_HTML}</h1>
        <p class="subtitle">Calendario, entrevistas, presupuesto, reuniones, asignaciones y logros de todas las organizaciones en un solo lugar</p>
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
        <img class="login-logo" src="/logo-bee.png" alt="${esc(APP_NAME)}" />
        <h1 class="brand-wordmark">${BRAND_WORDMARK_HTML}</h1>
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
          <div class="field" id="reg-calling-field" style="display:none;">
            <label>¿Cuál es tu llamamiento ahí?</label>
            <select id="reg-calling-select">
              <option value="" disabled selected>Selecciona…</option>
              <option value="Presidente">Presidente/Obispo</option>
              <option value="Consejero">Consejero/a</option>
              <option value="Secretario">Secretario/a</option>
            </select>
          </div>
          <div class="two-col">
            <div class="field">
              <label>Fecha de nacimiento</label>
              <input type="date" name="birthDate" required />
            </div>
            <div class="field">
              <label>Sexo</label>
              <select name="sex" required>
                <option value="" disabled selected>Selecciona…</option>
                <option value="M">Hombre</option>
                <option value="F">Mujer</option>
              </select>
            </div>
          </div>
          <div class="hint-box" style="margin-top:0;">La fecha de nacimiento y el sexo se usan para saber con quién puedes agendar una entrevista (por ejemplo, un hombre adulto con el presidente de Cuórum de Élderes o con el Obispado; una mujer adulta con la presidenta de Sociedad de Socorro o con el Obispado; un joven o una joven solo con el Obispado) — no se muestran a nadie más.</div>
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

  let publicOrgs = [];
  try {
    publicOrgs = await api('/public/organizations');
    const orgSelect = document.getElementById('reg-org');
    orgSelect.innerHTML = publicOrgs.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
  } catch (e) { /* si falla, el selector queda vacío; el backend igual valida */ }

  // Punto 8 (ampliación): si va a liderar Obispado, Cuórum de Élderes o
  // Sociedad de Socorro, pide de entrada si es el presidente/Obispo, un
  // consejero o el secretario — el administrador lo puede corregir al
  // aprobar la solicitud.
  const updateRegCallingField = () => {
    const role = document.getElementById('reg-role').value;
    document.getElementById('reg-org-field').style.display = role === 'leader' ? '' : 'none';
    const org = publicOrgs.find((o) => String(o.id) === document.getElementById('reg-org').value);
    const isTargetOrg = role === 'leader' && org && PRESIDENT_ORGS.includes(org.name);
    document.getElementById('reg-calling-field').style.display = isTargetOrg ? '' : 'none';
  };
  document.getElementById('reg-role').addEventListener('change', updateRegCallingField);
  document.getElementById('reg-org').addEventListener('change', updateRegCallingField);

  document.getElementById('reg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errBox = document.getElementById('reg-error');
    errBox.innerHTML = '';
    if (fd.get('password') !== fd.get('password2')) {
      errBox.innerHTML = `<div class="error-msg">Las contraseñas no coinciden</div>`;
      return;
    }
    const org = publicOrgs.find((o) => String(o.id) === fd.get('requestedOrganizationId'));
    const isTargetOrg = fd.get('requestedRole') === 'leader' && org && PRESIDENT_ORGS.includes(org.name);
    const requestedCalling = isTargetOrg ? document.getElementById('reg-calling-select').value : '';
    if (isTargetOrg && !requestedCalling) {
      errBox.innerHTML = `<div class="error-msg">Indica si eres el Presidente/Obispo, un Consejero o el Secretario</div>`;
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
        requestedCalling: requestedCalling || undefined,
        birthDate: fd.get('birthDate'),
        sex: fd.get('sex'),
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

// Punto 8 (ampliación): las tres organizaciones cuya presidencia distingue
// Presidente/Obispo, Consejero(a) y Secretario(a) — mismas tres que ya
// distinguía isPresident (Coordinación de Ministración) y las reglas de
// elegibilidad de entrevista. Ver callingLabel() en el servidor (db.js) —
// esta es la misma función, duplicada acá porque el cliente no puede pedirle
// al servidor que le traduzca un string suelto.
const PRESIDENT_ORGS = ['Obispado', 'Cuórum de Élderes', 'Sociedad de Socorro'];
function callingLabel(orgName, calling) {
  if (!calling) return '';
  if (orgName === 'Obispado' && calling === 'Presidente') return 'Obispo';
  if (orgName === 'Sociedad de Socorro') {
    if (calling === 'Presidente') return 'Presidenta';
    if (calling === 'Consejero') return 'Consejera';
    if (calling === 'Secretario') return 'Secretaria';
  }
  return calling;
}

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
// organizaciones (compromisos, aseo, entrevistas, presupuesto). Ya no es una
// pestaña más — es la pantalla que ese perfil necesita tener a mano en todo
// momento, así que vive como ícono fijo junto a la lupa y la campana (ver
// `#bishopric-toggle` en render()), en vez de competir por espacio con el
// resto de los módulos en la fila de pestañas.
function canSeeBishopricPanelTab() {
  return isObispadoUser();
}

// Definición de cada pestaña posible del menú principal. El orden final
// para cada perfil lo decide tabOrderFor() más abajo — no hay un único
// orden fijo para todos: se ordena por qué tan seguido ese perfil necesita
// revisar o actuar sobre cada módulo, con Calendario siempre primero como
// ancla común a todos los perfiles (para que no "salte de lugar").
const TAB_DEFS = {
  calendar: { label: 'Calendario', visible: () => true },
  myActivities: { label: 'Mis Actividades', visible: canSeeMyActivitiesTab },
  interviews: { label: 'Entrevistas', visible: canSeeInterviewsTab },
  meetings: { label: 'Reuniones y Consejos', visible: canSeeMeetingsTab },
  cleaning: { label: 'Asignaciones', visible: canSeeAssignmentsTab },
  budget: { label: 'Presupuesto', visible: canSeeBudgetTab },
  stats: { label: 'Estadísticas', visible: canSeeStatsTab },
  admin: { label: 'Administración', visible: () => !!state.user && state.user.role === 'admin' },
};

// Orden de pestañas según perfil — Calendario siempre primero; el resto se
// ordena por cadencia de uso: lo semanal antes que lo mensual, lo mensual
// antes que lo trimestral. Cada lista se filtra igual por TAB_DEFS[k].visible()
// antes de mostrarse, así que no hace falta que las 3 listas sean excluyentes.
function tabOrderFor() {
  if (isObispadoUser()) {
    // Panel de Obispado ya no está acá (ver ícono junto a la lupa/campana) —
    // para este perfil, Reuniones y Consejos + Asignaciones (cadencia
    // semanal) van primero, Estadísticas al final por ser lo más ocasional.
    return ['calendar', 'meetings', 'cleaning', 'interviews', 'myActivities', 'budget', 'stats', 'admin'];
  }
  if (canSeeInterviewsTab()) {
    // Líder de una organización que agenda entrevistas (Cuórum de Élderes,
    // Sociedad de Socorro): Mis Actividades y Entrevistas primero, por ser
    // las más accionables día a día.
    return ['calendar', 'myActivities', 'interviews', 'meetings', 'budget', 'stats'];
  }
  // Líder de una organización sin entrevistas, o Miembro (a este último le
  // queda filtrado solo Calendario + Mis Actividades de todas formas).
  return ['calendar', 'myActivities', 'meetings', 'budget', 'stats'];
}
// "Reuniones y Asignaciones" y "Estadísticas": visibles para Líder y
// Administrador — los Miembros no las ven en absoluto.
function canSeeMeetingsTab() {
  return !!state.user && (state.user.role === 'admin' || state.user.role === 'leader');
}
function canSeeStatsTab() {
  return !!state.user && (state.user.role === 'admin' || state.user.role === 'leader');
}
// "Asignaciones" (Aseo del Edificio + Discursos): estrictamente oculto
// salvo Administrador o líder de Obispado (reutiliza isObispadoUser, la
// misma regla que Estaca/Presupuesto).
function canSeeAssignmentsTab() {
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
// Foto de perfil (Mi Perfil) si existe, si no las iniciales de siempre.
function userAvatarHtml(u) {
  if (u.profilePhoto) return `<img class="user-avatar" src="${esc(u.profilePhoto)}" alt="${esc(u.name)}" style="object-fit:cover;" />`;
  return `<div class="user-avatar">${esc(initials(u.name))}</div>`;
}

function render() {
  if (!state.user) { renderLogin(); return; }
  const u = state.user;
  if (u.role === 'member' && state.view === 'interviews') state.view = 'calendar';
  root.innerHTML = `
    <div class="topbar">
      <div class="topbar-left">
        <img class="topbar-logo" src="/logo-bee.png" alt="${esc(APP_NAME)}" />
        <div class="topbar-title">${BRAND_WORDMARK_HTML}<small>${esc(u.organization ? u.organization.name : 'Vista general')}</small></div>
      </div>
      <div class="topbar-right">
        ${canSeeBishopricPanelTab() ? `<button type="button" class="icon-btn topbar-icon-btn ${state.view === 'bishopricPanel' ? 'active' : ''}" id="bishopric-toggle" title="Panel de Obispado">⛪</button>` : ''}
        <button type="button" class="icon-btn topbar-icon-btn" id="search-toggle" title="Buscar">🔍</button>
        <button type="button" class="icon-btn topbar-icon-btn" id="notif-toggle" title="Notificaciones">🔔<span class="notif-badge" id="notif-badge" hidden></span></button>
        <button type="button" class="icon-btn topbar-icon-btn" id="tour-toggle" title="Ver recorrido guiado">❓</button>
        <div class="user-chip" id="my-profile-btn" title="Mi Perfil" style="cursor:pointer;">
          ${userAvatarHtml(u)}
          <div>
            <div style="font-weight:600;">${esc(u.name)}</div>
            <span class="role-badge role-${u.role}">${ROLE_LABELS[u.role]}</span>
          </div>
        </div>
        <button class="btn btn-ghost btn-sm" id="logout-btn">Salir</button>
      </div>
    </div>
    <div id="search-panel" class="topbar-dropdown-panel" hidden>
      <div class="search-panel-row">
        <input type="text" id="search-input" placeholder="Buscar actividades, entrevistas, actas, discursos…" autocomplete="off" />
        <button type="button" class="icon-btn" id="search-close">×</button>
      </div>
      <div id="search-results"></div>
    </div>
    <div id="notif-panel" class="topbar-dropdown-panel" hidden>
      <div id="notif-results"></div>
    </div>
    <div class="tabs" id="main-tabs">
      ${tabOrderFor().filter((k) => TAB_DEFS[k].visible()).map((k) => `<button class="tab-btn ${state.view === k ? 'active' : ''}" data-view="${k}">${esc(TAB_DEFS[k].label)}</button>`).join('')}
    </div>
    <main class="view" id="view-root"></main>
    <div id="modal-root"></div>
    <div id="confirm-root"></div>
  `;
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('my-profile-btn').addEventListener('click', () => openProfileModal());
  root.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => { state.view = btn.dataset.view; renderCurrentView(); });
  });
  const bishopricBtn = document.getElementById('bishopric-toggle');
  if (bishopricBtn) bishopricBtn.addEventListener('click', () => { state.view = 'bishopricPanel'; renderCurrentView(); });
  wireTopbarUtilities();
  renderCurrentView();
}

function renderCurrentView() {
  if (state.view === 'interviews' && !canSeeInterviewsTab()) state.view = 'calendar';
  if (state.view === 'myActivities' && !canSeeMyActivitiesTab()) state.view = 'calendar';
  if (state.view === 'budget' && !canSeeBudgetTab()) state.view = 'calendar';
  if (state.view === 'meetings' && !canSeeMeetingsTab()) state.view = 'calendar';
  if (state.view === 'cleaning' && !canSeeAssignmentsTab()) state.view = 'calendar';
  if (state.view === 'stats' && !canSeeStatsTab()) state.view = 'calendar';
  if (state.view === 'bishopricPanel' && !canSeeBishopricPanelTab()) state.view = 'calendar';
  root.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  const bishopricBtn = document.getElementById('bishopric-toggle');
  if (bishopricBtn) bishopricBtn.classList.toggle('active', state.view === 'bishopricPanel');
  if (state.view === 'calendar') renderCalendarView();
  else if (state.view === 'bishopricPanel') renderBishopricPanelView();
  else if (state.view === 'myActivities') renderMyActivitiesView();
  else if (state.view === 'interviews') renderInterviewsView();
  else if (state.view === 'budget') renderBudgetView();
  else if (state.view === 'meetings') renderMeetingsView();
  else if (state.view === 'cleaning') renderAssignmentsView();
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
  const agendaDays = []; // solo para la vista "Agenda": días del mes actual con algo agendado
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
      ...dayInterviews.map((iv) => ({ ...iv, kind: 'interview', title: iv.memberNames || iv.memberName })),
      ...dayStake.map((s) => ({ ...s, kind: 'stake' })),
    ].sort((a, b) => (a.startTime || '00:00').localeCompare(b.startTime || '00:00'));

    if (!otherMonth && items.length) agendaDays.push({ iso, dateObj: cellDate, isToday, items });

    const MAX_SHOW = 3;
    const visible = items.slice(0, MAX_SHOW);
    const extra = items.length - visible.length;

    cellsHtml += `
      <div class="cal-cell ${otherMonth ? 'other-month' : ''} ${isToday ? 'today' : ''}" data-date="${iso}">
        <div class="cal-daynum">${cellDate.getDate()}</div>
        ${visible.map((it) => {
          // Solo se puede arrastrar una actividad real (no entrevistas
          // privadas ni lo sincronizado de Estaca, que es de solo lectura) y
          // solo si la persona tiene permiso para editarla — mismo criterio
          // que decide si al hacer clic se abre el formulario de editar o la
          // ficha de solo lectura (ver openItemModal).
          const draggableEvent = it.kind === 'event' && canEditEventsFor(it.organizationId);
          return `
          <button class="cal-event ${it.kind === 'interview' ? 'is-interview' : ''} ${it.kind === 'stake' ? (it.blocking === false ? 'is-stake is-stake-info' : 'is-stake') : ''} ${draggableEvent ? 'cal-event-draggable' : ''}" style="background:${it.organizationColor}" data-kind="${it.kind}" data-id="${it.id}" ${draggableEvent ? 'draggable="true"' : ''} title="${esc(it.kind === 'stake' && it.allDay ? 'Todo el día' : fmtTime(it.startTime))} ${esc(stakeAwarePrefix(it) + it.title)}${it.location ? ' — ' + esc(locationDisplay(it)) : ''}${draggableEvent ? ' (arrástrala a otro día para moverla)' : ''}">
            ${it.kind === 'stake' ? '🏛️ ' : ''}${esc(it.kind === 'stake' && it.allDay ? 'Todo el día' : fmtTime(it.startTime))} ${it.kind === 'interview' ? '👤' : ''} ${esc(stakeAwarePrefix(it))}${esc(truncateTitle(it.title))}
          </button>`;
        }).join('')}
        ${extra > 0 ? `<button class="cal-more" data-more="${iso}">+${extra} más</button>` : ''}
      </div>`;
  }

  const agendaHtml = agendaDays.length ? agendaDays.map((day) => `
    <div class="agenda-day">
      <div class="agenda-day-header ${day.isToday ? 'is-today' : ''}">${esc(fmtDateHuman(day.iso))}</div>
      <div class="card-list">
        ${day.items.map((it) => `
          <div class="list-card" data-kind="${it.kind}" data-id="${it.id}" style="cursor:pointer;">
            <span class="org-dot" style="background:${it.organizationColor}"></span>
            <div class="lc-main">
              <div class="lc-title">${it.kind === 'interview' ? '👤 ' : it.kind === 'stake' ? '🏛️ ' : eventTitlePrefix(it)}${esc(it.title)}</div>
              <div class="lc-sub">${esc(it.organizationName || '')}${it.location ? ` · <span class="lc-location">📍 ${esc(locationDisplay(it))}</span>` : ''}${it.kind === 'interview' && it.interviewerName ? ` · 🧑‍💼 ${esc(it.interviewerName)}` : ''}${it.kind === 'event' ? involvedOrgsBadgesHtml(it) : ''}</div>
            </div>
            <div class="lc-when">${it.kind === 'stake' && it.allDay ? 'Todo el día' : esc(fmtTime(it.startTime))}${it.endTime ? ' - ' + esc(fmtTime(it.endTime)) : ''}</div>
          </div>`).join('')}
      </div>
    </div>`).join('') : '<div class="empty-state">Sin actividades este mes' + (state.activeOrgIds ? ' con los filtros de organización activos' : '') + '</div>';

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
        <button type="button" class="icon-btn" id="cal-minical-toggle" title="Elegir fecha en un mini calendario">📅</button>
      </div>
      <div class="view-toggle">
        <button type="button" class="view-toggle-btn ${state.calViewMode === 'month' ? 'active' : ''}" id="cal-view-month" title="Vista de mes">🗓️ Mes</button>
        <button type="button" class="view-toggle-btn ${state.calViewMode === 'agenda' ? 'active' : ''}" id="cal-view-agenda" title="Vista de lista">📋 Agenda</button>
      </div>
      ${canManageAnyEvents() ? `<button class="btn btn-primary" id="cal-new-event">+ Nueva actividad</button>` : ''}
    </div>
    <div id="mini-cal-panel" class="mini-cal-panel" hidden></div>
    ${await stakeStatusBarHtml()}
    <div class="org-filters">${chips}</div>
    ${state.calViewMode === 'agenda' ? `
    <div class="agenda-list">${agendaHtml}</div>
    ` : `
    <div class="cal-grid-wrap">
      <div class="cal-grid">
        ${DOW_LABELS.map((d) => `<div class="cal-dow">${d}</div>`).join('')}
        ${cellsHtml}
      </div>
    </div>
    `}
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
  document.getElementById('cal-minical-toggle').addEventListener('click', () => {
    state.miniCalOpen = !state.miniCalOpen;
    if (state.miniCalOpen) state.miniCalMonth = new Date(state.calMonth);
    renderMiniCalPanel();
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
  wireCalendarDragAndDrop(container);
  container.querySelectorAll('[data-more]').forEach((btn) => btn.addEventListener('click', () => openDayModal(btn.dataset.more)));
  document.getElementById('cal-view-month').addEventListener('click', () => { state.calViewMode = 'month'; renderCalendarView(); });
  document.getElementById('cal-view-agenda').addEventListener('click', () => { state.calViewMode = 'agenda'; renderCalendarView(); });
  container.querySelectorAll('.agenda-list .list-card').forEach((row) => row.addEventListener('click', () => {
    if (row.dataset.kind === 'event') {
      openItemModal(state.events.find((e) => e.id === Number(row.dataset.id)), 'event');
    } else if (row.dataset.kind === 'interview') {
      openItemModal(state.interviews.find((i) => i.id === Number(row.dataset.id)), 'interview');
    } else {
      openReadOnlyModal(state.stakeEvents.find((s) => s.id === Number(row.dataset.id)), 'stake');
    }
  }));

  wireStakeStatusBar();
  if (state.miniCalOpen) renderMiniCalPanel();
}

// ---------------- Arrastrar y soltar una actividad a otro día ----------------
// Solo en la vista de mes (la de Agenda no tiene celdas de día) y solo para
// actividades reales editables (ver draggableEvent más arriba) — entrevistas,
// reuniones que no son propias, y lo sincronizado de Estaca no se pueden
// arrastrar. Mover así es equivalente a abrir el formulario de editar y
// cambiar solo la fecha: pasa por la misma alerta de choque (con otra
// organización, o con Estaca) antes de guardar.
function wireCalendarDragAndDrop(container) {
  container.querySelectorAll('.cal-event-draggable').forEach((btn) => {
    btn.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', btn.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      btn.classList.add('dragging');
    });
    btn.addEventListener('dragend', () => btn.classList.remove('dragging'));
  });
  container.querySelectorAll('.cal-cell').forEach((cell) => {
    cell.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/plain')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      cell.classList.add('drag-over');
    });
    cell.addEventListener('dragleave', (e) => {
      if (!cell.contains(e.relatedTarget)) cell.classList.remove('drag-over');
    });
    cell.addEventListener('drop', async (e) => {
      e.preventDefault();
      cell.classList.remove('drag-over');
      const id = Number(e.dataTransfer.getData('text/plain'));
      if (!id) return;
      const item = state.events.find((ev) => ev.id === id);
      if (!item) return;
      await moveEventToDate(item, cell.dataset.date);
    });
  });
}

async function moveEventToDate(item, newDate) {
  if (!newDate || item.date === newDate) return;
  const conflicts = await findConflictingActivities({ ...item, date: newDate }, item.id);
  if (conflicts.length) {
    const list = conflicts.map((c) => `• ${c.organizationName} — ${c.kind === 'interview' ? 'ocupada por una entrevista (privada)' : esc(c.title || '')} · ${fmtTime(c.startTime)}${c.endTime ? ' - ' + fmtTime(c.endTime) : ''}`).join('\n');
    const ok = await confirmModal(`Al moverla al ${fmtDateHuman(newDate)} choca con otra organización:\n\n${list}\n\n¿Moverla de todas formas?`, { title: 'Posible choque de horario/lugar', confirmText: 'Mover de todas formas' });
    if (!ok) return;
  }
  const doMove = async (overrideStakeConflict) => {
    try {
      await api(`/events/${item.id}`, { method: 'PUT', body: overrideStakeConflict ? { date: newDate, overrideStakeConflict: true } : { date: newDate } });
      toast(`Actividad movida al ${fmtDateHuman(newDate)}`);
      await refreshAfterEventChange();
    } catch (e) {
      if (!overrideStakeConflict && e.data?.stakeConflicts?.length && e.data?.canOverride) {
        const fechaTxt = e.data.conflictDate ? ` (fecha ${e.data.conflictDate})` : '';
        const ok2 = await confirmModal(`🏛️ Choca con una actividad de Estaca${fechaTxt}. ¿Autorizar y moverla de todas formas como líder de Obispado?`, { title: 'Choque con Estaca', confirmText: 'Autorizar y mover' });
        if (ok2) await doMove(true);
      } else {
        toast(e.message, 'error');
      }
    }
  };
  await doMove(false);
}

// ---------------- Mini calendario emergente para "Ir a fecha" ----------------
// Alternativa visual al input de fecha nativo (cuya apariencia varía mucho
// entre navegadores/SO): una grilla compacta de días, con su propia
// navegación de mes, para elegir una fecha con el mismo lenguaje visual del
// resto de la app. Se abre EN EL FLUJO NORMAL de la página (empuja el
// contenido hacia abajo, igual que los paneles de búsqueda/notificaciones)
// para que nunca tape ni se corte con otro recuadro en celular.
function renderMiniCalPanel() {
  const panel = document.getElementById('mini-cal-panel');
  if (!panel) return;
  panel.hidden = !state.miniCalOpen;
  if (!state.miniCalOpen) return;
  const monthDate = state.miniCalMonth || new Date(state.calMonth);
  const gridStart = gridStartDate(monthDate);
  const today = new Date();
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart); cellDate.setDate(gridStart.getDate() + i);
    const iso = toISODate(cellDate);
    const otherMonth = cellDate.getMonth() !== monthDate.getMonth();
    const isToday = isSameDay(cellDate, today);
    const hasItems = state.events.some((e) => e.date === iso) || state.interviews.some((iv) => iv.date === iso);
    cells += `<button type="button" class="mini-cal-cell ${otherMonth ? 'other-month' : ''} ${isToday ? 'today' : ''}" data-date="${iso}">${cellDate.getDate()}${hasItems ? '<span class="mini-cal-dot"></span>' : ''}</button>`;
  }
  panel.innerHTML = `
    <div class="mini-cal-nav">
      <button type="button" class="icon-btn" id="mini-cal-prev">‹</button>
      <div class="mini-cal-label">${MONTH_LABELS[monthDate.getMonth()].charAt(0).toUpperCase() + MONTH_LABELS[monthDate.getMonth()].slice(1)} ${monthDate.getFullYear()}</div>
      <button type="button" class="icon-btn" id="mini-cal-next">›</button>
    </div>
    <div class="mini-cal-dow-row">${DOW_LABELS.map((d) => `<div>${d.slice(0, 1)}</div>`).join('')}</div>
    <div class="mini-cal-grid">${cells}</div>
  `;
  document.getElementById('mini-cal-prev').addEventListener('click', () => {
    state.miniCalMonth = addMonths(monthDate, -1);
    renderMiniCalPanel();
  });
  document.getElementById('mini-cal-next').addEventListener('click', () => {
    state.miniCalMonth = addMonths(monthDate, 1);
    renderMiniCalPanel();
  });
  panel.querySelectorAll('.mini-cal-cell').forEach((btn) => btn.addEventListener('click', async () => {
    const iso = btn.dataset.date;
    const [y, m] = iso.split('-').map(Number);
    state.calMonth = new Date(y, m - 1, 1);
    state.miniCalOpen = false;
    await shiftMonth(0, true);
    openDayModal(iso);
  }));
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
    ...state.interviews.filter((iv) => iv.date === iso).map((iv) => ({ ...iv, kind: 'interview', title: iv.memberNames || iv.memberName })),
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

// Reemplaza al confirm() nativo del navegador (que se ve distinto en cada
// sistema operativo y no se puede estilizar) por un modal propio, con el
// mismo lenguaje visual del resto de la app. Vive en su propio contenedor
// #confirm-root (no en #modal-root) para poder abrirse ENCIMA de un modal
// que ya esté abierto (por ejemplo, el botón "Eliminar" dentro del modal de
// editar una actividad) sin destruir ese modal de fondo — al cancelar, el
// modal original sigue intacto tal como estaba.
function confirmModal(message, opts = {}) {
  const { title = 'Confirmar', confirmText = 'Confirmar', cancelText = 'Cancelar', danger = false } = opts;
  return new Promise((resolve) => {
    const root = document.getElementById('confirm-root');
    root.innerHTML = `
      <div class="modal-backdrop confirm-modal-backdrop" id="confirm-backdrop">
        <div class="modal confirm-modal">
          <div class="modal-header"><h3>${esc(title)}</h3></div>
          <div class="modal-body"><p class="confirm-modal-message">${esc(message)}</p></div>
          <div class="modal-footer" style="justify-content:flex-end;">
            <button type="button" class="btn btn-ghost" id="confirm-cancel">${esc(cancelText)}</button>
            <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirm-ok">${esc(confirmText)}</button>
          </div>
        </div>
      </div>`;
    const cleanup = (result) => { root.innerHTML = ''; resolve(result); };
    document.getElementById('confirm-cancel').addEventListener('click', () => cleanup(false));
    document.getElementById('confirm-ok').addEventListener('click', () => cleanup(true));
    document.getElementById('confirm-backdrop').addEventListener('click', (e) => { if (e.target.id === 'confirm-backdrop') cleanup(false); });
    document.getElementById('confirm-ok').focus();
  });
}

// Advierte antes de cerrar un modal si su formulario tiene cambios sin
// guardar, para que un clic accidental en la X, el fondo oscuro o
// "Cancelar" no borre lo que la persona ya escribió. Se llama con el
// <form> del modal justo después de armarlo; devuelve una función que hay
// que usar en los 3 cierres de siempre (botón X, fondo, botón Cancelar) EN
// VEZ de closeModal directo. Si el formulario está limpio, cierra al tiro
// — no agrega fricción a quien no cambió nada.
function wireUnsavedChangesGuard(formEl) {
  if (!formEl) return closeModal;
  let dirty = false;
  formEl.addEventListener('input', () => { dirty = true; });
  formEl.addEventListener('change', () => { dirty = true; });
  return async () => {
    if (dirty) {
      const ok = await confirmModal('Tienes cambios sin guardar en este formulario. ¿Cerrar de todas formas?', { title: 'Cambios sin guardar', confirmText: 'Cerrar sin guardar', danger: true });
      if (!ok) return;
    }
    closeModal();
  };
}

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
      if (!(await confirmModal('¿Generar un enlace nuevo? El enlace anterior deja de funcionar — vas a tener que actualizarlo en tu calendario personal.', { confirmText: 'Generar enlace nuevo' }))) return;
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

// Solo aplica a actividades reales (no a reuniones privadas ni a
// entrevistas ni a lo sincronizado de Estaca) — coincide con la misma
// restricción que ya aplica el servidor en POST /api/events/:id/rsvp.
function rsvpApplies(item, kind) { return kind === 'event' && !item.isMeeting; }

function rsvpSectionHtml(item) {
  const my = item.myRsvp || null;
  return `
    <div class="rsvp-box">
      <div class="rsvp-summary">✅ ${item.rsvpYes || 0} confirmaron${item.rsvpNo ? ` · ❌ ${item.rsvpNo} no van` : ''}</div>
      <div class="rsvp-buttons">
        <button type="button" class="btn btn-sm ${my === 'yes' ? 'btn-primary' : 'btn-secondary'}" id="rsvp-yes">✅ Voy</button>
        <button type="button" class="btn btn-sm ${my === 'no' ? 'btn-primary' : 'btn-secondary'}" id="rsvp-no">❌ No voy</button>
      </div>
    </div>`;
}

async function sendRsvp(eventId, response) {
  try {
    const updated = await api(`/events/${eventId}/rsvp`, { method: 'POST', body: { response } });
    const idx = state.events.findIndex((e) => e.id === eventId);
    if (idx !== -1) state.events[idx] = { ...state.events[idx], ...updated };
    return updated;
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

function wireRsvpButtons(item) {
  const yesBtn = document.getElementById('rsvp-yes');
  const noBtn = document.getElementById('rsvp-no');
  if (!yesBtn || !noBtn) return;
  const handle = (response) => async () => {
    const nextResponse = item.myRsvp === response ? null : response; // clic de nuevo = quitar la respuesta
    const updated = await sendRsvp(item.id, nextResponse);
    if (!updated) return;
    Object.assign(item, updated);
    const box = document.querySelector('.rsvp-box');
    if (box) box.outerHTML = rsvpSectionHtml(item);
    wireRsvpButtons(item);
  };
  yesBtn.addEventListener('click', handle('yes'));
  noBtn.addEventListener('click', handle('no'));
}

function openReadOnlyModal(item, kind) {
  if (!item) return;
  const title = kind === 'interview' ? (item.memberNames || item.memberName) : item.title;
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
          ${kind === 'event' && item.supervisingAdults && item.supervisingAdults.length ? `<div class="ro-detail-row">🧑‍🤝‍🧑 Adultos supervisores: ${item.supervisingAdults.map(esc).join(', ')}</div>` : ''}
          ${kind === 'stake' ? `<div class="hint-box" style="margin-top:10px;">🔗 Sincronizada automáticamente desde el calendario de Estaca — no se puede editar aquí. ${item.blocking === false ? 'Es informativa: no bloquea que se agende algo encima.' : 'Tiene prioridad: no se puede agendar algo encima sin autorización del líder de Obispado.'}</div>` : ''}
          ${rsvpApplies(item, kind) ? rsvpSectionHtml(item) : ''}
        </div>
        <div class="modal-footer" style="justify-content:flex-end;">
          <button class="btn btn-secondary" id="ro-modal-close2">Cerrar</button>
        </div>
      </div>
    </div>`;
  document.getElementById('ro-modal-close').addEventListener('click', closeModal);
  document.getElementById('ro-modal-close2').addEventListener('click', closeModal);
  document.getElementById('ro-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'ro-modal-backdrop') closeModal(); });
  if (rsvpApplies(item, kind)) wireRsvpButtons(item);
}

// ---------------- Punto 4: solicitud de entrevista ----------------
// En vez de que el líder deje horarios abiertos para que cualquiera
// reserve, cualquier usuario pide una entrevista proponiendo fecha, hora y
// un motivo opcional — eligiendo entre las organizaciones que le
// corresponden según el Manual General (ver interviewEligibility en el
// servidor). La solicitud le llega a cualquiera de los líderes de esa
// organización (o siempre al Obispado), quien la confirma (puede ajustar
// la fecha/hora) o la rechaza con un comentario — ver
// server/routes/interview-requests.js.
async function loadMyInterviewRequests() {
  try { return await api('/interview-requests?mine=1'); } catch (e) { return []; }
}

// Solo interesa mostrar acá lo pendiente (para poder retirarlo) y lo
// rechazado (para saber por qué, con el comentario de quien decidió) — lo
// ya confirmado se vuelve una entrevista normal y aparece igual que
// siempre en la lista de arriba, así que repetirlo acá sería redundante.
function myInterviewRequestsSectionHtml(items) {
  const relevant = items.filter((r) => r.status === 'pending' || r.status === 'rejected');
  return `
    <div style="margin:24px 0 8px;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px;">
        <h3 style="font-size:14px; color:var(--celeste-darker); margin:0;">📝 Solicitudes de entrevista</h3>
        <button type="button" class="btn btn-primary btn-sm" id="my-act-request-interview">Solicitar entrevista</button>
      </div>
      ${relevant.length ? `<div class="card-list" id="my-interview-requests-list">
        ${relevant.map((r) => `
          <div class="list-card">
            <span class="org-dot" style="background:${r.organizationColor}"></span>
            <div class="lc-main">
              <div class="lc-title">${esc(r.organizationName)}${r.targetLeaderName ? ' · con ' + esc(r.targetLeaderName) : ''} ${r.status === 'pending' ? '<span class="status-pill status-amber">Esperando confirmación</span>' : '<span class="status-pill status-red">Rechazada</span>'}</div>
              <div class="lc-sub">Propusiste: ${esc(fmtDateHuman(r.date))} · ${esc(fmtTime(r.startTime))}${r.endTime ? ' - ' + esc(fmtTime(r.endTime)) : ''}${r.note ? ' · ' + esc(r.note) : ''}</div>
              ${r.status === 'rejected' && r.decisionComment ? `<div class="lc-sub" style="margin-top:2px; font-style:italic;">💬 ${esc(r.decisionComment)}</div>` : ''}
            </div>
            ${r.status === 'pending' ? `<button type="button" class="btn btn-ghost btn-sm my-req-withdraw" data-id="${r.id}">Retirar</button>` : ''}
          </div>`).join('')}
      </div>` : `<div class="hint-box" style="margin-top:0;">Todavía no has solicitado ninguna entrevista.</div>`}
    </div>`;
}

function wireMyInterviewRequestButtons(onChanged) {
  const newBtn = document.getElementById('my-act-request-interview');
  if (newBtn) newBtn.addEventListener('click', () => openInterviewRequestModal(onChanged));
  document.querySelectorAll('.my-req-withdraw').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!(await confirmModal('¿Retirar esta solicitud de entrevista?', { title: 'Retirar solicitud', confirmText: 'Retirar', danger: true }))) return;
      try {
        await api(`/interview-requests/${btn.dataset.id}`, { method: 'DELETE' });
        toast('Solicitud retirada');
        await onChanged();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

// Modal donde cualquier usuario (Miembro o Líder) pide una entrevista: elige
// la organización (ya filtrada por el servidor según su perfil — sexo/edad),
// propone fecha y hora, y opcionalmente un motivo. La lista de organizaciones
// muestra a quién le va a llegar (el presidente o cualquiera de sus
// consejeros).
async function openInterviewRequestModal(onDone) {
  let data;
  try { data = await api('/interview-requests/orgs'); } catch (e) { toast(e.message, 'error'); return; }
  if (data.profileIncomplete) {
    toast('Completa tu fecha de nacimiento y sexo en "Mi Perfil" antes de solicitar una entrevista', 'error');
    return;
  }
  if (!data.orgs.length) { toast('No hay ninguna organización disponible para agendar una entrevista', 'error'); return; }
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="reqiv-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>Solicitar entrevista</h3><button class="modal-close" id="reqiv-modal-close">×</button></div>
        <div class="modal-body">
          <div id="reqiv-error"></div>
          <form id="reqiv-form">
            <div class="field">
              <label>¿Con quién?</label>
              <select name="organizationId" id="reqiv-org" required>
                ${data.orgs.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}
              </select>
            </div>
            <div class="field" id="reqiv-leader-field">
              <label>¿Con qué líder? (opcional)</label>
              <select id="reqiv-leader"></select>
            </div>
            <div class="hint-box" style="margin-top:0;" id="reqiv-org-hint"></div>
            <div id="reqiv-date-mode-avail" style="display:none;">
              <div class="field">
                <label>Elige un día disponible</label>
                <select id="reqiv-avail-date"></select>
              </div>
              <div class="field">
                <label>Hora dentro de ese rango</label>
                <input type="time" id="reqiv-avail-time" />
              </div>
            </div>
            <div id="reqiv-date-mode-free">
              <div class="two-col">
                <div class="field">
                  <label>Fecha que te acomoda</label>
                  <input type="date" id="reqiv-free-date" />
                </div>
                <div class="field">
                  <label>Hora</label>
                  <input type="time" id="reqiv-free-start" />
                </div>
              </div>
            </div>
            <div class="field">
              <label>Hora de término (opcional)</label>
              <input type="time" id="reqiv-endtime" />
            </div>
            <div class="field">
              <label>Motivo (opcional)</label>
              <textarea name="note" placeholder="Ej: Recomendación para el templo"></textarea>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="reqiv-cancel">Cancelar</button>
            <button class="btn btn-primary" id="reqiv-save">Enviar solicitud</button>
          </div>
        </div>
      </div>
    </div>`;
  const orgsById = Object.fromEntries(data.orgs.map((o) => [String(o.id), o]));
  let upcomingDates = [];

  // Reconstruye el selector de líder según la organización elegida, y deja
  // "Sin preferencia" (fecha/hora libre) como opción por defecto.
  const updateLeaderOptions = () => {
    const org = orgsById[document.getElementById('reqiv-org').value];
    const leaderSelect = document.getElementById('reqiv-leader');
    const leaders = (org && org.leaders) || [];
    leaderSelect.innerHTML = `<option value="">Sin preferencia</option>` + leaders.map((l) => `
      <option value="${l.id}">${esc(l.name)}${l.callingLabel ? ' — ' + esc(l.callingLabel) : (l.isPresident ? ' ★ Presidente' : '')}${l.availability.length ? '' : ' (sin agenda declarada)'}</option>`).join('');
    document.getElementById('reqiv-leader-field').style.display = leaders.length ? '' : 'none';
  };

  // Alterna entre "elige un día disponible" (líder con agenda declarada) y
  // "fecha/hora libre" (sin preferencia, o un líder sin agenda declarada) —
  // y actualiza el texto de a quién le va a llegar la solicitud.
  const updateDateMode = () => {
    const org = orgsById[document.getElementById('reqiv-org').value];
    const leaderSelect = document.getElementById('reqiv-leader');
    const leaders = (org && org.leaders) || [];
    const leader = leaders.find((l) => String(l.id) === leaderSelect.value);
    const hint = document.getElementById('reqiv-org-hint');
    const availDateSelect = document.getElementById('reqiv-avail-date');
    const availTime = document.getElementById('reqiv-avail-time');
    const freeDate = document.getElementById('reqiv-free-date');
    const freeStart = document.getElementById('reqiv-free-start');
    const dates = leader ? computeUpcomingAvailableDates(leader.availability, leader.busy) : [];
    if (leader && leader.availability.length && dates.length) {
      upcomingDates = dates;
      document.getElementById('reqiv-date-mode-avail').style.display = '';
      document.getElementById('reqiv-date-mode-free').style.display = 'none';
      availDateSelect.required = true; availTime.required = true;
      freeDate.required = false; freeStart.required = false;
      availDateSelect.innerHTML = upcomingDates.map((d, i) => `<option value="${i}">${esc(fmtDateHuman(d.date))} (${esc(d.startTime)}–${esc(d.endTime)})</option>`).join('');
      const syncTime = () => {
        const d = upcomingDates[Number(availDateSelect.value)];
        if (!d) return;
        availTime.min = d.startTime; availTime.max = d.endTime; availTime.value = d.startTime;
      };
      availDateSelect.onchange = syncTime;
      syncTime();
      hint.textContent = `Le llegará una confirmación a ${leader.name} — disponible: ${availabilityWindowsSummary(leader.availability)}.`;
    } else {
      document.getElementById('reqiv-date-mode-avail').style.display = 'none';
      document.getElementById('reqiv-date-mode-free').style.display = '';
      availDateSelect.required = false; availTime.required = false;
      freeDate.required = true; freeStart.required = true;
      if (leader && leader.availability.length) {
        hint.textContent = `${leader.name} no tiene horarios libres dentro de sus próximas 6 semanas declaradas (${availabilityWindowsSummary(leader.availability)}) — puedes proponer otra fecha/hora igual, queda sujeta a su confirmación.`;
      } else {
        hint.textContent = leader
          ? `Le llegará a ${leader.name}.`
          : (leaders.length ? `Le llegará a: ${leaders.map((l) => l.name).join(', ')}.` : 'Le llegará a quien corresponda en esa organización.');
      }
    }
  };
  document.getElementById('reqiv-org').addEventListener('change', () => { updateLeaderOptions(); updateDateMode(); });
  document.getElementById('reqiv-leader').addEventListener('change', updateDateMode);
  updateLeaderOptions();
  updateDateMode();
  const guardedClose = wireUnsavedChangesGuard(document.getElementById('reqiv-form'));
  document.getElementById('reqiv-modal-close').addEventListener('click', guardedClose);
  document.getElementById('reqiv-cancel').addEventListener('click', guardedClose);
  document.getElementById('reqiv-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'reqiv-modal-backdrop') guardedClose(); });
  document.getElementById('reqiv-save').addEventListener('click', async () => {
    const form = document.getElementById('reqiv-form');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const usingAvail = document.getElementById('reqiv-date-mode-avail').style.display !== 'none';
    const date = usingAvail ? (upcomingDates[Number(document.getElementById('reqiv-avail-date').value)] || {}).date : document.getElementById('reqiv-free-date').value;
    const startTime = usingAvail ? document.getElementById('reqiv-avail-time').value : document.getElementById('reqiv-free-start').value;
    const body = {
      organizationId: Number(fd.get('organizationId')),
      targetLeaderUserId: document.getElementById('reqiv-leader').value ? Number(document.getElementById('reqiv-leader').value) : null,
      date,
      startTime,
      endTime: document.getElementById('reqiv-endtime').value || null,
      note: fd.get('note') || '',
    };
    try {
      await api('/interview-requests', { method: 'POST', body });
      closeModal();
      toast('Solicitud enviada');
      if (onDone) await onDone();
    } catch (e) {
      document.getElementById('reqiv-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
}

// Punto 4 (ampliación): un Líder declara sus propios días/horas habituales
// de entrevista (p. ej. "martes y jueves, 20:00 a 22:00") — es solo una
// guía para lo que un miembro puede proponer al pedir una entrevista con
// él/ella; no reserva nada ni le impide agendar manualmente ("+ Agendar
// entrevista") un día fuera de lo declarado, para los casos extraordinarios.
function openLeaderAvailabilityModal() {
  let rows = (state.user.interviewAvailability || []).map((w, i) => ({ key: i, ...w }));
  let nextKey = rows.length;
  const modalRoot = document.getElementById('modal-root');
  function renderRows() {
    const list = document.getElementById('avail-rows');
    if (!list) return;
    list.innerHTML = rows.length ? rows.map((r) => `
      <div class="two-col" style="align-items:end; gap:8px;" data-row="${r.key}">
        <div class="field">
          <label>Día</label>
          <select data-field="weekday" data-row="${r.key}">
            ${WEEKDAY_NAMES.map((name, idx) => `<option value="${idx}" ${idx === r.weekday ? 'selected' : ''}>${name.charAt(0).toUpperCase() + name.slice(1)}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="display:flex; gap:8px;">
          <div style="flex:1;">
            <label>Desde</label>
            <input type="time" data-field="startTime" data-row="${r.key}" value="${esc(r.startTime || '20:00')}" />
          </div>
          <div style="flex:1;">
            <label>Hasta</label>
            <input type="time" data-field="endTime" data-row="${r.key}" value="${esc(r.endTime || '22:00')}" />
          </div>
          <button type="button" class="btn btn-ghost btn-sm avail-remove" data-row="${r.key}" title="Quitar" style="align-self:flex-end;">🗑️</button>
        </div>
      </div>`).join('') : '<div class="hint-box" style="margin-top:0;">Todavía no has declarado ningún día habitual — puedes seguir agendando entrevistas manualmente igual.</div>';
    list.querySelectorAll('select[data-field], input[data-field]').forEach((el) => {
      el.addEventListener('change', () => {
        const row = rows.find((r) => r.key === Number(el.dataset.row));
        if (!row) return;
        const val = el.dataset.field === 'weekday' ? Number(el.value) : el.value;
        row[el.dataset.field] = val;
      });
    });
    list.querySelectorAll('.avail-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        rows = rows.filter((r) => r.key !== Number(btn.dataset.row));
        renderRows();
      });
    });
  }
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="avail-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>🗓️ Mi disponibilidad para entrevistas</h3><button class="modal-close" id="avail-modal-close">×</button></div>
        <div class="modal-body">
          <p class="hint-box" style="margin-top:0;">Declara los días y horas de la semana en que sueles recibir entrevistas (ej. martes y jueves de 20:00 a 22:00). Cuando un miembro pida una entrevista contigo, solo podrá proponer esos días — igual puedes agendar tú manualmente una entrevista extraordinaria fuera de estos horarios cuando haga falta.</p>
          <div id="avail-error"></div>
          <div id="avail-rows"></div>
          <button type="button" class="btn btn-secondary btn-sm" id="avail-add" style="margin-top:10px;">+ Agregar día</button>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="avail-cancel">Cancelar</button>
            <button class="btn btn-primary" id="avail-save">Guardar</button>
          </div>
        </div>
      </div>
    </div>`;
  renderRows();
  document.getElementById('avail-modal-close').addEventListener('click', closeModal);
  document.getElementById('avail-cancel').addEventListener('click', closeModal);
  document.getElementById('avail-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'avail-modal-backdrop') closeModal(); });
  document.getElementById('avail-add').addEventListener('click', () => {
    rows.push({ key: nextKey++, weekday: 2, startTime: '20:00', endTime: '22:00' });
    renderRows();
  });
  document.getElementById('avail-save').addEventListener('click', async () => {
    for (const r of rows) {
      if (!r.startTime || !r.endTime || r.startTime >= r.endTime) {
        document.getElementById('avail-error').innerHTML = `<div class="error-msg">La hora de término debe ser después de la de inicio</div>`;
        return;
      }
    }
    const windows = rows.map((r) => ({ weekday: r.weekday, startTime: r.startTime, endTime: r.endTime }));
    try {
      const updated = await api('/auth/me/availability', { method: 'PUT', body: { windows } });
      state.user = updated;
      closeModal();
      toast('Disponibilidad guardada');
      if (state.view === 'interviews') await renderInterviewsView();
    } catch (e) {
      document.getElementById('avail-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
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
  container.innerHTML = skeletonViewHtml('Mis Actividades', { cards: 4 });
  let events, interviews;
  try { events = await api('/events'); } catch (e) { toast(e.message, 'error'); events = []; }
  // Si otra organización te entrevista a TI (por ejemplo, el líder de
  // Obispado entrevista al líder de Cuórum de Élderes), esa entrevista debe
  // aparecerte acá aunque no la haya agendado tu propia organización.
  try { interviews = await api('/interviews'); } catch (e) { interviews = []; }
  // Punto 4: mis solicitudes de entrevista pendientes o rechazadas (las ya
  // confirmadas aparecen arriba como una entrevista normal).
  const myRequests = await loadMyInterviewRequests();
  const myOrgId = Number(state.user.organizationId);
  // Además de tu propia organización (siempre, no es opcional — la
  // administras tú), podés seguir otras organizaciones igual que un
  // Miembro — por ejemplo si tienes hijos en Primaria.
  const followedIds = (state.user.followedOrganizationIds || []).map(Number);
  events = events.filter((ev) => Number(ev.organizationId) === myOrgId || ev.isWardActivity
    || followedIds.includes(Number(ev.organizationId))
    || (ev.involvedOrganizations || []).some((o) => Number(o.id) === myOrgId || followedIds.includes(Number(o.id))));
  // Cada entrevista puede ahora citar a más de una persona (matrimonio,
  // compañerismo de ministración): si a mí me entrevistaron junto con otra
  // persona y yo no fui la primera en agendarse, mi propio memberUserId
  // puede no coincidir con el `memberUserId` de nivel superior (que es el de
  // la primera persona del grupo) — por eso se revisa dentro de `members`.
  const myOwnInterviews = interviews.filter((iv) => (Array.isArray(iv.members) && iv.members.length ? iv.members : [iv]).some((m) => Number(m.memberUserId) === Number(state.user.id)));
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
        </div>`).join('') : emptyStateHtml('Todavía no tienes actividades agendadas', { id: 'my-act-empty-new', label: '+ Agregar la primera' })}
    </div>
    ${myInterviewRequestsSectionHtml(myRequests)}
  `;

  document.getElementById('my-act-new').addEventListener('click', () => openEventModal());
  wireEmptyStateCta('my-act-empty-new', () => openEventModal());
  wireMyInterviewRequestButtons(renderMyActivitiesLeaderView);
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
    // Los .list-card de "Horarios de entrevista disponibles" (Punto 4) no
    // tienen data-kind/data-id — son horarios, no actividades/entrevistas —
    // así que no corresponde abrirles el modal de detalle.
    if (!card.dataset.kind) return;
    const it = list.find((x) => x.kind === card.dataset.kind && x.id === Number(card.dataset.id));
    if (!it) return;
    openItemModal(it, it.kind);
  }));
}

async function renderMyActivitiesMemberView() {
  const container = document.getElementById('view-root');
  container.innerHTML = skeletonViewHtml('Mis Actividades', { cards: 4 });
  let events, myInterviews;
  try { events = await api('/events'); } catch (e) { toast(e.message, 'error'); events = []; }
  // Si algún líder te agendó una entrevista eligiéndote de la lista de
  // usuarios registrados, el servidor la devuelve acá aunque la sección
  // Entrevistas no esté disponible para el perfil Miembro.
  try { myInterviews = await api('/interviews'); } catch (e) { myInterviews = []; }
  // Punto 4: mis solicitudes de entrevista pendientes o rechazadas (las ya
  // confirmadas aparecen arriba como una entrevista normal).
  const myRequests = await loadMyInterviewRequests();
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
    ${myInterviewRequestsSectionHtml(myRequests)}
  `;

  document.getElementById('my-act-export').addEventListener('click', () => openCalendarExportModal());
  wireMyInterviewRequestButtons(renderMyActivitiesMemberView);
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
    // Los .list-card de "Horarios de entrevista disponibles" (Punto 4) no
    // tienen data-kind/data-id — son horarios, no actividades/entrevistas —
    // así que no corresponde abrirles el modal de detalle.
    if (!card.dataset.kind) return;
    const it = list.find((x) => x.kind === card.dataset.kind && x.id === Number(card.dataset.id));
    if (!it) return;
    openItemModal(it, it.kind);
  }));
}

// Punto 11 — aviso (no bloqueante) de actividad en lunes por la noche: el
// Manual General reserva esa noche para la Noche de Hogar (20.7.1) — es
// puramente informativo, no impide crear o guardar la actividad.
function isMondayEveningISO(dateISO, startTime) {
  if (!dateISO || !startTime) return false;
  const [y, m, d] = dateISO.split('-').map(Number);
  if (!y || !m || !d) return false;
  const isMonday = new Date(y, m - 1, d).getDay() === 1;
  return isMonday && startTime >= '18:00';
}

function mondayWarningHtml() {
  return `<div class="hint-box" style="margin-top:0; border-color:#fde68a; background:#fef3c7; color:#92400e;">⚠️ Es lunes en la noche — esa noche normalmente está reservada para la Noche de Hogar (Manual General 20.7.1). Puedes seguir igual si hace falta, esto es solo un recordatorio.</div>`;
}

// Punto 13 — en actividades de Hombres Jóvenes, Mujeres Jóvenes y Primaria
// es obligación dejar registrados los nombres de al menos 2 adultos
// supervisores (Manual General 20.7.1) — el servidor lo exige igual (ver
// SUPERVISION_REQUIRED_ORG_NAMES en events.js), esto es para que quede
// claro de entrada en el formulario y no rebote recién al guardar.
const SUPERVISION_REQUIRED_ORG_NAMES = ['Hombres Jóvenes', 'Mujeres Jóvenes', 'Primaria'];

function orgRequiresSupervisingAdultsClient(orgId) {
  const org = orgById(Number(orgId));
  return !!org && SUPERVISION_REQUIRED_ORG_NAMES.includes(org.name);
}

function supervisingAdultRowHtml(name = '') {
  return `
    <div class="commitment-row" style="display:flex; align-items:center; gap:8px; padding:0; border:none; margin-bottom:8px;">
      <input type="text" class="sa-name-input" required placeholder="Nombre del adulto" value="${esc(name)}" style="flex:1;" />
      <button type="button" class="btn btn-ghost btn-sm sa-remove">🗑️</button>
    </div>`;
}

function supervisingAdultsFieldHtml(existingAdults) {
  const names = (existingAdults && existingAdults.length ? existingAdults : ['', '']);
  return `
    <div class="field" id="ev-sa-field">
      <label>Adultos supervisores (obligatorio — mínimo 2)</label>
      <div class="hint-box" style="margin-top:0; margin-bottom:8px;">El Manual General exige que estas actividades cuenten con al menos dos adultos supervisores registrados (20.7.1).</div>
      <div id="ev-sa-rows">${names.map((n) => supervisingAdultRowHtml(n)).join('')}</div>
      <button type="button" class="btn btn-secondary btn-sm" id="ev-sa-add">+ Agregar adulto</button>
    </div>`;
}

function wireSupervisingAdultsRows() {
  const rows = document.getElementById('ev-sa-rows');
  if (!rows) return;
  const wireRow = (row) => row.querySelector('.sa-remove').addEventListener('click', () => {
    if (rows.children.length > 2) row.remove();
  });
  Array.from(rows.children).forEach(wireRow);
  const addBtn = document.getElementById('ev-sa-add');
  if (addBtn) addBtn.addEventListener('click', () => {
    rows.insertAdjacentHTML('beforeend', supervisingAdultRowHtml());
    wireRow(rows.lastElementChild);
  });
}

function updateSupervisingAdultsSection(orgId, existingAdults) {
  const box = document.getElementById('ev-supervising-field');
  if (!box) return;
  if (orgRequiresSupervisingAdultsClient(orgId)) {
    box.innerHTML = supervisingAdultsFieldHtml(existingAdults);
    wireSupervisingAdultsRows();
  } else {
    box.innerHTML = '';
  }
}

function openEventModal(existing = null) {
  const options = editableOrgOptions('event');
  if (!existing && options.length === 0) { toast('No tienes una organización asignada para crear actividades', 'error'); return; }
  const isEdit = !!existing;
  // Si ya trae algo cargado en un campo "avanzado" (es una Reunión, es de
  // todo el Barrio, o ya tiene organizaciones involucradas), la sección
  // arranca abierta — para no esconder de entrada una configuración que la
  // persona ya eligió y quizás necesite volver a revisar o cambiar.
  const hasAdvancedData = !!existing?.isMeeting || !!existing?.isWardActivity
    || (existing?.involvedOrganizationIds && existing.involvedOrganizationIds.length > 0)
    || (existing?.involvedOrganizations && existing.involvedOrganizations.length > 0);
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
            <div id="ev-supervising-field">${orgRequiresSupervisingAdultsClient(existing?.organizationId ?? options[0]?.id) ? supervisingAdultsFieldHtml(existing?.supervisingAdults) : ''}</div>
            <div class="field">
              <label>Descripción de la actividad</label>
              <input type="text" name="title" required placeholder="Ej: Reunión de presidencia de Cuórum" value="${esc(existing?.title || '')}" />
            </div>
            ${advancedOptionsToggleHtml('ev', hasAdvancedData)}
            <div id="ev-advanced-fields" style="${hasAdvancedData ? '' : 'display:none;'}">
              ${eventTypeFieldHtml('ev', !!existing?.isMeeting)}
              ${wardActivityFieldHtml('ev', !!existing?.isWardActivity)}
              ${involvedOrgsFieldHtml('ev', existing?.involvedOrganizationIds || (existing?.involvedOrganizations || []).map((o) => o.id))}
              ${!isEdit ? recurrenceFieldHtml('ev') : ''}
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
            <div id="ev-monday-warning"></div>
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

  const evGuardedClose = wireUnsavedChangesGuard(document.getElementById('ev-form'));
  document.getElementById('ev-modal-close').addEventListener('click', evGuardedClose);
  document.getElementById('ev-cancel').addEventListener('click', evGuardedClose);
  document.getElementById('ev-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'ev-modal-backdrop') evGuardedClose(); });
  if (isEdit) document.getElementById('ev-delete').addEventListener('click', async () => {
    if (!(await confirmModal('¿Eliminar esta actividad?', { title: 'Eliminar actividad', confirmText: 'Eliminar', danger: true }))) return;
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

  // Punto 11: aviso no bloqueante si la actividad cae un lunes en la noche.
  const updateMondayWarning = () => {
    const dateVal = form.querySelector('[name="date"]').value;
    const startVal = form.querySelector('[name="startTime"]').value;
    document.getElementById('ev-monday-warning').innerHTML = isMondayEveningISO(dateVal, startVal) ? mondayWarningHtml() : '';
  };
  form.querySelector('[name="date"]').addEventListener('change', updateMondayWarning);
  form.querySelector('[name="startTime"]').addEventListener('change', updateMondayWarning);
  updateMondayWarning();

  wireSupervisingAdultsRows();

  const orgSelectEl = document.getElementById('ev-org-select');
  refreshInvolvedOrgOptions('ev', orgSelectEl.value);
  orgSelectEl.addEventListener('change', () => {
    refreshInvolvedOrgOptions('ev', orgSelectEl.value);
    updateSupervisingAdultsSection(orgSelectEl.value);
    resetConflictCheck();
  });
  document.querySelectorAll('#ev-involved-orgs input[type="checkbox"]').forEach((cb) => cb.addEventListener('change', resetConflictCheck));
  wireWardActivityField('ev', '#ev-involved-orgs-field', resetConflictCheck);
  if (!isEdit) wireRecurrenceField('ev');
  wireAdvancedOptionsToggle('ev');

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
    body.supervisingAdults = orgRequiresSupervisingAdultsClient(body.organizationId)
      ? Array.from(document.querySelectorAll('#ev-sa-rows .sa-name-input')).map((i) => i.value.trim()).filter(Boolean)
      : [];

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
        if (await confirmModal(`🏛️ Choca con una actividad de Estaca${fechaTxt}. ¿Autorizar y agendar de todas formas como líder de Obispado?`, { title: 'Choque con Estaca', confirmText: 'Autorizar y agendar' })) {
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
// Pestaña principal: solo las que todavía están pendientes de verificar
// (status=scheduled) — sin límite de fecha, para que una entrevista
// atrasada que nadie marcó siga apareciendo hasta que alguien la revise
// (antes desaparecía sola a los 120 días sin dejar rastro).
async function loadInterviewsPending() {
  const params = state.interviewOrgFilter !== 'all' ? `&organizationId=${state.interviewOrgFilter}` : '';
  return api(`/interviews?status=scheduled${params}`);
}
// Historial: las ya marcadas ✅ Se hizo / ❌ No se hizo, más recientes primero.
async function loadInterviewsHistory() {
  const params = state.interviewOrgFilter !== 'all' ? `&organizationId=${state.interviewOrgFilter}` : '';
  return api(`/interviews?status=history${params}`);
}

function interviewStatusPillHtml(status) {
  if (status === 'done') return `<span class="status-pill status-green">✅ Se hizo</span>`;
  if (status === 'not_done') return `<span class="status-pill status-red">❌ No se hizo</span>`;
  return `<span class="status-pill status-amber">Por verificar</span>`;
}

// Si se citó a más de una persona a la vez (matrimonio, compañerismo de
// ministración), muestra una línea con el historial de cada una por
// separado (cada quien tiene su propio conteo de "veces entrevistado", no
// se mezclan); si es una sola persona, la línea de siempre.
function interviewStatsLine(iv) {
  const members = Array.isArray(iv.members) && iv.members.length
    ? iv.members
    : [{ memberName: iv.memberName, timesInterviewed: iv.timesInterviewed, lastInterviewDate: iv.lastInterviewDate }];
  if (members.length === 1) {
    const m = members[0];
    const times = m.timesInterviewed === 1 ? '1 vez' : `${m.timesInterviewed || 0} veces`;
    return `Se le ha entrevistado ${times} en total${m.lastInterviewDate ? ' · última vez ' + esc(fmtDateHuman(m.lastInterviewDate)) : ''}`;
  }
  return members.map((m) => {
    const times = m.timesInterviewed === 1 ? '1 vez' : `${m.timesInterviewed || 0} veces`;
    return `${esc(m.memberName)}: ${times}${m.lastInterviewDate ? ' (última: ' + esc(fmtDateHuman(m.lastInterviewDate)) + ')' : ''}`;
  }).join(' · ');
}

async function renderInterviewsView() {
  const container = document.getElementById('view-root');
  const seesAll = canViewAllInterviews();
  const interviewOrgs = state.organizations.filter((o) => o.allowsInterviews && (seesAll || o.id === state.user.organizationId));
  const canManage = canManageAnyInterviews();
  container.innerHTML = skeletonViewHtml('Entrevistas', { cards: 3 });
  // Punto 4: solicitudes de entrevista (el propio miembro/líder propone
  // fecha/hora) que le corresponde decidir a ESTA persona — su propia
  // organización, o todas si es líder de Obispado/Administrador. Se piden
  // siempre (aunque el subtab no esté abierto) para poder mostrar "cuántas
  // hay pendientes" en el botón, sin tener que entrar primero.
  let requests = [];
  if (canManage) { try { requests = await api('/interview-requests'); } catch (e) { requests = []; } }
  const pendingRequests = requests.filter((r) => r.status === 'pending');
  const decidedRequests = requests.filter((r) => r.status !== 'pending');

  if (canManage && state.interviewsSubtab === 'requests') {
    container.innerHTML = `
      <div class="section-header">
        <div>
          <h2>Entrevistas</h2>
          <p>Solicitudes de entrevista por confirmar o rechazar</p>
        </div>
        <div style="display:flex; gap:8px;">
          ${state.user.role === 'leader' ? `<button class="btn btn-secondary" id="iv-avail">🗓️ Mi disponibilidad</button>` : ''}
          <button class="btn btn-primary" id="iv-new">+ Agendar entrevista</button>
        </div>
      </div>
      <div class="subtabs">
        <button class="subtab-btn" data-tab="pending">🗓️ Agenda</button>
        <button class="subtab-btn active" data-tab="requests">📥 Solicitudes${pendingRequests.length ? ` <span style="background:var(--celeste);color:#fff;border-radius:999px;padding:1px 7px;font-size:11px;margin-left:4px;">${pendingRequests.length}</span>` : ''}</button>
      </div>
      <div class="card-list">
        ${pendingRequests.length ? pendingRequests.map((r) => interviewRequestRowHtml(r)).join('') : emptyStateHtml('No hay solicitudes de entrevista pendientes')}
      </div>
      ${decidedRequests.length ? `
        <button type="button" class="btn btn-secondary btn-sm" id="ivreq-history-toggle" style="margin-top:16px;">
          ${state.interviewRequestsHistoryOpen ? '▲ Ocultar historial' : `📜 Ver historial (${decidedRequests.length} solicitud${decidedRequests.length === 1 ? '' : 'es'} decidida${decidedRequests.length === 1 ? '' : 's'})`}
        </button>
        <div class="card-list" style="margin-top:10px;">
          ${state.interviewRequestsHistoryOpen ? decidedRequests.map((r) => interviewRequestRowHtml(r)).join('') : ''}
        </div>` : ''}
    `;
    const newBtn = document.getElementById('iv-new');
    if (newBtn) newBtn.addEventListener('click', () => openInterviewModal());
    const availBtn = document.getElementById('iv-avail');
    if (availBtn) availBtn.addEventListener('click', () => openLeaderAvailabilityModal());
    container.querySelectorAll('.subtab-btn').forEach((b) => b.addEventListener('click', () => { state.interviewsSubtab = b.dataset.tab; renderInterviewsView(); }));
    const historyToggle = document.getElementById('ivreq-history-toggle');
    if (historyToggle) historyToggle.addEventListener('click', () => { state.interviewRequestsHistoryOpen = !state.interviewRequestsHistoryOpen; renderInterviewsView(); });
    container.querySelectorAll('.ivreq-confirm-btn').forEach((b) => b.addEventListener('click', () => {
      const r = pendingRequests.find((x) => x.id === Number(b.dataset.id));
      if (r) openConfirmRequestModal(r);
    }));
    container.querySelectorAll('.ivreq-reject-btn').forEach((b) => b.addEventListener('click', () => {
      const r = pendingRequests.find((x) => x.id === Number(b.dataset.id));
      if (r) openRejectRequestModal(r);
    }));
    return;
  }

  let list;
  try { list = await loadInterviewsPending(); } catch (e) { toast(e.message, 'error'); list = []; }
  // Se pide siempre (esté abierto o no el desplegable) para poder mostrar
  // "cuántas hay" en el botón de "Ver historial" sin tener que abrirlo primero.
  let history = [];
  try { history = await loadInterviewsHistory(); } catch (e) { history = []; }

  const grouped = {};
  for (const iv of list) { (grouped[iv.date] ||= []).push(iv); }
  const dates = Object.keys(grouped).sort();

  container.innerHTML = `
    <div class="section-header">
      <div>
        <h2>Entrevistas</h2>
        <p>${seesAll ? 'Agendadas por los líderes de Obispado, Cuórum de Élderes y Sociedad de Socorro' : 'Entrevistas de tu organización · información privada, no visible para otras organizaciones'}</p>
      </div>
      <div style="display:flex; gap:8px;">
        ${state.user.role === 'leader' ? `<button class="btn btn-secondary" id="iv-avail">🗓️ Mi disponibilidad</button>` : ''}
        ${canManage ? `<button class="btn btn-primary" id="iv-new">+ Agendar entrevista</button>` : ''}
      </div>
    </div>
    ${canManage ? `
    <div class="subtabs">
      <button class="subtab-btn active" data-tab="pending">🗓️ Agenda</button>
      <button class="subtab-btn" data-tab="requests">📥 Solicitudes${pendingRequests.length ? ` <span style="background:var(--celeste);color:#fff;border-radius:999px;padding:1px 7px;font-size:11px;margin-left:4px;">${pendingRequests.length}</span>` : ''}</button>
    </div>` : ''}
    ${interviewOrgs.length > 1 ? `
    <div class="subtabs">
      <button class="subtab-btn ${state.interviewOrgFilter === 'all' ? 'active' : ''}" data-org="all">Todas</button>
      ${interviewOrgs.map((o) => `<button class="subtab-btn ${String(state.interviewOrgFilter) === String(o.id) ? 'active' : ''}" data-org="${o.id}">${esc(o.name)}</button>`).join('')}
    </div>` : ''}
    ${dates.length ? `<div class="hint-box" style="margin-top:0;">Cuando la entrevista ya se realizó (o no se pudo hacer), márcala con ✅ o ❌ — puedes agregar un comentario opcional. Pasa automáticamente al historial y ya no queda pendiente acá.</div>` : ''}
    <div class="card-list">
      ${dates.length ? dates.map((d) => `
        <div style="margin-bottom:6px;">
          <div style="font-size:12.5px; font-weight:700; color:var(--celeste-dark); text-transform:capitalize; margin:14px 0 6px;">${esc(fmtDateHuman(d))}</div>
          ${grouped[d].map((iv) => `
            <div class="list-card">
              <span class="org-dot" style="background:${iv.organizationColor}"></span>
              <div class="lc-main">
                <div class="lc-title">${esc(iv.memberNames || iv.memberName)}${(iv.members || []).some((m) => m.memberUserId) ? ' <span title="Vinculada a un usuario registrado — le aparece en su Mis Actividades" style="font-weight:400; font-size:12px; color:var(--celeste-dark);">🔗 registrado</span>' : ''}</div>
                <div class="lc-sub">${esc(iv.organizationName)}${iv.location ? ` · <span class="lc-location">📍 ${esc(locationDisplay(iv))}</span>` : ''}${iv.interviewerName ? ` · 🧑‍💼 ${esc(iv.interviewerName)}` : ''}${iv.description ? ' · ' + esc(iv.description) : ''}${(iv.members || []).length === 1 && iv.memberPhone ? ' · ' + esc(iv.memberPhone) : ''}</div>
                <div class="lc-sub" style="margin-top:2px;">${interviewStatsLine(iv)}</div>
              </div>
              <div class="lc-when">${esc(fmtTime(iv.startTime))}${iv.endTime ? ' - ' + esc(fmtTime(iv.endTime)) : ''}</div>
              ${canScheduleInterviewsFor(iv.organizationId) ? `
              <div class="lc-actions">
                <button type="button" class="btn btn-ghost btn-sm iv-mark" data-id="${iv.id}" data-status="done" title="Se hizo">✅</button>
                <button type="button" class="btn btn-ghost btn-sm iv-mark" data-id="${iv.id}" data-status="not_done" title="No se hizo">❌</button>
                <button class="btn btn-secondary btn-sm" data-edit-iv="${iv.id}">Editar</button>
              </div>` : ''}
            </div>`).join('')}
        </div>`).join('') : emptyStateHtml('No hay entrevistas pendientes de agendar o verificar', canManage ? { id: 'iv-empty-new', label: '+ Agendar la primera' } : null)}
    </div>
    ${history.length ? `
      <button type="button" class="btn btn-secondary btn-sm" id="iv-history-toggle" style="margin-top:16px;">
        ${state.interviewsHistoryOpen ? '▲ Ocultar historial' : `📜 Ver historial (${history.length} entrevista${history.length === 1 ? '' : 's'} verificada${history.length === 1 ? '' : 's'})`}
      </button>
      <div class="card-list" style="margin-top:10px;">
        ${state.interviewsHistoryOpen ? history.map((iv) => interviewHistoryCardHtml(iv)).join('') : ''}
      </div>` : ''}
  `;

  const newBtn = document.getElementById('iv-new');
  if (newBtn) newBtn.addEventListener('click', () => openInterviewModal());
  const availBtn = document.getElementById('iv-avail');
  if (availBtn) availBtn.addEventListener('click', () => openLeaderAvailabilityModal());
  wireEmptyStateCta('iv-empty-new', () => openInterviewModal());
  container.querySelectorAll('.subtabs .subtab-btn[data-tab]').forEach((b) => b.addEventListener('click', () => { state.interviewsSubtab = b.dataset.tab; renderInterviewsView(); }));
  container.querySelectorAll('.subtabs .subtab-btn[data-org]').forEach((b) => b.addEventListener('click', () => { state.interviewOrgFilter = b.dataset.org === 'all' ? 'all' : Number(b.dataset.org); renderInterviewsView(); }));
  container.querySelectorAll('[data-edit-iv]').forEach((b) => b.addEventListener('click', () => {
    const iv = list.find((i) => i.id === Number(b.dataset.editIv));
    openInterviewModal(iv);
  }));
  container.querySelectorAll('.iv-mark').forEach((b) => b.addEventListener('click', () => {
    const iv = list.find((i) => i.id === Number(b.dataset.id));
    if (iv) openInterviewMarkModal(iv, b.dataset.status);
  }));
  const historyToggle = document.getElementById('iv-history-toggle');
  if (historyToggle) historyToggle.addEventListener('click', () => { state.interviewsHistoryOpen = !state.interviewsHistoryOpen; renderInterviewsView(); });
  wireInterviewHistoryCards(history);
}

// Tarjeta de UNA solicitud de entrevista — pendiente (con Confirmar/
// Rechazar) o ya decidida (solo lectura, para el historial).
function interviewRequestRowHtml(r) {
  const statusPill = r.status === 'pending'
    ? '<span class="status-pill status-amber">Pendiente</span>'
    : r.status === 'confirmed'
      ? '<span class="status-pill status-green">Confirmada</span>'
      : '<span class="status-pill status-red">Rechazada</span>';
  return `
    <div class="list-card">
      <span class="org-dot" style="background:${r.organizationColor}"></span>
      <div class="lc-main">
        <div class="lc-title">${esc(r.memberName)} ${statusPill}</div>
        <div class="lc-sub">${esc(r.organizationName)}${r.targetLeaderName ? ' · con ' + esc(r.targetLeaderName) : ''} · propone ${esc(fmtDateHuman(r.date))} · ${esc(fmtTime(r.startTime))}${r.endTime ? ' - ' + esc(fmtTime(r.endTime)) : ''}${r.note ? ' · ' + esc(r.note) : ''}</div>
        ${r.status === 'rejected' && r.decisionComment ? `<div class="lc-sub" style="margin-top:2px; font-style:italic;">💬 ${esc(r.decisionComment)}</div>` : ''}
        ${r.status !== 'pending' && r.decidedByName ? `<div class="lc-sub" style="margin-top:2px;">Decidida por ${esc(r.decidedByName)}</div>` : ''}
      </div>
      ${r.status === 'pending' ? `
      <div class="lc-actions">
        <button type="button" class="btn btn-primary btn-sm ivreq-confirm-btn" data-id="${r.id}">Confirmar</button>
        <button type="button" class="btn btn-ghost btn-sm ivreq-reject-btn" data-id="${r.id}">Rechazar</button>
      </div>` : ''}
    </div>`;
}

// editable=false, de solo lectura: muestra el estado (pill), el comentario
// si se dejó uno, y CADA nombre (si se citó a más de una persona a la vez)
// se puede apretar por separado para ver el historial completo de esa
// persona en particular (igual que en Discursos) — el historial de "veces
// entrevistado" nunca se mezcla entre las personas de un mismo grupo.
function interviewHistoryCardHtml(iv) {
  const members = Array.isArray(iv.members) && iv.members.length ? iv.members : [{ memberName: iv.memberName, memberUserId: iv.memberUserId }];
  const namesHtml = members.map((m, idx) => {
    const sep = idx === 0 ? '' : (idx === members.length - 1 ? ' y ' : ', ');
    return `${sep}<span class="clickable-name iv-history-name" data-member-name="${esc(m.memberName)}" data-member-user-id="${m.memberUserId || ''}" title="Ver historial completo de entrevistas">${esc(m.memberName)}</span>`;
  }).join('');
  return `
    <div class="list-card" data-id="${iv.id}">
      <span class="org-dot" style="background:${iv.organizationColor}"></span>
      <div class="lc-main">
        <div class="lc-title">
          ${namesHtml}
          ${interviewStatusPillHtml(iv.status)}
        </div>
        <div class="lc-sub">${esc(iv.organizationName)}${iv.interviewerName ? ` · 🧑‍💼 ${esc(iv.interviewerName)}` : ''}${iv.description ? ' · ' + esc(iv.description) : ''}</div>
        ${iv.comment ? `<div class="lc-sub" style="margin-top:2px; font-style:italic;">💬 ${esc(iv.comment)}</div>` : ''}
        <div class="lc-sub" style="margin-top:2px;">${interviewStatsLine(iv)}</div>
      </div>
      <div class="lc-when">${esc(fmtDateHuman(iv.date))}</div>
      ${canScheduleInterviewsFor(iv.organizationId) ? `<div class="lc-actions"><button type="button" class="btn btn-ghost btn-sm iv-history-delete" data-id="${iv.id}" title="Eliminar del historial">🗑️</button></div>` : ''}
    </div>`;
}

function wireInterviewHistoryCards(history) {
  // openInterviewMemberDetailModal espera una lista PLANA (una fila por
  // persona por entrevista, como toda la vida) — se aplana acá el historial
  // agrupado que llega del servidor (un grupo puede tener varias personas).
  const flatHistory = history.flatMap((iv) => {
    const members = Array.isArray(iv.members) && iv.members.length ? iv.members : [{ memberName: iv.memberName, memberUserId: iv.memberUserId }];
    return members.map((m) => ({ date: iv.date, status: iv.status, comment: iv.comment, memberName: m.memberName, memberUserId: m.memberUserId }));
  });
  document.querySelectorAll('.iv-history-name').forEach((el) => {
    el.addEventListener('click', () => openInterviewMemberDetailModal(el.dataset.memberName, el.dataset.memberUserId, flatHistory));
  });
  document.querySelectorAll('.iv-history-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!(await confirmModal('¿Eliminar definitivamente este registro del historial? Esta acción no se puede deshacer.', { title: 'Eliminar del historial', confirmText: 'Eliminar', danger: true }))) return;
      try {
        await api(`/interviews/${btn.dataset.id}`, { method: 'DELETE' });
        toast('Registro eliminado del historial');
        await renderInterviewsView();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

function interviewMemberKeyClient(memberName, memberUserId) {
  return memberUserId ? `u:${memberUserId}` : `n:${normalizeSearchText(memberName)}`;
}

// Detalle de una persona: todo su historial de entrevistas ya verificadas
// (fecha, estado y comentario) — mismo espíritu que openSpeakerDetailModal
// en Discursos, para poder "revisar a la persona completa" de un vistazo.
function openInterviewMemberDetailModal(memberName, memberUserId, allHistory) {
  const key = interviewMemberKeyClient(memberName, memberUserId);
  const mine = allHistory.filter((iv) => interviewMemberKeyClient(iv.memberName, iv.memberUserId) === key).sort((a, b) => b.date.localeCompare(a.date));
  const doneCount = mine.filter((iv) => iv.status === 'done').length;
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="ivmd-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>👤 ${esc(memberName)}</h3><button class="modal-close" id="ivmd-modal-close">×</button></div>
        <div class="modal-body">
          <p class="hint-box" style="margin-top:0;">Se le ha entrevistado ${doneCount === 1 ? '1 vez' : doneCount + ' veces'} en total.</p>
          <div class="card-list">
            ${mine.map((iv) => `
              <div class="list-card">
                <div class="lc-main">
                  <div class="lc-title">${esc(fmtDateHuman(iv.date))} ${interviewStatusPillHtml(iv.status)}</div>
                  <div class="lc-sub" ${iv.comment ? '' : 'style="font-style:italic;"'}>${iv.comment ? esc(iv.comment) : 'Sin comentario'}</div>
                </div>
              </div>`).join('')}
          </div>
        </div>
        <div class="modal-footer"><div></div><div><button class="btn btn-secondary" id="ivmd-close">Cerrar</button></div></div>
      </div>
    </div>`;
  document.getElementById('ivmd-modal-close').addEventListener('click', closeModal);
  document.getElementById('ivmd-close').addEventListener('click', closeModal);
  document.getElementById('ivmd-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'ivmd-modal-backdrop') closeModal(); });
}

// Check de verificación ✅/❌ con comentario opcional — ej. "Se hizo todo muy
// bien, el hermano está buscando trabajo, pero está con ánimo" o "Se canceló
// porque el hermano está enfermo". Al guardar, la entrevista sale de la
// pestaña principal y pasa al historial (ver loadInterviewsPending/History).
function openInterviewMarkModal(iv, status) {
  const isDone = status === 'done';
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="ivm-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>${isDone ? '✅ ¿Se realizó la entrevista?' : '❌ ¿No se realizó la entrevista?'}</h3><button class="modal-close" id="ivm-modal-close">×</button></div>
        <div class="modal-body">
          <p class="hint-box" style="margin-top:0;">${esc(iv.memberNames || iv.memberName)} · ${esc(fmtDateHuman(iv.date))}</p>
          <div class="field">
            <label>Comentario (opcional)</label>
            <textarea id="ivm-comment" placeholder="${isDone ? 'Ej: Se hizo todo muy bien, el hermano está buscando trabajo, pero está con ánimo.' : 'Ej: Se canceló porque el hermano está enfermo.'}">${esc(iv.comment || '')}</textarea>
          </div>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="ivm-cancel">Cancelar</button>
            <button class="btn btn-primary" id="ivm-save">Guardar</button>
          </div>
        </div>
      </div>
    </div>`;
  document.getElementById('ivm-modal-close').addEventListener('click', closeModal);
  document.getElementById('ivm-cancel').addEventListener('click', closeModal);
  document.getElementById('ivm-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'ivm-modal-backdrop') closeModal(); });
  document.getElementById('ivm-save').addEventListener('click', async () => {
    const comment = document.getElementById('ivm-comment').value.trim();
    try {
      await api(`/interviews/${iv.id}/mark`, { method: 'PUT', body: { status, comment } });
      closeModal();
      toast(isDone ? 'Entrevista marcada como realizada' : 'Entrevista marcada como no realizada');
      await refreshAfterInterviewChange();
    } catch (e) { toast(e.message, 'error'); }
  });
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
  let allInterviews = [];
  try { directory = await api('/users/directory'); } catch (e) { directory = []; }
  // Solo para mostrar "se le ha entrevistado X veces" al elegir/escribir a
  // cada persona — igual patrón que allTalks en Discursos. No filtra por
  // status: aunque este registro puntual esté "scheduled", ya trae
  // computado el conteo histórico de ESA persona (memberInterviewStats en
  // el servidor cuenta sus entrevistas "done", sin importar el status de
  // este registro). Cada entrevista ahora puede tener más de una persona
  // (matrimonio, compañerismo de ministración — ver groupId en el
  // servidor), así que se aplana a una sola lista de personas para buscar.
  try { allInterviews = (await api('/interviews')).flatMap((g) => g.members || []); } catch (e) { allInterviews = []; }
  const modalRoot = document.getElementById('modal-root');
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
            <div class="field">
              <label>¿A quién o quiénes se entrevista?</label>
              <div id="iv-member-rows"></div>
              <button type="button" class="btn btn-secondary btn-sm" id="iv-add-row">+ Agregar otra persona (matrimonio, compañerismo de ministración...)</button>
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

  const ivGuardedClose = wireUnsavedChangesGuard(document.getElementById('iv-form'));
  document.getElementById('iv-modal-close').addEventListener('click', ivGuardedClose);
  document.getElementById('iv-cancel').addEventListener('click', ivGuardedClose);
  document.getElementById('iv-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'iv-modal-backdrop') ivGuardedClose(); });
  // Esto borra la entrevista sin dejar registro histórico — pensado para
  // corregir un error al agendar (ej. quedó duplicada). Si la entrevista se
  // agendó bien pero no se pudo hacer (o ya se hizo), conviene cerrar este
  // formulario y usar los botones ✅/❌ de la lista en su lugar, para que el
  // motivo quede guardado en el historial.
  if (isEdit) document.getElementById('iv-delete').addEventListener('click', async () => {
    if (!(await confirmModal('¿Eliminar esta entrevista? Esto la borra por completo, sin dejar registro histórico. Si ya se hizo (o no se pudo hacer), mejor ciérralo y usa ✅/❌ en la lista para que quede en el historial.', { title: 'Eliminar entrevista', confirmText: 'Eliminar', danger: true }))) return;
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

  // Una fila por persona citada (matrimonio, compañerismo de ministración,
  // etc.) — igual patrón que "+ Agregar otro discursante" en Discursos:
  // cada fila tiene su propio buscador con autocompletado (memberPickerFieldHtml),
  // su estadística ("se le ha entrevistado X veces") y su teléfono/email.
  const interviewMemberRowHtml = (rowId, selectedUserId, selectedName, phone, email) => `
    <div class="family-row" data-row-id="${rowId}">
      <div style="display:flex; gap:8px; align-items:flex-start;">
        <div style="flex:1;">
          ${memberPickerFieldHtml(rowId, selectedUserId, selectedName)}
          <div id="${rowId}-stats" class="hint-box" style="margin-top:0; display:none;"></div>
          <div class="two-col" style="margin-top:6px;">
            <div class="field"><input type="text" class="iv-row-phone" placeholder="Teléfono (opcional)" value="${esc(phone || '')}" /></div>
            <div class="field"><input type="email" class="iv-row-email" placeholder="Email (opcional)" value="${esc(email || '')}" /></div>
          </div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm iv-row-remove" title="Quitar a esta persona">🗑️</button>
      </div>
    </div>`;
  const wireIvMemberRow = (rowEl, rowId) => {
    const nameInput = document.getElementById(`${rowId}-member-name`);
    const hiddenId = document.getElementById(`${rowId}-member-user-id`);
    const statsBox = document.getElementById(`${rowId}-stats`);
    const showRowStats = () => {
      const norm = normalizeSearchText(nameInput.value);
      if (!norm) { statsBox.style.display = 'none'; return; }
      const userId = hiddenId.value;
      const match = userId
        ? allInterviews.find((m) => Number(m.memberUserId) === Number(userId))
        : allInterviews.find((m) => !m.memberUserId && normalizeSearchText(m.memberName) === norm);
      statsBox.style.display = '';
      statsBox.textContent = match
        ? `Se le ha entrevistado ${match.timesInterviewed} ${match.timesInterviewed === 1 ? 'vez' : 'veces'}${match.lastInterviewDate ? ' · última vez: ' + fmtDateHuman(match.lastInterviewDate) : ''}`
        : 'Nunca ha sido entrevistado';
    };
    wireMemberPicker(rowId, directory, () => { resetIvConflictCheck(); showRowStats(); });
    nameInput.addEventListener('input', showRowStats);
    rowEl.querySelector('.iv-row-remove').addEventListener('click', () => {
      const box = rowEl.parentElement;
      if (box.children.length > 1) { rowEl.remove(); resetIvConflictCheck(); } // siempre queda al menos una fila
    });
    if (nameInput.value) showRowStats();
  };
  const ivRowsBox = document.getElementById('iv-member-rows');
  let ivRowCounter = 0;
  const addIvRow = (selectedUserId, selectedName, phone, email) => {
    const rowId = `iv-row-${ivRowCounter++}`;
    ivRowsBox.insertAdjacentHTML('beforeend', interviewMemberRowHtml(rowId, selectedUserId, selectedName, phone, email));
    wireIvMemberRow(ivRowsBox.lastElementChild, rowId);
  };
  document.getElementById('iv-add-row').addEventListener('click', () => addIvRow());
  if (isEdit && Array.isArray(existing.members) && existing.members.length) {
    existing.members.forEach((m) => addIvRow(m.memberUserId, m.memberName, m.memberPhone, m.memberEmail));
  } else {
    addIvRow(existing?.memberUserId, existing?.memberName, existing?.memberPhone, existing?.memberEmail);
  }

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
    const members = Array.from(ivRowsBox.children).map((rowEl) => {
      const rowId = rowEl.dataset.rowId;
      return {
        memberName: document.getElementById(`${rowId}-member-name`).value.trim(),
        memberUserId: document.getElementById(`${rowId}-member-user-id`).value || null,
        memberPhone: rowEl.querySelector('.iv-row-phone').value.trim(),
        memberEmail: rowEl.querySelector('.iv-row-email').value.trim(),
      };
    }).filter((m) => m.memberName);
    if (!members.length) {
      document.getElementById('iv-error').innerHTML = `<div class="error-msg">Agrega al menos una persona</div>`;
      return;
    }
    const body = Object.fromEntries(fd.entries());
    // memberName/memberUserId vienen repetidos (uno por fila) dentro del
    // FormData — se descartan acá y se reemplazan por el arreglo `members`
    // recién armado arriba, que sí trae uno por fila correctamente.
    delete body.memberName;
    delete body.memberUserId;
    body.members = members;
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

// Punto 4 — Confirmar una solicitud de entrevista: el líder (de la
// organización correspondiente, o cualquier líder de Obispado) puede
// mantener la fecha/hora que propuso quien la pidió, o ajustarla — más el
// lugar y quién la va a realizar. Al guardar se crea la entrevista real.
function openConfirmRequestModal(r) {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="ivc-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>Confirmar entrevista</h3><button class="modal-close" id="ivc-modal-close">×</button></div>
        <div class="modal-body">
          <div id="ivc-error"></div>
          <p class="hint-box" style="margin-top:0;">${esc(r.memberName)} pidió una entrevista con ${esc(r.organizationName)}${r.targetLeaderName ? ' (' + esc(r.targetLeaderName) + ')' : ''}${r.note ? ' · ' + esc(r.note) : ''}</p>
          <form id="ivc-form">
            <div class="two-col">
              <div class="field">
                <label>Día</label>
                <input type="date" name="date" required value="${esc(r.date)}" />
              </div>
              <div class="field">
                <label>Hora de inicio</label>
                <input type="time" name="startTime" required value="${esc(r.startTime)}" />
              </div>
            </div>
            <div class="field">
              <label>Hora de término (opcional)</label>
              <input type="time" name="endTime" value="${esc(r.endTime || '')}" />
            </div>
            ${locationFieldHtml('ivc')}
            <div class="field">
              <label>Líder que realizará la entrevista</label>
              <input type="text" name="interviewerName" required placeholder="Nombre del líder" value="${esc(r.targetLeaderName || state.user.name)}" />
            </div>
            <div class="two-col">
              <div class="field">
                <label>Email del líder (opcional)</label>
                <input type="email" name="interviewerEmail" placeholder="lider@correo.com" value="${esc(state.user.email || '')}" />
              </div>
              <div class="field">
                <label>WhatsApp del líder (opcional)</label>
                <input type="text" name="interviewerPhone" placeholder="+56 9 ..." />
              </div>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="ivc-cancel">Cancelar</button>
            <button class="btn btn-primary" id="ivc-save">Confirmar entrevista</button>
          </div>
        </div>
      </div>
    </div>`;
  wireLocationField('ivc');
  const ivcGuardedClose = wireUnsavedChangesGuard(document.getElementById('ivc-form'));
  document.getElementById('ivc-modal-close').addEventListener('click', ivcGuardedClose);
  document.getElementById('ivc-cancel').addEventListener('click', ivcGuardedClose);
  document.getElementById('ivc-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'ivc-modal-backdrop') ivcGuardedClose(); });
  document.getElementById('ivc-save').addEventListener('click', async () => {
    const form = document.getElementById('ivc-form');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const location = computeLocationFromForm(fd);
    if (fd.get('locationType') === 'Otro' && !location) {
      document.getElementById('ivc-error').innerHTML = `<div class="error-msg">Escribe cuál es el lugar</div>`;
      return;
    }
    const sala = computeSalaFromForm(fd, location);
    const body = {
      date: fd.get('date'),
      startTime: fd.get('startTime'),
      endTime: fd.get('endTime') || null,
      location,
      sala,
      interviewerName: fd.get('interviewerName'),
      interviewerEmail: fd.get('interviewerEmail') || '',
      interviewerPhone: fd.get('interviewerPhone') || '',
    };
    try {
      await api(`/interview-requests/${r.id}/confirm`, { method: 'PUT', body });
      closeModal();
      toast('Entrevista confirmada');
      await renderInterviewsView();
    } catch (e) {
      document.getElementById('ivc-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
}

// Rechazar una solicitud, con un comentario opcional explicando por qué —
// mismo patrón que openInterviewMarkModal (✅/❌ de una entrevista ya
// agendada).
function openRejectRequestModal(r) {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="ivrj-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>Rechazar solicitud</h3><button class="modal-close" id="ivrj-modal-close">×</button></div>
        <div class="modal-body">
          <p class="hint-box" style="margin-top:0;">${esc(r.memberName)} · ${esc(fmtDateHuman(r.date))} · ${esc(r.organizationName)}</p>
          <div class="field">
            <label>Comentario (opcional)</label>
            <textarea id="ivrj-comment" placeholder="Ej: Ese día no puedo, coordina otra fecha por favor"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="ivrj-cancel">Cancelar</button>
            <button class="btn btn-danger" id="ivrj-save">Rechazar</button>
          </div>
        </div>
      </div>
    </div>`;
  document.getElementById('ivrj-modal-close').addEventListener('click', closeModal);
  document.getElementById('ivrj-cancel').addEventListener('click', closeModal);
  document.getElementById('ivrj-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'ivrj-modal-backdrop') closeModal(); });
  document.getElementById('ivrj-save').addEventListener('click', async () => {
    const comment = document.getElementById('ivrj-comment').value.trim();
    try {
      await api(`/interview-requests/${r.id}/reject`, { method: 'PUT', body: { comment } });
      closeModal();
      toast('Solicitud rechazada');
      await renderInterviewsView();
    } catch (e) { toast(e.message, 'error'); }
  });
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
  container.innerHTML = skeletonViewHtml('Presupuesto', { cards: 3 });
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

  // Punto 12: para el Obispado/Admin, la bandeja de solicitudes de gasto
  // pendientes de aprobar; para cualquier otro líder, el estado de las
  // solicitudes que él mismo ha hecho — ver GET /api/budget/expense-requests
  // (el servidor ya filtra según quién pregunta).
  let expenseRequests = [];
  try { expenseRequests = await api('/budget/expense-requests'); } catch (e) { expenseRequests = []; }
  const pendingRequests = expenseRequests.filter((r) => r.status === 'pending');
  const decidedRequests = expenseRequests.filter((r) => r.status !== 'pending');

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
        ${categories.length ? `
        <button class="btn btn-secondary btn-sm" id="budget-export-csv" title="Exportar a CSV">⬇️ CSV</button>
        <button class="btn btn-secondary btn-sm" id="budget-export-pdf" title="Imprimir / Descargar PDF">🖨️ PDF</button>` : ''}
        ${isObispado ? `<button class="btn btn-secondary" id="budget-new-category">+ Nueva categoría</button>` : ''}
      </div>
    </div>
    ${!isCurrentQuarter ? `<div class="hint-box">Estás viendo un trimestre anterior, a modo de historial de consulta — no se puede editar. Para agregar asignaciones o gastos, vuelve al trimestre actual con el selector de arriba.</div>` : ''}
    <div class="card-list" id="budget-cats">
      ${categories.length ? categories.map((cat) => budgetCategoryCardHtml(cat, isCurrentQuarter, isObispado)).join('') : emptyStateHtml('Todavía no hay categorías de presupuesto', (isObispado && isCurrentQuarter) ? { id: 'budget-empty-new', label: '+ Crear la primera' } : null)}
    </div>
    ${isObispado ? `
      <div style="margin:24px 0 8px;">
        <h3 style="font-size:14px; color:var(--celeste-darker); margin-bottom:8px;">📋 Solicitudes de gasto pendientes de aprobación${pendingRequests.length ? ` (${pendingRequests.length})` : ''}</h3>
        <div class="card-list">
          ${pendingRequests.length ? pendingRequests.map((r) => expenseRequestRowHtml(r, { showActions: true })).join('') : '<div class="empty-state">No hay solicitudes pendientes</div>'}
        </div>
        ${decidedRequests.length ? `
        <button type="button" class="btn btn-secondary btn-sm" id="exp-req-history-toggle" style="margin-top:10px;">
          ${state.expenseRequestsHistoryOpen ? '▲ Ocultar historial' : `📜 Ver historial (${decidedRequests.length} solicitud${decidedRequests.length === 1 ? '' : 'es'} decidida${decidedRequests.length === 1 ? '' : 's'})`}
        </button>
        <div class="card-list" style="margin-top:10px;">${state.expenseRequestsHistoryOpen ? decidedRequests.map((r) => expenseRequestRowHtml(r, {})).join('') : ''}</div>` : ''}
      </div>
    ` : (expenseRequests.length ? `
      <div style="margin:24px 0 8px;">
        <h3 style="font-size:14px; color:var(--celeste-darker); margin-bottom:8px;">📋 Mis solicitudes de gasto</h3>
        <div class="card-list">${expenseRequests.map((r) => expenseRequestRowHtml(r, { showWithdraw: r.status === 'pending' && isCurrentQuarter })).join('')}</div>
      </div>
    ` : '')}
  `;

  document.getElementById('budget-quarter-select').addEventListener('change', (e) => {
    state.budgetQuarter = e.target.value;
    renderBudgetView();
  });
  if (isObispado) {
    document.getElementById('budget-new-category').addEventListener('click', () => openBudgetCategoryModal());
  }
  const csvBtn = document.getElementById('budget-export-csv');
  const pdfBtn = document.getElementById('budget-export-pdf');
  if (csvBtn) csvBtn.addEventListener('click', () => {
    downloadCsv(`presupuesto-${quarter}.csv`,
      ['Categoría', 'Asignado', 'Gastado', 'Saldo'],
      categories.map((c) => [c.categoryName, c.assigned, c.spent, c.balance]));
  });
  if (pdfBtn) pdfBtn.addEventListener('click', () => {
    printReport(`Presupuesto — ${quarterLabelClient(quarter)}`, `Generado ${fmtDateHuman(toISODate(new Date()))}`,
      ['Categoría', 'Asignado', 'Gastado', 'Saldo'],
      categories.map((c) => [c.categoryName, fmtMoney(c.assigned), fmtMoney(c.spent), fmtMoney(c.balance)]));
  });
  wireEmptyStateCta('budget-empty-new', () => openBudgetCategoryModal());
  wireBudgetCategoryCards(categories, isCurrentQuarter, isObispado);
  wireExpenseRequestActions();
  const expReqHistoryToggle = document.getElementById('exp-req-history-toggle');
  if (expReqHistoryToggle) expReqHistoryToggle.addEventListener('click', () => { state.expenseRequestsHistoryOpen = !state.expenseRequestsHistoryOpen; renderBudgetView(); });
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
        ${canExpense ? (isObispado
          ? `<button type="button" class="btn btn-primary btn-sm budget-add-expense">+ Registrar gasto</button>`
          // Punto 12: un líder común no registra el gasto directo — primero
          // pide aprobación al Obispado (Manual General 20.2.6).
          : `<button type="button" class="btn btn-primary btn-sm budget-request-expense">📋 Solicitar aprobación de gasto</button>`) : ''}
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
    card.querySelector('.budget-request-expense')?.addEventListener('click', () => openExpenseRequestModal(cat));
    card.querySelectorAll('.budget-edit-expense').forEach((btn) => {
      const row = btn.closest('.budget-expense-row');
      const expense = cat.expenses.find((e) => e.id === Number(row.dataset.expenseId));
      btn.addEventListener('click', () => openBudgetExpenseModal(cat, expense));
    });
    card.querySelectorAll('.budget-delete-expense').forEach((btn) => {
      const row = btn.closest('.budget-expense-row');
      const expenseId = Number(row.dataset.expenseId);
      btn.addEventListener('click', async () => {
        if (!(await confirmModal('¿Eliminar este gasto?', { title: 'Eliminar gasto', confirmText: 'Eliminar', danger: true }))) return;
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
  const beGuardedClose = wireUnsavedChangesGuard(document.getElementById('be-form'));
  document.getElementById('be-modal-close').addEventListener('click', beGuardedClose);
  document.getElementById('be-cancel').addEventListener('click', beGuardedClose);
  document.getElementById('be-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'be-modal-backdrop') beGuardedClose(); });
  if (isEdit) document.getElementById('be-delete').addEventListener('click', async () => {
    if (!(await confirmModal('¿Eliminar este gasto?', { title: 'Eliminar gasto', confirmText: 'Eliminar', danger: true }))) return;
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

// Punto 12 — Solicitud de aprobación de gasto (Manual General 20.2.6): un
// líder común ya no registra el gasto directo, primero pide aprobación al
// Obispado. Aplica a TODOS los gastos de su organización, sin un mínimo —
// ver el gate correspondiente en server/routes/budget.js.
function expenseRequestStatusPillHtml(status) {
  if (status === 'pending') return `<span class="status-pill status-amber">Pendiente</span>`;
  if (status === 'approved') return `<span class="status-pill status-green">Aprobado</span>`;
  return `<span class="status-pill status-red">Rechazado</span>`;
}

function expenseRequestRowHtml(r, opts = {}) {
  const { showActions, showWithdraw } = opts;
  return `
    <div class="list-card" data-request-id="${r.id}" style="flex-direction:column; align-items:stretch; gap:8px;">
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
        <div class="lc-main">
          <div class="lc-title">${esc(r.description)}${r.eventTitle ? ` · <span style="color:var(--celeste-dark);">🔗 ${esc(r.eventTitle)}</span>` : ''}</div>
          <div class="lc-sub">${esc(r.categoryName)} · ${esc(fmtDateHuman(r.date))} · solicitado por ${esc(r.requestedByName)}</div>
          ${r.decisionComment ? `<div class="lc-sub" style="margin-top:2px; font-style:italic;">💬 ${esc(r.decisionComment)}</div>` : ''}
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
          <strong>${fmtMoney(r.amount)}</strong>
          ${expenseRequestStatusPillHtml(r.status)}
        </div>
      </div>
      ${showActions ? `
      <div class="lc-actions">
        <button type="button" class="btn btn-primary btn-sm exp-req-approve" data-id="${r.id}">✅ Aprobar</button>
        <button type="button" class="btn btn-secondary btn-sm exp-req-reject-toggle">❌ Rechazar</button>
      </div>
      <div class="exp-req-reject-form" style="display:none;">
        <textarea class="exp-req-reject-comment" placeholder="Motivo del rechazo (opcional)" rows="2" style="width:100%; margin-bottom:8px;"></textarea>
        <button type="button" class="btn btn-danger btn-sm exp-req-reject-save" data-id="${r.id}">Confirmar rechazo</button>
      </div>` : ''}
      ${showWithdraw ? `<div class="lc-actions"><button type="button" class="btn btn-ghost btn-sm exp-req-withdraw" data-id="${r.id}">🗑️ Retirar solicitud</button></div>` : ''}
    </div>`;
}

function wireExpenseRequestActions() {
  document.querySelectorAll('.exp-req-approve').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await api(`/budget/expense-requests/${btn.dataset.id}/approve`, { method: 'PUT' });
      toast('Gasto aprobado y registrado');
      await renderBudgetView();
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
  }));
  document.querySelectorAll('.exp-req-reject-toggle').forEach((btn) => btn.addEventListener('click', () => {
    const form = btn.closest('.list-card').querySelector('.exp-req-reject-form');
    form.style.display = form.style.display === 'none' ? '' : 'none';
  }));
  document.querySelectorAll('.exp-req-reject-save').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    const comment = btn.closest('.list-card').querySelector('.exp-req-reject-comment').value.trim();
    try {
      await api(`/budget/expense-requests/${btn.dataset.id}/reject`, { method: 'PUT', body: { comment } });
      toast('Solicitud rechazada');
      await renderBudgetView();
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
  }));
  document.querySelectorAll('.exp-req-withdraw').forEach((btn) => btn.addEventListener('click', async () => {
    if (!(await confirmModal('¿Retirar esta solicitud de gasto?', { title: 'Retirar solicitud', confirmText: 'Retirar', danger: true }))) return;
    try {
      await api(`/budget/expense-requests/${btn.dataset.id}`, { method: 'DELETE' });
      toast('Solicitud retirada');
      await renderBudgetView();
    } catch (e) { toast(e.message, 'error'); }
  }));
}

async function openExpenseRequestModal(cat) {
  let events = [];
  try {
    if (cat.categoryType === 'organization') events = await api(`/events?organizationId=${cat.organizationId}`);
    else { const all = await api('/events'); events = all.filter((ev) => ev.isWardActivity); }
  } catch (e) { events = []; }
  events = events.slice().sort((a, b) => (b.date + b.startTime).localeCompare(a.date + a.startTime));

  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="ber-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>Solicitar aprobación de gasto — ${esc(cat.categoryName)}</h3><button class="modal-close" id="ber-modal-close">×</button></div>
        <div class="modal-body">
          <div id="ber-error"></div>
          <div class="hint-box" style="margin-top:0;">El Manual General pide obtener la aprobación del Obispo antes de gastar dinero para actividades (20.2.6). Esta solicitud llega al Obispado/Administrador, que la aprueba o la rechaza — recién ahí queda registrada como gasto.</div>
          <form id="ber-form">
            <div class="field">
              <label>Monto</label>
              <input type="number" name="amount" min="1" step="1" required placeholder="0" />
            </div>
            <div class="field">
              <label>Descripción</label>
              <input type="text" name="description" required placeholder="Ej: Materiales para actividad" />
            </div>
            <div class="field">
              <label>Fecha</label>
              <input type="date" name="date" required value="${toISODate(new Date())}" />
            </div>
            <div class="field">
              <label>Actividad relacionada (opcional)</label>
              <select name="eventId">
                <option value="">— Ninguna —</option>
                ${events.map((ev) => `<option value="${ev.id}">${esc(fmtDateHuman(ev.date))} · ${esc(ev.title)}</option>`).join('')}
              </select>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="ber-cancel">Cancelar</button>
            <button class="btn btn-primary" id="ber-save">Enviar solicitud</button>
          </div>
        </div>
      </div>
    </div>`;
  const berGuardedClose = wireUnsavedChangesGuard(document.getElementById('ber-form'));
  document.getElementById('ber-modal-close').addEventListener('click', berGuardedClose);
  document.getElementById('ber-cancel').addEventListener('click', berGuardedClose);
  document.getElementById('ber-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'ber-modal-backdrop') berGuardedClose(); });
  const berForm = document.getElementById('ber-form');
  document.getElementById('ber-save').addEventListener('click', async () => {
    if (!berForm.reportValidity()) return;
    const fd = new FormData(berForm);
    const body = Object.fromEntries(fd.entries());
    body.amount = Number(body.amount);
    body.eventId = body.eventId ? Number(body.eventId) : null;
    body.categoryType = cat.categoryType;
    body.organizationId = cat.organizationId;
    body.budgetCategoryId = cat.budgetCategoryId;
    try {
      await api('/budget/expense-requests', { method: 'POST', body });
      closeModal();
      toast('Solicitud enviada — queda pendiente de aprobación del Obispado');
      await renderBudgetView();
    } catch (e) {
      document.getElementById('ber-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
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
  content.innerHTML = skeletonCardsHtml(2);
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
    <div class="table-scroll">
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
    </div>
  `;
  content.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', () => {
    openApproveModal(items.find((r) => r.id === Number(b.dataset.approve)));
  }));
  content.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmModal('¿Rechazar y eliminar esta solicitud?', { title: 'Rechazar solicitud', confirmText: 'Rechazar', danger: true }))) return;
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
              <select name="organizationId" id="ar-org-select">
                ${state.organizations.map((o) => `<option value="${o.id}" ${reqItem.requestedOrganizationId === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
              </select>
            </div>
            <div class="field" id="ar-calling-field" style="display:none;">
              <label>Llamamiento (lo que la persona indicó al registrarse — puedes corregirlo)</label>
              <select id="ar-calling-select"></select>
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
  const updateArCallingField = () => {
    const role = document.getElementById('ar-role').value;
    document.getElementById('ar-org-field').style.display = role === 'leader' ? '' : 'none';
    const org = state.organizations.find((o) => String(o.id) === document.getElementById('ar-org-select').value);
    const isTargetOrg = role === 'leader' && org && PRESIDENT_ORGS.includes(org.name);
    document.getElementById('ar-calling-field').style.display = isTargetOrg ? '' : 'none';
    if (isTargetOrg) {
      const sel = document.getElementById('ar-calling-select');
      const current = reqItem.requestedCalling || '';
      sel.innerHTML = `<option value="" disabled ${current ? '' : 'selected'}>Selecciona…</option>` + ['Presidente', 'Consejero', 'Secretario'].map((c) => `<option value="${c}" ${current === c ? 'selected' : ''}>${esc(callingLabel(org.name, c))}</option>`).join('');
    }
  };
  document.getElementById('ar-role').addEventListener('change', updateArCallingField);
  document.getElementById('ar-org-select').addEventListener('change', updateArCallingField);
  updateArCallingField();
  document.getElementById('ar-save').addEventListener('click', async () => {
    const form = document.getElementById('ar-form');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const body = { name: fd.get('name'), role: fd.get('role'), organizationId: fd.get('role') === 'leader' ? fd.get('organizationId') : null };
    const org = state.organizations.find((o) => String(o.id) === String(body.organizationId));
    const isTargetOrg = body.role === 'leader' && org && PRESIDENT_ORGS.includes(org.name);
    if (isTargetOrg) {
      body.calling = document.getElementById('ar-calling-select').value;
      if (!body.calling) {
        document.getElementById('ar-error').innerHTML = `<div class="error-msg">Indica el llamamiento (Presidente/Obispo, Consejero o Secretario)</div>`;
        return;
      }
    }
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
    <div class="table-scroll">
    <table class="data-table">
      <thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Organización</th><th></th></tr></thead>
      <tbody>
        ${users.map((u) => `
          <tr>
            <td>${esc(u.name)}</td>
            <td>${esc(u.email)}</td>
            <td><span class="role-badge role-${u.role}">${ROLE_LABELS[u.role]}</span></td>
            <td>${esc(u.organizationName || '—')}${u.calling ? ` <span class="status-pill ${u.calling === 'Presidente' ? 'status-green' : 'status-gray'}" title="Llamamiento en ${esc(u.organizationName || '')}">${u.calling === 'Presidente' ? '★ ' : ''}${esc(callingLabel(u.organizationName, u.calling))}</span>` : (u.isPresident ? ' <span class="status-pill status-green" title="Presidente/titular de la organización">★ Presidente</span>' : '')}</td>
            <td style="text-align:right; white-space:nowrap;">
              <button class="btn btn-secondary btn-sm" data-edit-user="${u.id}">Editar</button>
              ${u.id !== state.user.id ? `<button class="btn btn-danger btn-sm" data-del-user="${u.id}">Eliminar</button>` : ''}
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
    </div>
  `;
  document.getElementById('user-new').addEventListener('click', () => openUserModal());
  content.querySelectorAll('[data-edit-user]').forEach((b) => b.addEventListener('click', () => openUserModal(users.find((u) => u.id === Number(b.dataset.editUser)))));
  content.querySelectorAll('[data-del-user]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmModal('¿Eliminar este usuario?', { title: 'Eliminar usuario', confirmText: 'Eliminar', danger: true }))) return;
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
              <select name="organizationId" id="u-org-select">
                <option value="">— Ninguna —</option>
                ${state.organizations.map((o) => `<option value="${o.id}" ${existing?.organizationId === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
              </select>
            </div>
            <div class="field" id="u-president-field" style="display:none;">
              <label style="display:flex; align-items:center; gap:8px; font-weight:600;">
                <input type="checkbox" name="isPresident" style="width:auto;" ${existing?.isPresident ? 'checked' : ''} />
                Es el presidente/titular de esa organización
              </label>
              <div class="hint-box" style="margin-top:6px;">Solo puede haber uno por organización — si marcas a esta persona, se desmarca automáticamente a quien lo fuera antes. Se usa para dirigir avisos como la Coordinación de Ministración trimestral a la persona correcta, no a "un líder" cualquiera.</div>
            </div>
            <div class="field" id="u-calling-field" style="display:none;">
              <label>Llamamiento</label>
              <select id="u-calling-select"></select>
              <div class="hint-box" style="margin-top:6px;">Quien tenga el llamamiento de Presidente/Obispo dirige avisos como la Coordinación de Ministración trimestral y aparece marcado con ★. El Secretario/a es líder (edita actividades, actas, etc.) pero, según el Manual General, no realiza entrevistas — por eso no aparece como opción al pedir una entrevista.</div>
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
  // Punto 8 (ampliación): en Obispado, Cuórum de Élderes y Sociedad de
  // Socorro se pide el llamamiento específico (Presidente/Obispo, Consejero
  // o Secretario) en vez del checkbox genérico "★ Presidente/Titular" — en
  // cualquier otra organización se mantiene el checkbox de siempre.
  const updatePresidencyFields = () => {
    const role = document.getElementById('u-role').value;
    const org = state.organizations.find((o) => String(o.id) === document.getElementById('u-org-select').value);
    const isTargetOrg = role === 'leader' && org && PRESIDENT_ORGS.includes(org.name);
    document.getElementById('u-calling-field').style.display = isTargetOrg ? '' : 'none';
    document.getElementById('u-president-field').style.display = (role === 'leader' && !isTargetOrg) ? '' : 'none';
    if (isTargetOrg) {
      const sel = document.getElementById('u-calling-select');
      const current = existing?.calling || '';
      sel.innerHTML = `<option value="" disabled ${current ? '' : 'selected'}>Selecciona…</option>` + ['Presidente', 'Consejero', 'Secretario'].map((c) => `<option value="${c}" ${current === c ? 'selected' : ''}>${esc(callingLabel(org.name, c))}</option>`).join('');
    }
  };
  document.getElementById('u-role').addEventListener('change', updatePresidencyFields);
  document.getElementById('u-org-select').addEventListener('change', updatePresidencyFields);
  updatePresidencyFields();
  const uGuardedClose = wireUnsavedChangesGuard(document.getElementById('u-form'));
  document.getElementById('u-modal-close').addEventListener('click', uGuardedClose);
  document.getElementById('u-cancel').addEventListener('click', uGuardedClose);
  document.getElementById('u-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'u-modal-backdrop') uGuardedClose(); });
  document.getElementById('u-save').addEventListener('click', async () => {
    const form = document.getElementById('u-form');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const body = Object.fromEntries(fd.entries());
    if (!body.password) delete body.password;
    if (!body.organizationId) body.organizationId = null;
    const org = state.organizations.find((o) => String(o.id) === String(body.organizationId));
    const isTargetOrg = body.role === 'leader' && org && PRESIDENT_ORGS.includes(org.name);
    if (isTargetOrg) {
      body.calling = document.getElementById('u-calling-select').value;
      if (!body.calling) {
        document.getElementById('u-error').innerHTML = `<div class="error-msg">Indica el llamamiento (Presidente/Obispo, Consejero o Secretario)</div>`;
        return;
      }
      body.isPresident = false;
    } else {
      body.isPresident = body.role === 'leader' && fd.get('isPresident') === 'on';
      body.calling = '';
    }
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
    <div class="table-scroll">
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
    </div>
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
  const orgGuardedClose = wireUnsavedChangesGuard(document.getElementById('org-form'));
  document.getElementById('org-modal-close').addEventListener('click', orgGuardedClose);
  document.getElementById('org-cancel').addEventListener('click', orgGuardedClose);
  document.getElementById('org-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'org-modal-backdrop') orgGuardedClose(); });
  document.getElementById('org-swatches').querySelectorAll('.color-swatch').forEach((sw) => sw.addEventListener('click', () => {
    document.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
    sw.classList.add('selected');
    document.getElementById('org-color-input').value = sw.dataset.color;
  }));
  if (isEdit) document.getElementById('org-delete').addEventListener('click', async () => {
    if (!(await confirmModal('¿Eliminar esta organización? Esto no elimina sus actividades existentes.', { title: 'Eliminar organización', confirmText: 'Eliminar', danger: true }))) return;
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
    <div class="section-header"><div><h2>Reuniones y Consejos</h2><p>Actas de reuniones, compromisos y tus propias asignaciones pendientes</p></div></div>
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
  content.innerHTML = skeletonCardsHtml(3);
  let data;
  try { data = await api('/my-assignments'); }
  catch (e) { toast(e.message, 'error'); content.innerHTML = '<div class="empty-state">No se pudo cargar</div>'; return; }
  content.innerHTML = data.commitments.length
    ? `
      <div class="bulk-actions-bar" id="assign-bulk-bar" style="display:none;">
        <span id="assign-bulk-count"></span>
        <button type="button" class="btn btn-primary btn-sm" id="assign-bulk-complete">✅ Completar seleccionados</button>
        <button type="button" class="btn btn-ghost btn-sm" id="assign-bulk-clear">Cancelar</button>
      </div>
      <div class="card-list">${data.commitments.map(assignmentCardHtml).join('')}</div>`
    : '<div class="empty-state">No tienes compromisos pendientes 🎉</div>';
  wireAssignmentCards();
}

function assignmentCardHtml(c) {
  const isOverdue = c.displayStatus === 'overdue';
  return `
    <div class="list-card assignment-card" data-id="${c.id}" style="align-items:flex-start; flex-direction:column; gap:8px;">
      <div style="display:flex; justify-content:space-between; width:100%; gap:10px; align-items:flex-start;">
        <div style="display:flex; gap:10px; align-items:flex-start; min-width:0; flex:1;">
          <input type="checkbox" class="assignment-select-cb" title="Seleccionar" style="margin-top:4px; flex-shrink:0; width:16px; height:16px;" />
          <div class="lc-main">
            <div class="lc-title">${esc(c.description)}</div>
            <div class="lc-sub">${esc(c.meetingTitle)} · vence ${esc(fmtDateHuman(c.dueDate))}</div>
          </div>
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

// Barra de acciones masivas: aparece cuando hay al menos un compromiso
// marcado con su checkbox, y completa todos los seleccionados de una vez
// (reutiliza el mismo endpoint que el botón individual, uno por uno, para
// no tener que duplicar la lógica de validación del servidor).
function wireAssignmentBulkBar() {
  const bulkBar = document.getElementById('assign-bulk-bar');
  if (!bulkBar) return;
  const bulkCount = document.getElementById('assign-bulk-count');
  const updateBulkBar = () => {
    const checked = document.querySelectorAll('.assignment-select-cb:checked');
    bulkBar.style.display = checked.length ? 'flex' : 'none';
    if (bulkCount) bulkCount.textContent = `${checked.length} seleccionado${checked.length === 1 ? '' : 's'}`;
  };
  document.querySelectorAll('.assignment-select-cb').forEach((cb) => cb.addEventListener('change', updateBulkBar));
  document.getElementById('assign-bulk-clear').addEventListener('click', () => {
    document.querySelectorAll('.assignment-select-cb:checked').forEach((cb) => { cb.checked = false; });
    updateBulkBar();
  });
  document.getElementById('assign-bulk-complete').addEventListener('click', async () => {
    const ids = Array.from(document.querySelectorAll('.assignment-select-cb:checked'))
      .map((cb) => Number(cb.closest('.assignment-card').dataset.id));
    if (!ids.length) return;
    if (!(await confirmModal(`¿Marcar ${ids.length} compromiso${ids.length === 1 ? '' : 's'} como completado${ids.length === 1 ? '' : 's'}?`, { title: 'Completar seleccionados', confirmText: 'Completar' }))) return;
    let okCount = 0;
    for (const id of ids) {
      try { await api(`/commitments/${id}/complete`, { method: 'PUT', body: { comment: '' } }); okCount++; }
      catch (e) { toast(e.message, 'error'); }
    }
    if (okCount) toast(`${okCount} compromiso${okCount === 1 ? '' : 's'} completado${okCount === 1 ? '' : 's'}`);
    await renderMyAssignments();
  });
}

function wireAssignmentCards() {
  wireAssignmentBulkBar();
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
  content.innerHTML = skeletonCardsHtml(3);
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
      ${active.length ? active.map((m) => meetingCardHtml(m)).join('') : emptyStateHtml('No hay actas activas', { id: 'meeting-empty-new', label: '+ Crear la primera' })}
    </div>
    ${archived.length ? `
      <div style="margin-top:22px;">
        <h3 style="font-size:14px; color:var(--celeste-darker); margin-bottom:8px;">📁 Reuniones Pasadas</h3>
        <div class="card-list">${archived.map((m) => meetingCardHtml(m)).join('')}</div>
      </div>` : ''}
  `;
  document.getElementById('meeting-new').addEventListener('click', () => openMeetingModal());
  wireEmptyStateCta('meeting-empty-new', () => openMeetingModal());
  wireMeetingCards(meetings);
}

function meetingCardHtml(m) {
  const done = m.commitments.filter((c) => c.status === 'completed').length;
  const total = m.commitments.length;
  const typeLabel = MEETING_TYPE_LABELS[m.type] || '';
  return `
    <div class="list-card meeting-card" data-id="${m.id}" style="cursor:pointer;">
      <div class="lc-main">
        <div class="lc-title">${m.confidential ? '🔒 ' : ''}${esc(m.title)}${typeLabel ? ` <span class="status-pill status-gray">${typeLabel}</span>` : ''}${m.status === 'archived' ? ' <span style="font-weight:400; font-size:12px; color:var(--ink-soft);">(archivada)</span>' : ''}</div>
        <div class="lc-sub">${esc(m.organizationName)} · ${esc(fmtDateHuman(m.date))} · ${m.contentRedacted ? 'contenido confidencial' : `${done}/${total} compromiso${total === 1 ? '' : 's'} completado${total === 1 ? '' : 's'}`}</div>
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

async function openMeetingModal(presetType) {
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

  // Punto 7: un tema de agenda es solo un título + quién lo presenta — las
  // notas/decisión se completan durante o después de la reunión, desde el
  // detalle del acta (openMeetingDetailModal).
  const agendaRowHtml = () => `
    <div class="commitment-row">
      <div class="two-col">
        <div class="field" style="margin-bottom:0;">
          <label>Tema</label>
          <input type="text" class="ar-topic" required placeholder="Ej: Presupuesto de actividades de agosto" />
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Quién lo presenta (opcional)</label>
          <input type="text" class="ar-presenter" placeholder="Ej: Roberto Fuentes" />
        </div>
      </div>
      <button type="button" class="btn btn-ghost btn-sm ar-remove">🗑️ Quitar tema</button>
    </div>`;

  // Punto 8: "Consejo de Barrio" y "Coordinación de Ministración" son tipos
  // reservados al Obispado (ver OBISPADO_ONLY_TYPES en meetings.js) — un
  // líder común solo puede crear actas "generales" (ej. de su propia
  // presidencia), así que ni se le muestran esas opciones.
  const isObispadoTier = isObispadoUser();
  const typeOptionsHtml = isObispadoTier ? `
    <div class="field">
      <label>Tipo de acta</label>
      <select name="type" id="mt-type">
        <option value="general">General (ej. presidencia de una organización)</option>
        <option value="consejo_barrio">Consejo de Barrio</option>
        <option value="coordinacion_ministracion">Coordinación de Ministración (trimestral)</option>
      </select>
    </div>` : '';

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
            ${typeOptionsHtml}
            <div class="field">
              <label style="display:flex; align-items:center; gap:8px; font-weight:600;">
                <input type="checkbox" name="confidential" style="width:auto;" />
                Acta confidencial
              </label>
              <div class="hint-box" style="margin-top:6px;">Solo el Obispado/Administrador (y quien la creó) van a poder ver los temas y compromisos — el resto la ve en la lista, pero sin el contenido.</div>
            </div>
            <div class="field">
              <label>Agenda — temas a tratar (opcional, se puede armar antes de la reunión)</label>
              <div id="mt-agenda"></div>
              <button type="button" class="btn btn-secondary btn-sm" id="mt-add-agenda">+ Agregar tema</button>
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

  if (presetType) {
    const typeSel = document.getElementById('mt-type');
    if (typeSel) typeSel.value = presetType;
  }

  const agendaBox = document.getElementById('mt-agenda');
  const wireAgendaRow = (row) => { row.querySelector('.ar-remove').addEventListener('click', () => row.remove()); };
  const addAgendaRow = () => {
    agendaBox.insertAdjacentHTML('beforeend', agendaRowHtml());
    wireAgendaRow(agendaBox.lastElementChild);
  };
  document.getElementById('mt-add-agenda').addEventListener('click', addAgendaRow);

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

  const mtGuardedClose = wireUnsavedChangesGuard(document.getElementById('mt-form'));
  document.getElementById('mt-modal-close').addEventListener('click', mtGuardedClose);
  document.getElementById('mt-cancel').addEventListener('click', mtGuardedClose);
  document.getElementById('mt-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'mt-modal-backdrop') mtGuardedClose(); });

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
    const agendaItems = Array.from(document.querySelectorAll('#mt-agenda .commitment-row'))
      .map((row) => ({
        topic: row.querySelector('.ar-topic').value.trim(),
        presenter: row.querySelector('.ar-presenter').value.trim(),
      }))
      .filter((a) => a.topic);
    try {
      await api('/meetings', {
        method: 'POST',
        body: {
          title: fd.get('title'),
          date: fd.get('date'),
          type: isObispadoTier ? fd.get('type') : 'general',
          confidential: fd.get('confidential') === 'on',
          commitments,
          agendaItems,
        },
      });
      closeModal();
      toast('Acta creada');
      await renderMeetingsManage();
    } catch (e) {
      document.getElementById('mt-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
}

const MEETING_TYPE_LABELS = { general: '', consejo_barrio: '⛪ Consejo de Barrio', coordinacion_ministracion: '🤝 Coordinación de Ministración' };

async function openMeetingDetailModal(m) {
  const canEdit = (state.user.role === 'admin' || Number(state.user.id) === Number(m.createdBy)) && m.status === 'active';
  const typeLabel = MEETING_TYPE_LABELS[m.type] || '';
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="md-modal-backdrop">
      <div class="modal" style="max-width:560px;">
        <div class="modal-header"><h3>${esc(m.title)}</h3><button class="modal-close" id="md-modal-close">×</button></div>
        <div class="modal-body">
          <div class="hint-box" style="margin-top:0;">${esc(m.organizationName)} · ${esc(fmtDateHuman(m.date))} · Creada por ${esc(m.createdByName)}${m.status === 'archived' ? ' · 📁 Archivada' : ''}${typeLabel ? ` · ${typeLabel}` : ''}${m.confidential ? ' · 🔒 Confidencial' : ''}</div>
          ${m.contentRedacted ? `<div class="empty-state">🔒 Esta acta es confidencial — solo el Obispado, el Administrador o quien la creó pueden ver su contenido.</div>` : `
          <div id="md-agenda">
            ${m.agendaItems && m.agendaItems.length ? `
              <div style="font-weight:600; font-size:13px; color:var(--celeste-darker); margin-bottom:6px;">📋 Agenda</div>
              ${m.agendaItems.map((a) => `
                <div class="commitment-detail-row" data-agenda-id="${a.id}">
                  <div style="font-weight:600; font-size:13.5px;">${esc(a.topic)}${a.presenter ? ` <span style="font-weight:400; font-size:12px; color:var(--ink-soft);">— ${esc(a.presenter)}</span>` : ''}</div>
                  ${a.notes ? `<div style="font-size:12.5px; color:var(--ink-soft); margin-top:4px;">${esc(a.notes)}</div>` : (canEdit ? `<div style="font-size:12px; color:var(--ink-soft); margin-top:4px; font-style:italic;">Sin notas todavía</div>` : '')}
                  ${canEdit ? `<button type="button" class="btn btn-ghost btn-sm agenda-edit-notes" style="margin-top:4px;">📝 ${a.notes ? 'Editar' : 'Agregar'} notas</button>` : ''}
                </div>`).join('')}
            ` : ''}
          </div>
          ${canEdit ? `<div style="margin:10px 0 14px;"><button type="button" class="btn btn-secondary btn-sm" id="md-add-agenda">+ Agregar tema a la agenda</button></div>` : ''}
          <div id="md-commitments">
            ${m.commitments.length ? m.commitments.map((c) => `
              <div class="commitment-detail-row">
                <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
                  <div style="min-width:0;">
                    <div style="font-weight:600; font-size:13.5px;">${c.redacted ? '🔒 ' : ''}${esc(c.description)}</div>
                    <div style="font-size:12px; color:var(--ink-soft); margin-top:2px;">Responsable: ${esc(c.assignedToName)} · vence ${esc(fmtDateHuman(c.dueDate))}</div>
                    ${c.status === 'completed' && c.completionComment ? `<div style="font-size:12px; color:var(--ink-soft); margin-top:4px; font-style:italic;">💬 "${esc(c.completionComment)}"</div>` : ''}
                  </div>
                  ${commitmentStatusPillHtml(c)}
                </div>
              </div>`).join('') : emptyStateHtml('Sin compromisos todavía', canEdit ? { id: 'md-empty-add', label: '+ Agregar el primero' } : null)}
          </div>
          ${canEdit ? `<div style="margin-top:14px;"><button type="button" class="btn btn-secondary btn-sm" id="md-add-commitment">+ Agregar compromiso</button></div>` : ''}
          `}
        </div>
        <div class="modal-footer">
          <div style="display:flex; gap:8px;">
            ${canEdit ? `<button class="btn btn-danger" id="md-archive">✅ Verificar y Archivar</button>` : ''}
            ${canEdit ? `<button class="btn btn-ghost" id="md-toggle-confidential">${m.confidential ? '🔓 Quitar confidencialidad' : '🔒 Marcar confidencial'}</button>` : ''}
          </div>
          <div><button class="btn btn-secondary" id="md-close">Cerrar</button></div>
        </div>
      </div>
    </div>`;
  document.getElementById('md-modal-close').addEventListener('click', closeModal);
  document.getElementById('md-close').addEventListener('click', closeModal);
  document.getElementById('md-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'md-modal-backdrop') closeModal(); });
  if (!m.contentRedacted) wireEmptyStateCta('md-empty-add', () => openAddCommitmentModal(m));
  if (canEdit) {
    document.getElementById('md-toggle-confidential').addEventListener('click', async () => {
      try {
        const updated = await api(`/meetings/${m.id}/confidential`, { method: 'PUT', body: { confidential: !m.confidential } });
        toast(updated.confidential ? 'Acta marcada confidencial' : 'Acta ya no es confidencial');
        openMeetingDetailModal(updated);
        renderMeetingsManage();
      } catch (e) { toast(e.message, 'error'); }
    });
    const addAgendaBtn = document.getElementById('md-add-agenda');
    if (addAgendaBtn) addAgendaBtn.addEventListener('click', () => openAddAgendaItemModal(m));
    document.querySelectorAll('.agenda-edit-notes').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest('[data-agenda-id]');
        const itemId = Number(row.dataset.agendaId);
        const item = m.agendaItems.find((a) => a.id === itemId);
        openEditAgendaNotesModal(m, item);
      });
    });
    const addCommitmentBtn = document.getElementById('md-add-commitment');
    if (addCommitmentBtn) addCommitmentBtn.addEventListener('click', () => openAddCommitmentModal(m));
    document.getElementById('md-archive').addEventListener('click', async () => {
      if (!(await confirmModal('¿Verificar y archivar esta acta? Los compromisos que sigan pendientes quedarán documentados como "no cumplida" y ya no aparecerán en "Mis Asignaciones" de nadie.', { title: 'Verificar y archivar', confirmText: 'Verificar y archivar' }))) return;
      try {
        await api(`/meetings/${m.id}/archive`, { method: 'PUT' });
        closeModal();
        toast('Acta archivada');
        await renderMeetingsManage();
      } catch (e) { toast(e.message, 'error'); }
    });
  }
}

function openAddAgendaItemModal(m) {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="ai-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>Agregar tema a la agenda</h3><button class="modal-close" id="ai-modal-close">×</button></div>
        <div class="modal-body">
          <div id="ai-error"></div>
          <form id="ai-form">
            <div class="field"><label>Tema</label><input type="text" name="topic" required placeholder="Ej: Presupuesto de agosto" /></div>
            <div class="field"><label>Quién lo presenta (opcional)</label><input type="text" name="presenter" /></div>
          </form>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="ai-cancel">Cancelar</button>
            <button class="btn btn-primary" id="ai-save">Agregar</button>
          </div>
        </div>
      </div>
    </div>`;
  const aiGuardedClose = wireUnsavedChangesGuard(document.getElementById('ai-form'));
  document.getElementById('ai-modal-close').addEventListener('click', aiGuardedClose);
  document.getElementById('ai-cancel').addEventListener('click', aiGuardedClose);
  document.getElementById('ai-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'ai-modal-backdrop') aiGuardedClose(); });
  document.getElementById('ai-save').addEventListener('click', async () => {
    const form = document.getElementById('ai-form');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    try {
      const updated = await api(`/meetings/${m.id}/agenda-items`, { method: 'POST', body: Object.fromEntries(fd.entries()) });
      closeModal();
      toast('Tema agregado a la agenda');
      openMeetingDetailModal(updated);
    } catch (e) {
      document.getElementById('ai-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
}

function openEditAgendaNotesModal(m, item) {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="an-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>${esc(item.topic)}</h3><button class="modal-close" id="an-modal-close">×</button></div>
        <div class="modal-body">
          <div id="an-error"></div>
          <form id="an-form">
            <div class="field"><label>Qué se decidió / notas</label><textarea name="notes" rows="4">${esc(item.notes || '')}</textarea></div>
          </form>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="an-cancel">Cancelar</button>
            <button class="btn btn-primary" id="an-save">Guardar</button>
          </div>
        </div>
      </div>
    </div>`;
  const anGuardedClose = wireUnsavedChangesGuard(document.getElementById('an-form'));
  document.getElementById('an-modal-close').addEventListener('click', anGuardedClose);
  document.getElementById('an-cancel').addEventListener('click', anGuardedClose);
  document.getElementById('an-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'an-modal-backdrop') anGuardedClose(); });
  document.getElementById('an-save').addEventListener('click', async () => {
    const fd = new FormData(document.getElementById('an-form'));
    try {
      const updated = await api(`/meetings/${m.id}/agenda-items/${item.id}`, { method: 'PUT', body: { notes: fd.get('notes') } });
      closeModal();
      toast('Notas guardadas');
      openMeetingDetailModal(updated);
    } catch (e) {
      document.getElementById('an-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
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
  const acGuardedClose = wireUnsavedChangesGuard(document.getElementById('ac-form'));
  document.getElementById('ac-modal-close').addEventListener('click', acGuardedClose);
  document.getElementById('ac-cancel').addEventListener('click', acGuardedClose);
  document.getElementById('ac-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'ac-modal-backdrop') acGuardedClose(); });
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
// ---------------- Asignaciones (Aseo del Edificio + Discursos) ----------------
// ==================================================================
// Estrictamente oculto salvo Administrador o líder de Obispado (ver
// canSeeAssignmentsTab). Dos sub-módulos que comparten el mismo espíritu —
// "quién quedó asignado a qué, cuándo, y cuántas veces lo ha hecho antes" —
// por eso viven juntos bajo una sola pestaña en vez de dos aparte:
//   - Turnos de aseo de los sábados, asignados a una o varias familias.
//   - Discursos de la reunión sacramental, asignados a una persona.
// Ambos con autocompletado (y, en Aseo, creación automática la primera vez
// que se escribe un nombre nuevo) más estadística histórica en vivo.

async function renderAssignmentsView() {
  const container = document.getElementById('view-root');
  container.innerHTML = `
    <div class="section-header"><div><h2>Asignaciones</h2><p>Turnos de aseo y discursos de la reunión sacramental</p></div></div>
    <div class="subtabs">
      <button class="subtab-btn ${state.assignmentsSubtab === 'cleaning' ? 'active' : ''}" data-tab="cleaning">Turnos de Aseo</button>
      <button class="subtab-btn ${state.assignmentsSubtab === 'talks' ? 'active' : ''}" data-tab="talks">Discursos</button>
    </div>
    <div id="assignments-content"></div>
  `;
  container.querySelectorAll('.subtab-btn').forEach((b) => b.addEventListener('click', () => { state.assignmentsSubtab = b.dataset.tab; renderAssignmentsView(); }));
  if (state.assignmentsSubtab === 'cleaning') await renderCleaningView();
  else await renderTalksView();
}

async function renderCleaningView() {
  const container = document.getElementById('assignments-content');
  container.innerHTML = skeletonCardsHtml(3);
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
      <div><p>Cada turno puede tener una o varias familias asignadas</p></div>
      <div style="display:flex; gap:8px;">
        ${shifts.length ? `<button class="btn btn-secondary btn-sm" id="cs-export-csv" title="Exportar a CSV">⬇️ CSV</button>` : ''}
        <button class="btn btn-primary" id="cs-new">+ Nuevo turno</button>
      </div>
    </div>
    <div class="card-list">
      ${dates.length ? dates.map((d) => cleaningDateCardHtml(d, byDate.get(d))).join('') : emptyStateHtml('Todavía no hay turnos asignados', { id: 'cs-empty-new', label: '+ Agregar el primero' })}
    </div>
  `;
  document.getElementById('cs-new').addEventListener('click', () => openCleaningShiftModal());
  wireEmptyStateCta('cs-empty-new', () => openCleaningShiftModal());
  const csvBtn = document.getElementById('cs-export-csv');
  if (csvBtn) csvBtn.addEventListener('click', () => {
    const statusLabel = { done: 'Sí fue', not_done: 'No fue' };
    downloadCsv('turnos-de-aseo.csv', ['Fecha', 'Familia', 'Estado'],
      shifts.map((s) => [fmtDateHuman(s.date), s.familyName, statusLabel[s.status] || 'Por confirmar']));
  });
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
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
          <div class="lc-title">🧹 ${esc(fmtDateHuman(date))}</div>
          ${entries.length > 1 ? `<button type="button" class="btn btn-ghost btn-sm cs-mark-all-done" data-date="${esc(date)}">✅ Marcar todas Sí fue</button>` : ''}
        </div>
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
        <div class="cfr-sub">${s.timesDone === 1 ? '1 vez' : s.timesDone + ' veces'} en total${s.lastDoneDate ? ' · última vez ' + esc(fmtDateHuman(s.lastDoneDate)) : ''}</div>
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
      if (!(await confirmModal('¿Quitar esta familia del turno?', { title: 'Quitar familia', confirmText: 'Quitar', danger: true }))) return;
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
  document.querySelectorAll('.cs-mark-all-done').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.cleaning-date-card');
      const ids = Array.from(card.querySelectorAll('.cleaning-family-row')).map((r) => Number(r.dataset.id));
      if (!ids.length) return;
      if (!(await confirmModal(`¿Marcar las ${ids.length} familias de este turno como "Sí fue"?`, { title: 'Marcar turno completo', confirmText: 'Marcar todas' }))) return;
      let okCount = 0;
      for (const id of ids) {
        try { await api(`/cleaning/shifts/${id}/mark`, { method: 'PUT', body: { status: 'done' } }); okCount++; }
        catch (e) { toast(e.message, 'error'); }
      }
      toast(`Turno actualizado (${okCount}/${ids.length})`);
      await renderCleaningView();
    });
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
  const csGuardedClose = wireUnsavedChangesGuard(document.getElementById('cs-form'));
  document.getElementById('cs-modal-close').addEventListener('click', csGuardedClose);
  document.getElementById('cs-cancel').addEventListener('click', csGuardedClose);
  document.getElementById('cs-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'cs-modal-backdrop') csGuardedClose(); });

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

// ---------------- Discursos (dentro de Asignaciones) ----------------
// Igual espíritu que Aseo: un registro es, ante todo, una FECHA (el
// domingo) a la que se le puede asignar uno o varios discursantes — así el
// listado queda una tarjeta por domingo, no una fila por discursante. El
// discursante se elige con el mismo buscador de miembros que usa
// Entrevistas (memberPickerFieldHtml/wireMemberPicker): si está registrado
// queda vinculado a su cuenta (para que el historial no se fragmente por
// variaciones de cómo se escribió el nombre), y si no, el nombre escrito a
// mano queda tal cual.

// A partir del mes en curso (inclusive) los domingos quedan "vigentes"
// (editables, con botón para agregar discursante); todo lo de meses ya
// terminados pasa a un "📜 Ver histórico" colapsado por defecto —
// consultable igual, pero de solo lectura, para que la pantalla principal
// no se vaya llenando de domingos que ya pasaron hace tiempo.
async function renderTalksView() {
  const container = document.getElementById('assignments-content');
  container.innerHTML = skeletonCardsHtml(3);
  let talks;
  try { talks = await api('/talks'); }
  catch (e) { toast(e.message, 'error'); container.innerHTML = '<div class="empty-state">No se pudo cargar</div>'; return; }
  const currentMonthKey = toISODate(new Date()).slice(0, 7);
  const current = talks.filter((t) => t.date.slice(0, 7) >= currentMonthKey);
  const past = talks.filter((t) => t.date.slice(0, 7) < currentMonthKey);

  const groupByDate = (items) => {
    const byDate = new Map();
    items.forEach((t) => { if (!byDate.has(t.date)) byDate.set(t.date, []); byDate.get(t.date).push(t); });
    return [...byDate.keys()].sort((a, b) => b.localeCompare(a)).map((d) => [d, byDate.get(d)]);
  };
  const currentGroups = groupByDate(current);
  const pastGroups = groupByDate(past);

  container.innerHTML = `
    <div class="section-header">
      <div><p>Quién discursó cada domingo en la reunión sacramental, y cuántas veces lo ha hecho</p></div>
      <button class="btn btn-primary" id="tk-new">+ Nuevo registro</button>
    </div>
    <div class="card-list">
      ${currentGroups.length ? currentGroups.map(([d, entries]) => talkDateCardHtml(d, entries, true)).join('') : emptyStateHtml('Todavía no hay discursos registrados este mes', { id: 'tk-empty-new', label: '+ Agregar el primero' })}
    </div>
    ${pastGroups.length ? `
      <button type="button" class="btn btn-secondary btn-sm" id="tk-history-toggle" style="margin-top:16px;">
        ${state.talksHistoryOpen ? '▲ Ocultar histórico' : `📜 Ver histórico (${pastGroups.length} domingo${pastGroups.length === 1 ? '' : 's'} de meses anteriores)`}
      </button>
      <div class="card-list" style="margin-top:10px;">
        ${state.talksHistoryOpen ? pastGroups.map(([d, entries]) => talkDateCardHtml(d, entries, false)).join('') : ''}
      </div>` : ''}
  `;
  document.getElementById('tk-new').addEventListener('click', () => openTalkModal());
  wireEmptyStateCta('tk-empty-new', () => openTalkModal());
  const historyToggle = document.getElementById('tk-history-toggle');
  if (historyToggle) historyToggle.addEventListener('click', () => { state.talksHistoryOpen = !state.talksHistoryOpen; renderTalksView(); });
  wireTalkCards(talks);
}

// editable=false (histórico) oculta "+ Agregar discursante" y los botones
// ✏️/🗑️ de cada fila — queda de solo lectura, pero el nombre del
// discursante se puede seguir apretando para ver su historial completo.
function talkDateCardHtml(date, entries, editable) {
  return `
    <div class="list-card cleaning-date-card">
      <div class="lc-main" style="width:100%;">
        <div class="lc-title">🎙️ ${esc(fmtDateHuman(date))}</div>
        <div class="cleaning-family-rows">
          ${entries.map((t) => talkEntryRowHtml(t, editable)).join('')}
        </div>
        ${editable ? `<button type="button" class="btn btn-secondary btn-sm tk-add-speaker" data-date="${esc(date)}" style="margin-top:10px;">+ Agregar discursante a este domingo</button>` : ''}
      </div>
    </div>`;
}

function talkEntryRowHtml(t, editable) {
  return `
    <div class="cleaning-family-row" data-id="${t.id}">
      <div class="cfr-main">
        <div class="cfr-name">
          <span class="clickable-name tk-speaker-name" data-speaker-name="${esc(t.speakerName)}" data-speaker-user-id="${t.speakerUserId || ''}" title="Ver historial completo de discursos">${esc(t.speakerName)}</span>
          ${t.topic ? ` <span style="font-weight:400; color:var(--ink-soft);">· ${esc(t.topic)}</span>` : ''}
        </div>
        <div class="cfr-sub">${t.timesSpoken === 1 ? '1 vez' : t.timesSpoken + ' veces'} en total${t.lastSpokenDate ? ' · última vez ' + esc(fmtDateHuman(t.lastSpokenDate)) : ''}</div>
      </div>
      ${editable ? `
        <div class="cfr-actions">
          <button type="button" class="btn btn-ghost btn-sm tk-edit" title="Editar">✏️</button>
          <button type="button" class="btn btn-ghost btn-sm tk-remove" title="Eliminar">🗑️</button>
        </div>` : ''}
    </div>`;
}

function talkSpeakerKey(t) {
  return t.speakerUserId ? `u:${t.speakerUserId}` : `n:${normalizeSearchText(t.speakerName)}`;
}

// Detalle de una persona: todo su historial de discursos (fecha + tema),
// sin importar si viene de la lista vigente o del histórico — así se puede
// "analizar" a la persona completa, tal como se pidió: cuántas veces,
// cuándo, y de qué habló cada vez.
function openSpeakerDetailModal(speakerName, speakerUserId, allTalks) {
  const key = speakerUserId ? `u:${speakerUserId}` : `n:${normalizeSearchText(speakerName)}`;
  const mine = allTalks.filter((t) => talkSpeakerKey(t) === key).sort((a, b) => b.date.localeCompare(a.date));
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="tksd-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>🎤 ${esc(speakerName)}</h3><button class="modal-close" id="tksd-modal-close">×</button></div>
        <div class="modal-body">
          <p class="hint-box" style="margin-top:0;">Ha discursado ${mine.length === 1 ? '1 vez' : mine.length + ' veces'} en total.</p>
          <div class="card-list">
            ${mine.map((t) => `
              <div class="list-card">
                <div class="lc-main">
                  <div class="lc-title">${esc(fmtDateHuman(t.date))}</div>
                  <div class="lc-sub" ${t.topic ? '' : 'style="font-style:italic;"'}>${t.topic ? esc(t.topic) : 'Sin tema registrado'}</div>
                </div>
              </div>`).join('')}
          </div>
        </div>
        <div class="modal-footer"><div></div><div><button class="btn btn-secondary" id="tksd-close">Cerrar</button></div></div>
      </div>
    </div>`;
  document.getElementById('tksd-modal-close').addEventListener('click', closeModal);
  document.getElementById('tksd-close').addEventListener('click', closeModal);
  document.getElementById('tksd-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'tksd-modal-backdrop') closeModal(); });
}

function wireTalkCards(talks) {
  document.querySelectorAll('#assignments-content .cleaning-family-row').forEach((row) => {
    const id = Number(row.dataset.id);
    const editBtn = row.querySelector('.tk-edit');
    if (editBtn) editBtn.addEventListener('click', () => {
      const talk = talks.find((t) => t.id === id);
      if (talk) openTalkEditModal(talk);
    });
    const removeBtn = row.querySelector('.tk-remove');
    if (removeBtn) removeBtn.addEventListener('click', async () => {
      if (!(await confirmModal('¿Eliminar este registro de discurso?', { title: 'Eliminar discurso', confirmText: 'Eliminar', danger: true }))) return;
      try {
        await api(`/talks/${id}`, { method: 'DELETE' });
        toast('Discurso eliminado');
        await renderTalksView();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
  document.querySelectorAll('.tk-add-speaker').forEach((btn) => {
    btn.addEventListener('click', () => openTalkModal(btn.dataset.date));
  });
  document.querySelectorAll('#assignments-content .tk-speaker-name').forEach((el) => {
    el.addEventListener('click', () => openSpeakerDetailModal(el.dataset.speakerName, el.dataset.speakerUserId || null, talks));
  });
}

// presetDate: si viene con valor, el modal funciona en modo "agregar
// discursante a un domingo que ya existe" (fecha fija); si no, funciona en
// modo "registro nuevo" (se elige la fecha, y se le pueden agregar de una
// varios discursantes con "+ Agregar otro discursante").
async function openTalkModal(presetDate) {
  let directory = [];
  let allTalks = [];
  try { directory = await api('/users/directory'); } catch (e) { directory = []; }
  try { allTalks = await api('/talks'); } catch (e) { allTalks = []; }
  const isAdd = !!presetDate;
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="tk-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>${isAdd ? 'Agregar discursante' : 'Nuevo registro de discursos'}</h3><button class="modal-close" id="tk-modal-close">×</button></div>
        <div class="modal-body">
          <div id="tk-error"></div>
          <form id="tk-form">
            <div class="field">
              <label>Domingo</label>
              <input type="date" name="date" required value="${esc(presetDate || '')}" ${isAdd ? 'readonly' : ''} />
            </div>
            <div class="field">
              <label>Discursantes</label>
              <div id="tk-speaker-rows"></div>
              <button type="button" class="btn btn-secondary btn-sm" id="tk-add-row">+ Agregar otro discursante</button>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="tk-cancel">Cancelar</button>
            <button class="btn btn-primary" id="tk-save">${isAdd ? 'Agregar' : 'Guardar registro'}</button>
          </div>
        </div>
      </div>
    </div>`;
  const tkGuardedClose = wireUnsavedChangesGuard(document.getElementById('tk-form'));
  document.getElementById('tk-modal-close').addEventListener('click', tkGuardedClose);
  document.getElementById('tk-cancel').addEventListener('click', tkGuardedClose);
  document.getElementById('tk-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'tk-modal-backdrop') tkGuardedClose(); });

  const talkSpeakerRowHtml = (rowId) => `
    <div class="family-row" data-row-id="${rowId}">
      <div style="display:flex; gap:8px; align-items:flex-start;">
        <div style="flex:1;">
          ${memberPickerFieldHtml(rowId, '', '')}
          <div class="field" style="margin-top:6px;">
            <input type="text" class="tk-topic" placeholder="Tema del discurso (opcional)" />
          </div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm tk-row-remove" title="Quitar este discursante">🗑️</button>
      </div>
      <div class="tk-row-stats hint-box" style="margin-top:6px; display:none;"></div>
    </div>`;

  const wireTalkSpeakerRow = (rowEl, rowId) => {
    const nameInput = document.getElementById(`${rowId}-member-name`);
    const hiddenId = document.getElementById(`${rowId}-member-user-id`);
    const statsBox = rowEl.querySelector('.tk-row-stats');
    const showStatsFor = () => {
      const name = nameInput.value;
      const userId = hiddenId.value;
      const norm = normalizeSearchText(name);
      if (!norm) { statsBox.style.display = 'none'; return; }
      const match = userId
        ? allTalks.find((t) => Number(t.speakerUserId) === Number(userId))
        : allTalks.find((t) => !t.speakerUserId && normalizeSearchText(t.speakerName) === norm);
      statsBox.style.display = '';
      statsBox.textContent = match
        ? `Ha discursado ${match.timesSpoken} ${match.timesSpoken === 1 ? 'vez' : 'veces'} · última vez: ${fmtDateHuman(match.lastSpokenDate)}`
        : 'Nunca ha discursado';
    };
    wireMemberPicker(rowId, directory, showStatsFor);
    nameInput.addEventListener('input', showStatsFor);
    rowEl.querySelector('.tk-row-remove').addEventListener('click', () => {
      const box = rowEl.parentElement;
      if (box.children.length > 1) rowEl.remove(); // siempre queda al menos una fila
    });
  };

  const rowsBox = document.getElementById('tk-speaker-rows');
  let rowCounter = 0;
  const addRow = () => {
    const rowId = `tk-row-${rowCounter++}`;
    rowsBox.insertAdjacentHTML('beforeend', talkSpeakerRowHtml(rowId));
    wireTalkSpeakerRow(rowsBox.lastElementChild, rowId);
  };
  document.getElementById('tk-add-row').addEventListener('click', addRow);
  addRow();

  document.getElementById('tk-save').addEventListener('click', async () => {
    const form = document.getElementById('tk-form');
    if (!form.reportValidity()) return;
    const speakers = Array.from(rowsBox.children).map((rowEl) => {
      const rowId = rowEl.dataset.rowId;
      return {
        speakerName: document.getElementById(`${rowId}-member-name`).value.trim(),
        speakerUserId: document.getElementById(`${rowId}-member-user-id`).value || null,
        topic: rowEl.querySelector('.tk-topic').value.trim(),
      };
    }).filter((s) => s.speakerName);
    if (!speakers.length) { document.getElementById('tk-error').innerHTML = '<div class="error-msg">Agrega al menos un discursante</div>'; return; }
    try {
      await api('/talks', { method: 'POST', body: { date: form.date.value, speakers } });
      closeModal();
      toast(isAdd ? 'Discursante agregado' : 'Registro creado');
      await renderTalksView();
    } catch (e) {
      document.getElementById('tk-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
    }
  });
}

// Edición de un registro puntual — a diferencia del alta (que usa el
// buscador de miembros con autocompletado), acá el nombre es un campo de
// texto simple: mismo criterio que ya usa Aseo del Edificio al editar un
// turno (PUT solo acepta el nombre como texto). Si el nombre se deja igual,
// se conserva el vínculo con el usuario registrado; si se cambia a mano,
// queda desvinculado — igual que "Quitar / escribir a mano" en Entrevistas.
function openTalkEditModal(talk) {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="tke-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>Editar discurso</h3><button class="modal-close" id="tke-modal-close">×</button></div>
        <div class="modal-body">
          <div id="tke-error"></div>
          <form id="tke-form">
            <div class="field">
              <label>Domingo</label>
              <input type="date" name="date" required value="${esc(talk.date)}" />
            </div>
            <div class="field">
              <label>Discursante</label>
              <input type="text" name="speakerName" required value="${esc(talk.speakerName)}" />
            </div>
            <div class="field">
              <label>Tema (opcional)</label>
              <input type="text" name="topic" value="${esc(talk.topic || '')}" />
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <div><button class="btn btn-danger" id="tke-delete">Eliminar</button></div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="tke-cancel">Cancelar</button>
            <button class="btn btn-primary" id="tke-save">Guardar cambios</button>
          </div>
        </div>
      </div>
    </div>`;
  const tkeGuardedClose = wireUnsavedChangesGuard(document.getElementById('tke-form'));
  document.getElementById('tke-modal-close').addEventListener('click', tkeGuardedClose);
  document.getElementById('tke-cancel').addEventListener('click', tkeGuardedClose);
  document.getElementById('tke-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'tke-modal-backdrop') tkeGuardedClose(); });
  document.getElementById('tke-delete').addEventListener('click', async () => {
    if (!(await confirmModal('¿Eliminar este registro de discurso?', { title: 'Eliminar discurso', confirmText: 'Eliminar', danger: true }))) return;
    try {
      await api(`/talks/${talk.id}`, { method: 'DELETE' });
      closeModal();
      toast('Discurso eliminado');
      await renderTalksView();
    } catch (e) { toast(e.message, 'error'); }
  });
  document.getElementById('tke-save').addEventListener('click', async () => {
    const form = document.getElementById('tke-form');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const newName = fd.get('speakerName').trim();
    const speakerUserId = newName === talk.speakerName ? talk.speakerUserId : null;
    try {
      await api(`/talks/${talk.id}`, { method: 'PUT', body: { date: fd.get('date'), speakerName: newName, speakerUserId, topic: fd.get('topic').trim() } });
      closeModal();
      toast('Discurso actualizado');
      await renderTalksView();
    } catch (e) {
      document.getElementById('tke-error').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
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
      ${isObispadoUser() ? `<button class="subtab-btn ${state.statsSubtab === 'rankings' ? 'active' : ''}" data-tab="rankings">Rachas y Logros</button>` : ''}
    </div>
    <div id="stats-content"></div>
  `;
  container.querySelectorAll('.subtab-btn').forEach((b) => b.addEventListener('click', () => { state.statsSubtab = b.dataset.tab; renderStatsView(); }));
  if (state.statsSubtab === 'pending') await renderStatsPending();
  else if (state.statsSubtab === 'rankings' && isObispadoUser()) await renderStatsRankings();
  else await renderStatsDashboard();
}

async function renderStatsPending() {
  const content = document.getElementById('stats-content');
  content.innerHTML = skeletonCardsHtml(3);
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
  const peGuardedClose = wireUnsavedChangesGuard(document.getElementById('pe-form'));
  document.getElementById('pe-modal-close').addEventListener('click', peGuardedClose);
  document.getElementById('pe-cancel').addEventListener('click', peGuardedClose);
  document.getElementById('pe-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'pe-modal-backdrop') peGuardedClose(); });
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

const MONTH_ABBR = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

// Mini-gráfico de tendencia (sparkline) del % de asistencia mes a mes, para
// ver de un vistazo si el año va mejorando o empeorando en vez de tener que
// comparar 12 números sueltos. Es un SVG armado a mano (sin librería de
// gráficos — la app no tiene build step ni dependencias) que salta los
// meses sin ninguna actividad evaluada (`pct: null`) en vez de dibujarlos
// como 0%, que sería engañoso. La línea punteada gris marca el 100% como
// referencia rápida de "asistencia completa".
function attendanceSparklineHtml(monthlyAttendance) {
  const withData = (monthlyAttendance || []).filter((m) => m.pct !== null);
  if (!withData.length) {
    return `<div class="hint-box" style="margin-top:0;">Todavía no hay actividades evaluadas este año para mostrar la tendencia mensual.</div>`;
  }
  const h = 70, padY = 10;
  const usableH = h - padY * 2;
  const maxPct = Math.max(100, ...withData.map((m) => m.pct));
  // x en porcentaje (0-100) del ancho del contenedor — así los puntitos,
  // que son divs HTML posicionados con `left: %`, coinciden exactamente con
  // el trazo del SVG sin importar el ancho real de la pantalla. Van
  // superpuestos como HTML (no <circle> del SVG) a propósito: un SVG con
  // viewBox estirado de forma no uniforme (ancho muy distinto al alto)
  // deja los círculos ovalados — un div con border-radius:50% no tiene ese
  // problema porque nunca se estira, solo se reposiciona.
  const xPct = (i) => (i / 11) * 100;
  const yFor = (pct) => padY + usableH - (usableH * pct) / maxPct;

  let pathParts = [];
  let drawing = false;
  monthlyAttendance.forEach((m, i) => {
    if (m.pct === null) { drawing = false; return; }
    pathParts.push(`${drawing ? 'L' : 'M'}${xPct(i).toFixed(2)},${yFor(m.pct).toFixed(1)}`);
    drawing = true;
  });

  const dotsHtml = monthlyAttendance.map((m, i) => {
    if (m.pct === null) return '';
    return `<div class="sparkline-dot" style="left:${xPct(i).toFixed(2)}%; top:${yFor(m.pct).toFixed(1)}px;" title="${MONTH_ABBR[i]}: ${m.pct}% (${m.count} actividad${m.count === 1 ? '' : 'es'} evaluada${m.count === 1 ? '' : 's'})"></div>`;
  }).join('');

  return `
    <div class="sparkline-wrap">
      <div class="sparkline-plot" style="height:${h}px;">
        <svg viewBox="0 0 100 ${h}" class="sparkline-svg" preserveAspectRatio="none">
          <line x1="0" y1="${yFor(100).toFixed(1)}" x2="100" y2="${yFor(100).toFixed(1)}" class="sparkline-baseline" vector-effect="non-scaling-stroke" />
          <path d="${pathParts.join(' ')}" class="sparkline-path" fill="none" vector-effect="non-scaling-stroke" />
        </svg>
        ${dotsHtml}
      </div>
      <div class="sparkline-labels">${MONTH_ABBR.map((m) => `<span>${m}</span>`).join('')}</div>
    </div>`;
}

async function renderStatsDashboard() {
  const content = document.getElementById('stats-content');
  content.innerHTML = skeletonCardsHtml(3);
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
    <div class="hint-box" style="margin-top:18px; margin-bottom:0;"><strong>Tendencia mensual de asistencia</strong></div>
    ${attendanceSparklineHtml(data.monthlyAttendance)}
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

// "Rachas y Logros": 6 rankings de todo el Barrio — compromisos cumplidos,
// aseo, entrevistas, discursos, actividades y actas de reunión registradas
// — solo visible para el Administrador o el líder de Obispado (mismo
// criterio que canSeeAssignmentsTab). Cada categoría tiene un nombre
// temático inspirado en una figura de las escrituras, elegida por el rasgo
// que mejor representa esa categoría (ver el mismo listado en
// server/src/achievements.js — debe mantenerse igual en ambos lados).
// Además de "Todo el tiempo" (histórico completo, siempre en vivo), hay 4
// períodos que se cierran solos apenas terminan (mes/trimestre/semestre/
// año): mientras están en curso se ven "🔴 En curso" con datos en vivo: una
// vez cerrados, el ganador de cada categoría queda fijo para siempre en
// "📜 Histórico", con un diploma descargable.
const ACHIEVEMENT_CATEGORIES_CLIENT = [
  { key: 'commitments', rankingKey: 'commitmentsRanking', icon: '🎯', label: 'Compromisos cumplidos', achievementName: 'Premio Nefi', blurb: 'Como Nefi ante cada encargo — "Iré y haré" (1 Nefi 3:7) — el mayor porcentaje de compromisos cumplidos.', emptyMsg: 'Todavía no hay compromisos resueltos', rowFn: rankingCommitmentRowHtml, csvRow: (r) => [r.userName, `${r.pct}%`, `${r.completed} cumplidos`] },
  { key: 'cleaning', rankingKey: 'cleaningRanking', icon: '🧹', label: 'Más aseo cumplido', achievementName: 'Premio Nehemías', blurb: 'Como Nehemías, que organizó al pueblo en turnos para reconstruir la muralla de Jerusalén (Nehemías 3) — la familia con más turnos de aseo cumplidos.', emptyMsg: 'Todavía no hay turnos de aseo cumplidos', rowFn: rankingCleaningRowHtml, csvRow: (r) => [r.familyName, r.timesDone, r.lastDoneDate ? fmtDateHuman(r.lastDoneDate) : ''] },
  { key: 'interviews', rankingKey: 'interviewsRanking', icon: '👤', label: 'Más entrevistas realizadas', achievementName: 'Premio Samuel', blurb: 'Como el joven Samuel — "Habla, que tu siervo oye" (1 Samuel 3:10) — quien más entrevistas realizó.', emptyMsg: 'Todavía no hay entrevistas registradas', rowFn: rankingInterviewRowHtml, csvRow: (r) => [r.interviewerName, r.count, ''] },
  { key: 'talks', rankingKey: 'talksRanking', icon: '🎤', label: 'Más discursos dados', achievementName: 'Premio Pablo', blurb: 'Como el apóstol Pablo, incansable predicando en cada ciudad — quien más veces discursó.', emptyMsg: 'Todavía no hay discursos registrados', rowFn: rankingTalkRowHtml, csvRow: (r) => [r.speakerName, r.timesSpoken, r.lastSpokenDate ? fmtDateHuman(r.lastSpokenDate) : ''] },
  { key: 'activities', rankingKey: 'activitiesRanking', icon: '📅', label: 'Más actividades registradas', achievementName: 'Premio Brigham Young', blurb: 'Como Brigham Young, que organizó al pueblo en compañías ordenadas para la travesía al oeste (D. y C. 136) — quien más actividades organizó.', emptyMsg: 'Todavía no hay actividades registradas', rowFn: rankingActivityRowHtml, csvRow: (r) => [r.userName, r.count, r.lastDate ? fmtDateHuman(r.lastDate) : ''] },
  { key: 'meetings', rankingKey: 'meetingsRanking', icon: '📋', label: 'Más actas de reunión registradas', achievementName: 'Premio Enoc', blurb: 'Como Enoc, cuyas palabras y ciudad quedaron registradas para siempre (Moisés 6-7) — quien más actas dejó registradas.', emptyMsg: 'Todavía no hay actas registradas', rowFn: rankingMeetingRowHtml, csvRow: (r) => [r.userName, r.count, r.lastDate ? fmtDateHuman(r.lastDate) : ''] },
];

// Junta todas las categorías de rankings en filas planas para exportar de
// una sola vez (CSV/PDF) — cada fila lleva su propia categoría porque son
// 6 rankings distintos, no una sola tabla.
function rankingsToRows(data) {
  const rows = [];
  ACHIEVEMENT_CATEGORIES_CLIENT.forEach((cat) => {
    (data[cat.rankingKey] || []).slice(0, 10).forEach((r, i) => {
      rows.push([cat.label, i + 1, ...cat.csvRow(r)]);
    });
  });
  return rows;
}
const ACHIEVEMENT_PERIODS_CLIENT = [
  { key: 'month', label: 'Este mes' },
  { key: 'quarter', label: 'Este trimestre' },
  { key: 'semester', label: 'Este semestre' },
  { key: 'year', label: 'Este año' },
  { key: 'allTime', label: 'Todo el tiempo' },
];

async function renderStatsRankings() {
  const content = document.getElementById('stats-content');
  content.innerHTML = `
    <div class="subtabs" style="margin-bottom:14px;">
      ${ACHIEVEMENT_PERIODS_CLIENT.map((p) => `<button class="subtab-btn ${state.achPeriod === p.key ? 'active' : ''}" data-period="${p.key}">${p.label}</button>`).join('')}
    </div>
    <div id="ach-body"></div>
  `;
  content.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => {
    state.achPeriod = b.dataset.period;
    renderStatsRankings();
  }));
  await renderAchievementsBody();
}

async function renderAchievementsBody() {
  const body = document.getElementById('ach-body');
  if (state.achPeriod === 'allTime') {
    body.innerHTML = '<div id="ach-content"></div>';
    await renderAchievementsAllTime();
    return;
  }
  body.innerHTML = `
    <div style="display:flex; gap:8px; margin-bottom:14px;">
      <button class="btn btn-sm ${state.achView === 'current' ? 'btn-primary' : 'btn-secondary'}" id="ach-view-current">🔴 En curso</button>
      <button class="btn btn-sm ${state.achView === 'history' ? 'btn-primary' : 'btn-secondary'}" id="ach-view-history">📜 Histórico</button>
    </div>
    <div id="ach-content"></div>
  `;
  document.getElementById('ach-view-current').addEventListener('click', () => { state.achView = 'current'; renderAchievementsBody(); });
  document.getElementById('ach-view-history').addEventListener('click', () => { state.achView = 'history'; renderAchievementsBody(); });
  if (state.achView === 'current') await renderAchievementsCurrent();
  else await renderAchievementsHistory();
}

async function renderAchievementsAllTime() {
  const el = document.getElementById('ach-content');
  el.innerHTML = skeletonCardsHtml(3);
  let data;
  try { data = await api('/stats/rankings'); }
  catch (e) { toast(e.message, 'error'); el.innerHTML = '<div class="empty-state">No se pudo cargar</div>'; return; }
  el.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
      <p class="hint-box" style="margin:0;">Rankings de todo el Barrio, desde siempre — visibles solo para el Obispado.</p>
      <div style="display:flex; gap:8px;">
        <button type="button" class="btn btn-secondary btn-sm" id="ach-export-csv" title="Exportar a CSV">⬇️ CSV</button>
        <button type="button" class="btn btn-secondary btn-sm" id="ach-export-pdf" title="Imprimir / Descargar PDF">🖨️ PDF</button>
      </div>
    </div>
    <div class="ranking-grid">${ACHIEVEMENT_CATEGORIES_CLIENT.map((cat) => rankingSectionHtml(cat, data[cat.rankingKey] || [])).join('')}</div>
  `;
  document.getElementById('ach-export-csv').addEventListener('click', () => {
    downloadCsv('rachas-y-logros-todo-el-tiempo.csv', ['Categoría', 'Puesto', 'Nombre', 'Valor', 'Detalle'], rankingsToRows(data));
  });
  document.getElementById('ach-export-pdf').addEventListener('click', () => {
    printReport('Rachas y Logros — Todo el tiempo', `Generado ${fmtDateHuman(toISODate(new Date()))}`,
      ['Categoría', 'Puesto', 'Nombre', 'Valor', 'Detalle'], rankingsToRows(data));
  });
}

async function renderAchievementsCurrent() {
  const el = document.getElementById('ach-content');
  el.innerHTML = skeletonCardsHtml(3);
  let data;
  try { data = await api(`/achievements/current?period=${state.achPeriod}`); }
  catch (e) { toast(e.message, 'error'); el.innerHTML = '<div class="empty-state">No se pudo cargar</div>'; return; }
  el.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
      <p class="hint-box" style="margin:0;">${esc(data.periodLabel)} — en curso. Este período se cierra solo apenas termine, y el ganador de cada categoría queda guardado para siempre en "📜 Histórico".</p>
      <div style="display:flex; gap:8px;">
        <button type="button" class="btn btn-secondary btn-sm" id="ach-export-csv" title="Exportar a CSV">⬇️ CSV</button>
        <button type="button" class="btn btn-secondary btn-sm" id="ach-export-pdf" title="Imprimir / Descargar PDF">🖨️ PDF</button>
      </div>
    </div>
    <div class="ranking-grid">${ACHIEVEMENT_CATEGORIES_CLIENT.map((cat) => rankingSectionHtml(cat, data[cat.rankingKey] || [])).join('')}</div>
  `;
  document.getElementById('ach-export-csv').addEventListener('click', () => {
    downloadCsv(`rachas-y-logros-${state.achPeriod}.csv`, ['Categoría', 'Puesto', 'Nombre', 'Valor', 'Detalle'], rankingsToRows(data));
  });
  document.getElementById('ach-export-pdf').addEventListener('click', () => {
    printReport(`Rachas y Logros — ${data.periodLabel}`, `Generado ${fmtDateHuman(toISODate(new Date()))}`,
      ['Categoría', 'Puesto', 'Nombre', 'Valor', 'Detalle'], rankingsToRows(data));
  });
}

async function renderAchievementsHistory() {
  const el = document.getElementById('ach-content');
  el.innerHTML = skeletonCardsHtml(3);
  let awards;
  try { awards = await api(`/achievements/history?period=${state.achPeriod}`); }
  catch (e) { toast(e.message, 'error'); el.innerHTML = '<div class="empty-state">No se pudo cargar</div>'; return; }
  if (!awards.length) { el.innerHTML = '<div class="empty-state">Todavía no hay períodos cerrados con premios — vuelve cuando termine el período en curso</div>'; return; }
  const byPeriod = new Map();
  awards.forEach((a) => { if (!byPeriod.has(a.periodKey)) byPeriod.set(a.periodKey, []); byPeriod.get(a.periodKey).push(a); });
  const periodKeys = [...byPeriod.keys()].sort((a, b) => b.localeCompare(a));
  el.innerHTML = periodKeys.map((pk) => {
    const items = byPeriod.get(pk);
    return `
      <div style="margin-bottom:26px;">
        <h3 style="font-size:15px; color:var(--celeste-darker); margin-bottom:10px;">🏆 ${esc(items[0].periodLabel)}</h3>
        <div class="ranking-row">${items.map(awardCardHtml).join('')}</div>
      </div>`;
  }).join('');
  el.querySelectorAll('.ach-diploma-btn').forEach((btn) => {
    const award = awards.find((a) => a.id === Number(btn.dataset.id));
    if (award) btn.addEventListener('click', () => openDiplomaModal(award));
  });
}

function awardCardHtml(a) {
  return `
    <div class="ranking-card" style="background:#fffbeb; border:1px solid #fde68a;">
      <div class="ranking-label">${a.categoryIcon} ${esc(a.categoryLabel)}</div>
      <div class="ranking-title">🏅 ${esc(a.achievementName)}</div>
      <div class="ranking-sub">${esc(a.winnerName)} · ${esc(a.valueLabel)}</div>
      <button type="button" class="btn btn-secondary btn-sm ach-diploma-btn" data-id="${a.id}" style="margin-top:10px;">🎓 Ver / descargar diploma</button>
    </div>`;
}

// Certificado imprimible/descargable: se ve dentro del modal, y el botón
// "Imprimir / Descargar PDF" usa window.print() — el navegador ya sabe
// exportar a PDF desde el diálogo de impresión, así que no hace falta
// ninguna librería extra para generar el archivo. El CSS de @media print
// (ver styles.css) oculta todo menos el diploma mientras se imprime.
function openDiplomaModal(a) {
  const modalRoot = document.getElementById('modal-root');
  const issuedDate = fmtDateHuman(toISODate(new Date()));
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="dip-modal-backdrop">
      <div class="modal" style="max-width:720px;">
        <div class="modal-header no-print"><h3>🎓 Diploma</h3><button class="modal-close" id="dip-modal-close">×</button></div>
        <div class="modal-body">
          <div id="diploma-print-area" class="diploma">
            <div class="diploma-border">
              <img class="diploma-logo" src="/logo-bee.png" alt="${esc(APP_NAME)}" />
              <div class="diploma-eyebrow">${esc(APP_NAME)}</div>
              <div class="diploma-title">${esc(a.achievementName)}</div>
              <div class="diploma-sub">${a.categoryIcon} ${esc(a.categoryLabel)} · ${esc(a.periodLabel)}</div>
              <div class="diploma-body-text">${esc(a.blurb)}</div>
              <div class="diploma-winner">${esc(a.winnerName)}</div>
              <div class="diploma-value">${esc(a.valueLabel)}</div>
              <div class="diploma-footer">Otorgado por el Obispado · ${esc(issuedDate)}</div>
            </div>
          </div>
        </div>
        <div class="modal-footer no-print">
          <div></div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary" id="dip-close">Cerrar</button>
            <button class="btn btn-primary" id="dip-print">🖨️ Imprimir / Descargar PDF</button>
          </div>
        </div>
      </div>
    </div>`;
  document.getElementById('dip-modal-close').addEventListener('click', closeModal);
  document.getElementById('dip-close').addEventListener('click', closeModal);
  document.getElementById('dip-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'dip-modal-backdrop') closeModal(); });
  document.getElementById('dip-print').addEventListener('click', () => window.print());
}

// ---------------- Exportar reportes (CSV / imprimir-a-PDF) ----------------
// El CSV se arma y descarga enteramente en el navegador — no hace falta
// ningún endpoint nuevo en el servidor. El "PDF" reutiliza exactamente el
// mismo mecanismo que ya usa el diploma de arriba: una tabla armada en un
// contenedor .print-area + window.print() — el navegador ya sabe exportar
// a PDF desde su propio diálogo de impresión, sin depender de ninguna
// librería extra (coherente con que este proyecto no usa dependencias).
function downloadCsv(filename, headers, rows) {
  const escCsv = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map(escCsv).join(','), ...rows.map((r) => r.map(escCsv).join(','))];
  // ﻿ (BOM): para que Excel abra los acentos/ñ correctamente en vez de mostrarlos rotos.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function printReport(title, meta, headers, rows) {
  let area = document.getElementById('report-print-area');
  if (!area) {
    area = document.createElement('div');
    area.id = 'report-print-area';
    area.className = 'print-area';
    document.body.appendChild(area);
  }
  area.innerHTML = `
    <div class="print-report">
      <h2>${esc(title)}</h2>
      <div class="print-report-meta">${esc(meta)} · ${esc(APP_NAME)}</div>
      <table>
        <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>`;
  window.print();
}

function rankingSectionHtml(cat, items) {
  return `
    <div class="ranking-section">
      <h3 style="font-size:14px; color:var(--celeste-darker); margin-bottom:2px;">${cat.icon} ${esc(cat.label)}</h3>
      <div class="hint-box" style="margin:0 0 8px; padding:6px 10px; font-size:11.5px;">🏅 ${esc(cat.achievementName)} — ${esc(cat.blurb)}</div>
      <div class="card-list">${items.length ? items.slice(0, 10).map((item, i) => cat.rowFn(item, i)).join('') : `<div class="empty-state">${cat.emptyMsg}</div>`}</div>
    </div>`;
}

function rankingMedal(i) {
  return i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
}

function rankingCommitmentRowHtml(r, i) {
  return `
    <div class="list-card">
      <div class="lc-main">
        <div class="lc-title">${rankingMedal(i)} ${esc(r.userName)}</div>
        <div class="lc-sub">${r.completed} cumplido${r.completed === 1 ? '' : 's'}${r.notFulfilled ? ' · ' + r.notFulfilled + ' no cumplido' + (r.notFulfilled === 1 ? '' : 's') : ''}</div>
      </div>
      <span class="status-pill ${r.pct >= 70 ? 'status-green' : r.pct >= 40 ? 'status-amber' : 'status-red'}">${r.pct}%</span>
    </div>`;
}

function rankingCleaningRowHtml(r, i) {
  return `
    <div class="list-card">
      <div class="lc-main">
        <div class="lc-title">${rankingMedal(i)} ${esc(r.familyName)}</div>
        <div class="lc-sub">${r.lastDoneDate ? 'Último: ' + esc(fmtDateHuman(r.lastDoneDate)) : ''}</div>
      </div>
      <span class="status-pill status-green">${r.timesDone}×</span>
    </div>`;
}

function rankingInterviewRowHtml(r, i) {
  return `
    <div class="list-card">
      <div class="lc-main">
        <div class="lc-title">${rankingMedal(i)} ${esc(r.interviewerName)}</div>
      </div>
      <span class="status-pill status-green">${r.count}×</span>
    </div>`;
}

function rankingTalkRowHtml(r, i) {
  return `
    <div class="list-card">
      <div class="lc-main">
        <div class="lc-title">${rankingMedal(i)} ${esc(r.speakerName)}</div>
        <div class="lc-sub">${r.lastSpokenDate ? 'Último: ' + esc(fmtDateHuman(r.lastSpokenDate)) : ''}</div>
      </div>
      <span class="status-pill status-green">${r.timesSpoken}×</span>
    </div>`;
}

function rankingActivityRowHtml(r, i) {
  return `
    <div class="list-card">
      <div class="lc-main">
        <div class="lc-title">${rankingMedal(i)} ${esc(r.userName)}</div>
        <div class="lc-sub">${r.lastDate ? 'Última: ' + esc(fmtDateHuman(r.lastDate)) : ''}</div>
      </div>
      <span class="status-pill status-green">${r.count}×</span>
    </div>`;
}

function rankingMeetingRowHtml(r, i) {
  return `
    <div class="list-card">
      <div class="lc-main">
        <div class="lc-title">${rankingMedal(i)} ${esc(r.userName)}</div>
        <div class="lc-sub">${r.lastDate ? 'Última: ' + esc(fmtDateHuman(r.lastDate)) : ''}</div>
      </div>
      <span class="status-pill status-green">${r.count}×</span>
    </div>`;
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
  container.innerHTML = skeletonViewHtml('Panel de Obispado', { cards: 2, stats: 4 });
  let data;
  try { data = await api('/dashboard/overview'); }
  catch (e) { toast(e.message, 'error'); container.innerHTML = '<div class="empty-state">No se pudo cargar</div>'; return; }

  container.innerHTML = `
    <div class="section-header">
      <div><h2>Panel de Obispado</h2><p>Resumen de todas las organizaciones — para no tener que revisar módulo por módulo</p></div>
    </div>
    ${bpWardCouncilAlertHtml(data.wardCouncil)}
    ${bpMinisteringAlertHtml(data.ministeringCoordination)}
    <div class="stats-cards" style="margin-bottom:22px;">
      <div class="stat-card"><div class="stat-card-label">Compromisos atrasados</div><div class="stat-card-value">${data.overdueCommitments.length}</div></div>
      <div class="stat-card"><div class="stat-card-label">Turnos de aseo sin confirmar</div><div class="stat-card-value">${data.cleaningPending.length}</div></div>
      <div class="stat-card"><div class="stat-card-label">Entrevistas — próximos 7 días</div><div class="stat-card-value">${data.upcomingInterviews.length}</div></div>
      <div class="stat-card"><div class="stat-card-label">Actividades — próximos 7 días</div><div class="stat-card-value">${data.activitiesThisWeek}</div></div>
    </div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px;" class="bp-grid">
      <div>
        <h3 style="font-size:14px; color:var(--celeste-darker); margin-bottom:8px;">⏰ Compromisos atrasados</h3>
        <div class="card-list${data.overdueCommitments.length > 1 ? ' bp-scroll-row' : ''}" id="bp-commitments-row">${data.overdueCommitments.length ? data.overdueCommitments.map(bpCommitmentRowHtml).join('') : '<div class="empty-state">Ninguno — al día 🎉</div>'}</div>
        ${bpScrollDotsHtml(data.overdueCommitments.length, 'bp-commitments-row')}
      </div>
      <div>
        <h3 style="font-size:14px; color:var(--celeste-darker); margin-bottom:8px;">🧹 Turnos de aseo sin confirmar</h3>
        <div class="card-list${data.cleaningPending.length > 1 ? ' bp-scroll-row' : ''}" id="bp-cleaning-row">${data.cleaningPending.length ? data.cleaningPending.map(bpCleaningRowHtml).join('') : '<div class="empty-state">Ninguno pendiente</div>'}</div>
        ${bpScrollDotsHtml(data.cleaningPending.length, 'bp-cleaning-row')}
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
  wireBishopricPanelActions();
  wireBishopricScrollDots();
}

// Punto 10 — aviso de Consejo de Barrio pendiente: la frecuencia esperada
// (en días) la define el Obispo y puede irla editando acá mismo, sin tener
// que ir a otra pantalla (ver PUT /api/ward-settings).
function bpWardCouncilAlertHtml(wc) {
  const okClass = wc.overdue ? '' : ' ok';
  const statusText = !wc.lastDate
    ? 'Todavía no hay ningún Consejo de Barrio registrado.'
    : wc.overdue
      ? `Han pasado ${wc.daysSinceLast} días desde el último (${esc(fmtDateHuman(wc.lastDate))}) — la frecuencia esperada es cada ${wc.frequencyDays} días.`
      : `Al día — el último fue hace ${wc.daysSinceLast} día${wc.daysSinceLast === 1 ? '' : 's'} (${esc(fmtDateHuman(wc.lastDate))}).`;
  return `
    <div class="council-alert-box${okClass}">
      <div class="council-alert-icon">${wc.overdue ? '⚠️' : '✅'}</div>
      <div class="council-alert-body">
        <div class="council-alert-title">⛪ Consejo de Barrio</div>
        <div>${statusText}</div>
        ${wc.overdue ? `<button type="button" class="btn btn-secondary btn-sm" id="bp-create-council">📋 Crear acta de Consejo de Barrio</button>` : ''}
        <form class="council-alert-freq-form" id="bp-council-freq-form">
          <label for="bp-council-freq" style="font-weight:600; font-size:12.5px;">Frecuencia esperada (días):</label>
          <input type="number" id="bp-council-freq" min="1" max="90" value="${wc.frequencyDays}" />
          <button type="submit" class="btn btn-ghost btn-sm">Guardar</button>
        </form>
      </div>
    </div>`;
}

// Punto 8 — aviso de Coordinación de Ministración trimestral: dirigido a
// las tres personas que el Manual General identifica específicamente (el
// Obispo, el presidente del Cuórum de Élderes y la presidenta de la
// Sociedad de Socorro — ver isPresident en users.js), no a "un líder"
// cualquiera de esas organizaciones.
function bpMinisteringAlertHtml(mc) {
  const okClass = mc.overdue ? '' : ' ok';
  const leaderName = (l) => l ? esc(l.name) : '(sin definir — marcar en Usuarios)';
  const statusText = mc.overdue
    ? `Todavía no se ha registrado una Coordinación de Ministración este trimestre (${esc(mc.quarterLabel)}).`
    : `Al día — ya se registró en este trimestre (${esc(mc.quarterLabel)}).`;
  return `
    <div class="council-alert-box${okClass}">
      <div class="council-alert-icon">${mc.overdue ? '⚠️' : '✅'}</div>
      <div class="council-alert-body">
        <div class="council-alert-title">🤝 Coordinación de Ministración (trimestral)</div>
        <div>${statusText}</div>
        <div style="margin-top:6px; font-size:12.5px;">Obispo: ${leaderName(mc.keyLeaders.bishop)} · Presidente Cuórum de Élderes: ${leaderName(mc.keyLeaders.eldersQuorumPresident)} · Presidenta Sociedad de Socorro: ${leaderName(mc.keyLeaders.reliefSocietyPresident)}</div>
        ${mc.overdue ? `<button type="button" class="btn btn-secondary btn-sm" id="bp-create-ministering">📋 Crear acta de Coordinación de Ministración</button>` : ''}
      </div>
    </div>`;
}

// Las esferitas reemplazan la barra de scroll nativa (que queda escondida
// por CSS) para las cajas "de a una tarjeta a la vez" del Panel de
// Obispado: una por tarjeta, gris, y la de la tarjeta que se está viendo se
// pinta celeste — igual que un carrusel. Se puede tocar una esfera para
// saltar directo a esa tarjeta.
function bpScrollDotsHtml(count, targetId) {
  if (count <= 1) return '';
  const dots = Array.from({ length: count }, (_, i) => `<button type="button" class="bp-scroll-dot${i === 0 ? ' active' : ''}" data-index="${i}" aria-label="Tarjeta ${i + 1} de ${count}"></button>`).join('');
  return `<div class="bp-scroll-dots" data-target="${targetId}">${dots}</div>`;
}

function wireBishopricScrollDots() {
  document.querySelectorAll('.bp-scroll-dots').forEach((dotsEl) => {
    const row = document.getElementById(dotsEl.dataset.target);
    if (!row) return;
    const dots = Array.from(dotsEl.querySelectorAll('.bp-scroll-dot'));
    const updateActive = () => {
      const idx = Math.max(0, Math.min(dots.length - 1, Math.round(row.scrollLeft / Math.max(1, row.clientWidth))));
      dots.forEach((d, i) => d.classList.toggle('active', i === idx));
    };
    row.addEventListener('scroll', () => window.requestAnimationFrame(updateActive));
    dots.forEach((d, i) => {
      d.addEventListener('click', () => row.scrollTo({ left: i * row.clientWidth, behavior: 'smooth' }));
    });
  });
}

// Cada tarjeta representa el compromiso de UNA persona — solo ella (o un
// Administrador desde Reuniones y Consejos) lo puede marcar como cumplido,
// para que el comentario "cómo se hizo" sea confiable. Por eso el botón
// "✅ Completar" solo aparece cuando quien ve el panel ES el responsable;
// en cualquier otra tarjeta, tocarla lleva directo a esa acta en Reuniones
// y Consejos para hacer seguimiento con esa persona.
function bpCommitmentRowHtml(c) {
  const isMine = !!state.user && Number(c.assignedToUserId) === Number(state.user.id);
  return `
    <div class="list-card bp-commitment-card" data-meeting-id="${c.meetingId}" data-commitment-id="${c.commitmentId}" style="flex-direction:column; align-items:stretch; gap:8px; ${isMine ? '' : 'cursor:pointer;'}">
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
        <div class="lc-main">
          <div class="lc-title">${esc(c.description)}</div>
          <div class="lc-sub">${esc(c.organizationName)} · "${esc(c.meetingTitle)}" · responsable: ${esc(c.assignedToName)} · vencía ${esc(fmtDateHuman(c.dueDate))}</div>
        </div>
        <span class="status-pill status-red">Atrasado</span>
      </div>
      ${isMine ? `
      <div>
        <button type="button" class="btn btn-secondary btn-sm bp-commitment-complete-toggle">✅ Completar</button>
      </div>
      <div class="bp-commitment-complete-form" style="display:none;">
        <textarea class="bp-commitment-comment" placeholder="Comentario breve (opcional)" rows="2" style="width:100%; margin-bottom:8px;"></textarea>
        <button type="button" class="btn btn-primary btn-sm bp-commitment-complete-save">Guardar</button>
      </div>` : ''}
    </div>`;
}

// El líder de Obispado (o Admin) sí puede marcar cualquier turno de aseo
// directamente desde acá — ya es la misma regla que rige todo el módulo
// Aseo del Edificio (isObispadoLeader), no hace falta ser "responsable" de
// nada como con los compromisos.
function bpCleaningRowHtml(s) {
  return `
    <div class="list-card" style="flex-direction:column; align-items:stretch; gap:8px;">
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
        <div class="lc-main">
          <div class="lc-title">${esc(s.familyName)}</div>
          <div class="lc-sub">Turno del ${esc(fmtDateHuman(s.date))}</div>
        </div>
        <span class="status-pill status-amber">Sin confirmar</span>
      </div>
      <div class="lc-actions">
        <button type="button" class="btn btn-ghost btn-sm bp-cs-mark" data-id="${s.id}" data-status="done" title="Sí fue">✅ Sí fue</button>
        <button type="button" class="btn btn-ghost btn-sm bp-cs-mark" data-id="${s.id}" data-status="not_done" title="No fue">❌ No fue</button>
      </div>
    </div>`;
}

function wireBishopricPanelActions() {
  document.getElementById('bp-create-council')?.addEventListener('click', () => goCreateMeetingOfType('consejo_barrio'));
  document.getElementById('bp-create-ministering')?.addEventListener('click', () => goCreateMeetingOfType('coordinacion_ministracion'));
  document.getElementById('bp-council-freq-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('bp-council-freq');
    const days = Number(input.value);
    if (!Number.isFinite(days) || days < 1 || days > 90) { toast('La frecuencia debe ser un número entre 1 y 90 días', 'error'); return; }
    try {
      await api('/ward-settings', { method: 'PUT', body: { councilFrequencyDays: days } });
      toast('Frecuencia actualizada');
      await renderBishopricPanelView();
    } catch (err) { toast(err.message, 'error'); }
  });
  document.querySelectorAll('.bp-commitment-card').forEach((card) => {
    const toggleBtn = card.querySelector('.bp-commitment-complete-toggle');
    if (toggleBtn) {
      const form = card.querySelector('.bp-commitment-complete-form');
      toggleBtn.addEventListener('click', () => { form.style.display = form.style.display === 'none' ? '' : 'none'; });
      card.querySelector('.bp-commitment-complete-save').addEventListener('click', async (e) => {
        const btn = e.target;
        btn.disabled = true;
        const comment = card.querySelector('.bp-commitment-comment').value.trim();
        try {
          await api(`/commitments/${card.dataset.commitmentId}/complete`, { method: 'PUT', body: { comment } });
          toast('Compromiso completado');
          await renderBishopricPanelView();
        } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
      });
    } else {
      // No es tu compromiso: tocar la tarjeta lleva directo a esa acta en
      // Reuniones y Consejos (mismo destino que un resultado de búsqueda de
      // categoría "meetings" — ver goToSearchResult).
      card.addEventListener('click', () => goToSearchResult('meetings', Number(card.dataset.meetingId), ''));
    }
  });
  document.querySelectorAll('.bp-cs-mark').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/cleaning/shifts/${btn.dataset.id}/mark`, { method: 'PUT', body: { status: btn.dataset.status } });
        toast('Turno actualizado');
        await renderBishopricPanelView();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
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
