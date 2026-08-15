// Calendario de Organizaciones — frontend sin frameworks ni build step.
// Todo el estado vive en el objeto `state`; cada cambio relevante llama a render().

const API = '/api';
const APP_NAME = 'Calendario Barrio Valle Grande';
const DOW_LABELS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MONTH_LABELS = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const ROLE_LABELS = { admin: 'Administrador', leader: 'Líder', member: 'Miembro' };
const COLOR_PALETTE = ['#0EA5E9','#6366F1','#EC4899','#F59E0B','#10B981','#A855F7','#EF4444','#F97316','#14B8A6','#84CC16','#F43F5E','#8B5CF6'];

const state = {
  token: localStorage.getItem('cow_token') || null,
  user: null,
  organizations: [],
  view: 'calendar',
  calMonth: startOfMonth(new Date()),
  activeOrgIds: null, // null = todas
  events: [],
  interviews: [],
  interviewOrgFilter: 'all',
  adminSubtab: 'users',
  adminUsers: [],
  loading: false,
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

function locationFieldHtml(idPrefix, existingLocation) {
  const loc = existingLocation || '';
  const isStandard = STANDARD_LOCATIONS.includes(loc);
  const isOtro = !!loc && !isStandard;
  return `
    <div class="field">
      <label>Lugar</label>
      <select name="locationType" id="${idPrefix}-location-type" required>
        <option value="" disabled ${!loc ? 'selected' : ''}>Selecciona un lugar…</option>
        ${STANDARD_LOCATIONS.map((l) => `<option value="${esc(l)}" ${loc === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        <option value="Otro" ${isOtro ? 'selected' : ''}>Otro (especificar)</option>
      </select>
    </div>
    <div class="field" id="${idPrefix}-location-other-field" style="${isOtro ? '' : 'display:none;'}">
      <label>¿Cuál lugar?</label>
      <input type="text" name="locationOther" placeholder="Ej: Estacionamiento" value="${esc(isOtro ? loc : '')}" />
    </div>`;
}

function wireLocationField(idPrefix, onChange) {
  const sel = document.getElementById(`${idPrefix}-location-type`);
  const otherField = document.getElementById(`${idPrefix}-location-other-field`);
  sel.addEventListener('change', () => {
    otherField.style.display = sel.value === 'Otro' ? '' : 'none';
    if (onChange) onChange();
  });
}

function computeLocationFromForm(fd) {
  const type = fd.get('locationType');
  if (type === 'Otro') return String(fd.get('locationOther') || '').trim();
  return type || '';
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
    <div class="hint-box" id="${idPrefix}-recurrence-hint" style="display:none;">Se crea una actividad independiente por cada fecha — después puedes editar o eliminar una fecha puntual sin afectar a las demás. El aviso de choque solo revisa la primera fecha (el campo "Día"); si hace falta, revisa las demás fechas a mano.</div>`;
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

// Revisa si lo que se está por agendar (actividad o entrevista) choca en
// horario o en lugar con una ACTIVIDAD de OTRA organización el mismo día.
// Si ambas comparten alguna organización (como dueña o como participante),
// no se considera choque — ya están coordinadas a propósito.
// No compara contra entrevistas (son privadas de cada organización).
async function findConflictingActivities(candidate, excludeEventId) {
  if (!candidate.date || !candidate.startTime || !candidate.organizationId) return [];
  let dayEvents;
  try { dayEvents = await api(`/events?from=${candidate.date}&to=${candidate.date}`); } catch (e) { return []; }
  const candidateOrgs = orgSetForConflictCheck(candidate);
  return dayEvents.filter((ev) => {
    if (excludeEventId && ev.id === Number(excludeEventId)) return false;
    const evOrgs = orgSetForConflictCheck(ev);
    if (candidateOrgs.some((id) => evOrgs.includes(id))) return false;
    const timeConflict = timesOverlap(candidate.startTime, candidate.endTime, ev.startTime, ev.endTime);
    const placeConflict = candidate.location && ev.location && normalizeLocation(candidate.location) === normalizeLocation(ev.location);
    return timeConflict || placeConflict;
  });
}

function conflictWarningHtml(conflicts) {
  return `<div class="hint-box" style="border-color:#f59e0b; background:#fffbeb;">
    ⚠️ <strong>Posible choque con otra organización</strong> — vuelve a presionar el botón para agendar de todas formas:
    <ul style="margin:6px 0 0; padding-left:18px;">
      ${conflicts.map((c) => `<li><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c.organizationColor};margin-right:4px;"></span><strong>${esc(c.organizationName)}</strong> — ${esc(c.title || c.memberName || '')} · ${esc(fmtTime(c.startTime))}${c.endTime ? ' - ' + esc(fmtTime(c.endTime)) : ''}${c.location ? ' · 📍 ' + esc(c.location) : ''}</li>`).join('')}
    </ul>
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
  } catch (e) {
    setToken(null);
    renderLogin();
  }
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
function canSeeInterviewsTab() {
  return !!state.user && state.user.role !== 'member';
}
function canSeeMyActivitiesTab() {
  return !!state.user && (state.user.role === 'leader' || state.user.role === 'member');
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
      ${canSeeMyActivitiesTab() ? `<button class="tab-btn ${state.view === 'myActivities' ? 'active' : ''}" data-view="myActivities">Mis Actividades</button>` : ''}
      ${canSeeInterviewsTab() ? `<button class="tab-btn ${state.view === 'interviews' ? 'active' : ''}" data-view="interviews">Entrevistas</button>` : ''}
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
  root.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  if (state.view === 'calendar') renderCalendarView();
  else if (state.view === 'myActivities') renderMyActivitiesView();
  else if (state.view === 'interviews') renderInterviewsView();
  else if (state.view === 'admin') renderAdminView();
}

// ---------------- Calendario ----------------
async function loadCalendarData() {
  const gridStart = gridStartDate(state.calMonth);
  const gridEnd = new Date(gridStart); gridEnd.setDate(gridEnd.getDate() + 41);
  const from = toISODate(gridStart), to = toISODate(gridEnd);
  const [events, interviews] = await Promise.all([
    api(`/events?from=${from}&to=${to}`),
    api(`/interviews?from=${from}&to=${to}`),
  ]);
  state.events = events;
  state.interviews = interviews;
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
    const items = [
      ...dayEvents.map((e) => ({ ...e, kind: 'event' })),
      ...dayInterviews.map((iv) => ({ ...iv, kind: 'interview', title: iv.memberName })),
    ].sort((a, b) => a.startTime.localeCompare(b.startTime));

    const MAX_SHOW = 3;
    const visible = items.slice(0, MAX_SHOW);
    const extra = items.length - visible.length;

    cellsHtml += `
      <div class="cal-cell ${otherMonth ? 'other-month' : ''} ${isToday ? 'today' : ''}" data-date="${iso}">
        <div class="cal-daynum">${cellDate.getDate()}</div>
        ${visible.map((it) => `
          <button class="cal-event ${it.kind === 'interview' ? 'is-interview' : ''}" style="background:${it.organizationColor}" data-kind="${it.kind}" data-id="${it.id}" title="${esc(fmtTime(it.startTime))} ${esc(eventTitlePrefix(it) + it.title)}${it.location ? ' — ' + esc(it.location) : ''}">
            ${esc(fmtTime(it.startTime))} ${it.kind === 'interview' ? '👤' : ''} ${esc(eventTitlePrefix(it) + it.title)}
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
    <div class="org-filters">${chips}</div>
    <div class="cal-grid">
      ${DOW_LABELS.map((d) => `<div class="cal-dow">${d}</div>`).join('')}
      ${cellsHtml}
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
    } else {
      openItemModal(state.interviews.find((i) => i.id === Number(btn.dataset.id)), 'interview');
    }
  }));
  container.querySelectorAll('[data-more]').forEach((btn) => btn.addEventListener('click', () => openDayModal(btn.dataset.more)));
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
  ].sort((a, b) => a.startTime.localeCompare(b.startTime));
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
                  <div class="lc-title">${it.kind === 'interview' ? '👤 ' : eventTitlePrefix(it)}${esc(it.title)}</div>
                  <div class="lc-sub">${esc(it.organizationName)}${it.location ? ` · <span class="lc-location">📍 ${esc(it.location)}</span>` : ''}${it.kind === 'interview' && it.interviewerName ? ` · 🧑‍💼 ${esc(it.interviewerName)}` : ''}${it.kind === 'event' ? involvedOrgsBadgesHtml(it) : ''}</div>
                </div>
                <div class="lc-when">${esc(fmtTime(it.startTime))}${it.endTime ? ' - ' + esc(fmtTime(it.endTime)) : ''}</div>
              </div>`).join('') : '<div class="empty-state">Sin actividades este día</div>'}
          </div>
        </div>
      </div>
    </div>`;
  document.getElementById('day-modal-close').addEventListener('click', closeModal);
  document.getElementById('day-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'day-modal-backdrop') closeModal(); });
  modalRoot.querySelectorAll('.list-card').forEach((card) => card.addEventListener('click', () => {
    if (card.dataset.kind === 'event') openItemModal(state.events.find((e) => e.id === Number(card.dataset.id)), 'event');
    else openItemModal(state.interviews.find((i) => i.id === Number(card.dataset.id)), 'interview');
  }));
}

function closeModal() { document.getElementById('modal-root').innerHTML = ''; }

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
  const title = kind === 'interview' ? item.memberName : item.title;
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="ro-modal-backdrop">
      <div class="modal">
        <div class="modal-header"><h3>${kind === 'interview' ? '👤 ' : eventTitlePrefix(item)}${esc(title)}</h3><button class="modal-close" id="ro-modal-close">×</button></div>
        <div class="modal-body">
          <div class="ro-detail-row"><span class="org-dot" style="background:${item.organizationColor}"></span><strong>${esc(item.organizationName)}</strong>${kind === 'event' ? involvedOrgsBadgesHtml(item) : ''}</div>
          <div class="ro-detail-row">📅 ${esc(fmtDateHuman(item.date))}</div>
          <div class="ro-detail-row">🕐 ${esc(fmtTime(item.startTime))}${item.endTime ? ' - ' + esc(fmtTime(item.endTime)) : ''}</div>
          ${item.location ? `<div class="ro-detail-row">📍 ${esc(item.location)}</div>` : ''}
          ${kind === 'interview' && item.interviewerName ? `<div class="ro-detail-row">🧑‍💼 ${esc(item.interviewerName)}</div>` : ''}
          ${kind === 'interview' && item.memberPhone ? `<div class="ro-detail-row">📞 ${esc(item.memberPhone)}</div>` : ''}
          ${kind === 'interview' && item.memberEmail ? `<div class="ro-detail-row">✉️ ${esc(item.memberEmail)}</div>` : ''}
          ${item.description ? `<div class="ro-detail-row ro-desc">${esc(item.description)}</div>` : ''}
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
  events = events.filter((ev) => Number(ev.organizationId) === myOrgId || ev.isWardActivity || (ev.involvedOrganizations || []).some((o) => Number(o.id) === myOrgId));
  const myOwnInterviews = interviews.filter((iv) => Number(iv.memberUserId) === Number(state.user.id));
  const list = [
    ...events.map((ev) => ({ ...ev, kind: 'event' })),
    ...myOwnInterviews.map((iv) => ({ ...iv, kind: 'interview', title: iv.description || 'Entrevista' })),
  ].sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  const todayIso = toISODate(new Date());
  const grouped = {};
  for (const it of list) { (grouped[it.date] ||= []).push(it); }
  const dates = Object.keys(grouped).sort();

  container.innerHTML = `
    <div class="section-header">
      <div>
        <h2>Mis Actividades</h2>
        <p>Todas las actividades de ${esc(state.user.organization ? state.user.organization.name : 'tu organización')}, más las entrevistas en las que a ti te entrevistan — en un listado, sin tener que navegar mes a mes</p>
      </div>
      <button class="btn btn-primary" id="my-act-new">+ Nueva actividad</button>
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
                <div class="lc-sub">${it.kind === 'interview' ? `Te entrevista ${esc(it.organizationName)}${it.interviewerName ? ' · ' + esc(it.interviewerName) : ''}` : ''}${it.location ? `${it.kind === 'interview' ? ' · ' : ''}<span class="lc-location">📍 ${esc(it.location)}</span>` : ''}${it.kind === 'event' && it.description ? (it.location ? ' · ' : '') + esc(it.description) : ''}${it.kind === 'event' ? involvedOrgsBadgesHtml(it) : ''}</div>
              </div>
              <div class="lc-when">${esc(fmtTime(it.startTime))}${it.endTime ? ' - ' + esc(fmtTime(it.endTime)) : ''}</div>
            </div>`).join('')}
        </div>`).join('') : '<div class="empty-state">Todavía no tienes actividades agendadas</div>'}
    </div>
  `;

  document.getElementById('my-act-new').addEventListener('click', () => openEventModal());
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
  const list = [
    ...events.map((ev) => ({ ...ev, kind: 'event' })),
    ...myInterviews.map((iv) => ({ ...iv, kind: 'interview', title: iv.description || 'Entrevista' })),
  ].sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  const todayIso = toISODate(new Date());
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
      <button class="btn btn-secondary" id="my-act-prefs-toggle">${prefsOpen ? 'Ocultar selección' : '⚙️ Elegir organizaciones'}</button>
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
                <div class="lc-sub">${esc(it.organizationName)}${it.location ? ` · <span class="lc-location">📍 ${esc(it.location)}</span>` : ''}${it.kind === 'interview' && it.interviewerName ? ` · con ${esc(it.interviewerName)}` : ''}${it.kind === 'event' && it.description ? ' · ' + esc(it.description) : ''}${it.kind === 'event' ? involvedOrgsBadgesHtml(it) : ''}</div>
              </div>
              <div class="lc-when">${esc(fmtTime(it.startTime))}${it.endTime ? ' - ' + esc(fmtTime(it.endTime)) : ''}</div>
            </div>`).join('')}
        </div>`).join('') : `<div class="empty-state">${followedIds.length ? 'No hay actividades próximas de las organizaciones que elegiste' : 'Elige qué organizaciones te interesan para ver sus actividades acá'}</div>`}
    </div>
  `;

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
            ${locationFieldHtml('ev', existing?.location)}
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
  const saveBtn = document.getElementById('ev-save');
  const resetConflictCheck = () => {
    conflictsChecked = false;
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
    const body = Object.fromEntries(fd.entries());
    body.location = location;
    delete body.locationType;
    delete body.locationOther;
    body.isWardActivity = document.getElementById('ev-ward-activity').checked;
    body.involvedOrganizationIds = body.isWardActivity ? [] : computeInvolvedOrgIds(fd);
    body.isMeeting = document.getElementById('ev-type-select').value === 'meeting';

    if (!conflictsChecked) {
      const conflicts = await findConflictingActivities(body, existing?.id);
      if (conflicts.length) {
        document.getElementById('ev-conflict-warning').innerHTML = conflictWarningHtml(conflicts);
        conflictsChecked = true;
        saveBtn.textContent = 'Agendar de todas formas';
        return;
      }
    }
    const dates = !isEdit ? computeRecurrenceDates('ev', body.date) : [body.date];
    try {
      if (isEdit) await api(`/events/${existing.id}`, { method: 'PUT', body });
      else if (dates.length > 1) await api('/events/recurring', { method: 'POST', body: { ...body, dates } });
      else await api('/events', { method: 'POST', body });
      closeModal();
      toast(isEdit ? 'Actividad actualizada' : (dates.length > 1 ? `${dates.length} actividades creadas` : 'Actividad creada'));
      await refreshAfterEventChange();
    } catch (e) {
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
                <div class="lc-sub">${esc(iv.organizationName)}${iv.location ? ` · <span class="lc-location">📍 ${esc(iv.location)}</span>` : ''}${iv.interviewerName ? ` · 🧑‍💼 ${esc(iv.interviewerName)}` : ''}${iv.description ? ' · ' + esc(iv.description) : ''}${iv.memberPhone ? ' · ' + esc(iv.memberPhone) : ''}</div>
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
            ${locationFieldHtml('iv', existing?.location)}
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
    const body = Object.fromEntries(fd.entries());
    body.memberUserId = body.memberUserId ? Number(body.memberUserId) : null;
    body.location = location;
    delete body.locationType;
    delete body.locationOther;
    if (isEdit) body.organizationId = existing.organizationId;

    if (!ivConflictsChecked) {
      const conflicts = await findConflictingActivities(body, null);
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
    </div>
    <div id="admin-content"></div>
  `;
  container.querySelectorAll('.subtab-btn').forEach((b) => b.addEventListener('click', () => { state.adminSubtab = b.dataset.tab; renderAdminView(); }));
  if (state.adminSubtab === 'users') await renderAdminUsers();
  else if (state.adminSubtab === 'orgs') await renderAdminOrgs();
  else await renderAdminRequests();
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

boot();
