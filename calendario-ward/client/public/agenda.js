// ----------------------------------------------------------------------
// AGENDA PERSONAL Y AYUDA MEMORIA (cliente)
// ----------------------------------------------------------------------
//  - Pendientes sin fecha en Inicio (26)
//  - Botón "+" con opciones grandes: recordatorio, pendiente, actividad… (31)
//  - Tarjeta "Guardado para el jueves 10 a las 19:00" con Ver / Deshacer (36)
//  - Duración automática: entrevista 30 min, reunión 1 hora (11)
//  - Borrador: si cierras un formulario sin guardar, te ofrece seguir (25)
//  - Ayuda "?" en los campos (43)
//  - Volver a la última pantalla (47) · teclado numérico en montos (49)
//  - Refrescar solo cuando otro líder cambia algo (68)
//  - Calendario anual (99)
// Servidor: routes/agenda.js
// ----------------------------------------------------------------------
(function () {
  const $ = (id) => document.getElementById(id);
  const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ic = (n, t = 16) => { try { return icon(n, t); } catch (x) { return ''; } };
  const aviso = (m, t) => { try { toast(m, t); } catch (x) { console.log(m); } };
  const conSesion = () => { try { return !!state.user; } catch (x) { return false; } };
  const llamar = (ruta, o) => api(ruta, o); // usa el wrapper de app.js (barra de carga, errores amables)
  const p2 = (n) => String(n).padStart(2, '0');
  const isoLocal = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const fechaHumana = (iso) => { try { return fmtDateHuman(iso); } catch (x) { return iso; } };

  // ================= 26 · Pendientes sin fecha =================
  async function pintarPendientesHome() {
    const cont = $('home-pendientes');
    if (!cont) return;
    cont.dataset.cargado = '1';
    let lista = [];
    try { lista = await llamar('/pendientes'); } catch (x) { return; }
    const abiertos = lista.filter((p) => !p.hecho);
    const hechos = lista.filter((p) => p.hecho).slice(0, 3);
    cont.innerHTML = `<div class="card home-card">
      <div class="home-card-t">${ic('note', 18)} Pendientes sin fecha ${abiertos.length ? `<span class="home-hoy-f">${abiertos.length}</span>` : ''}</div>
      ${[...abiertos, ...hechos].map((p) => `<label class="pend-item ${p.hecho ? 'hecho' : ''}"><input type="checkbox" data-pend="${p.id}" ${p.hecho ? 'checked' : ''}/><span class="pend-t">${e(p.texto)}</span><button type="button" class="pend-x" data-pend-x="${p.id}" aria-label="Quitar">×</button></label>`).join('') || '<p class="home-hoy-vacio">Anota aquí lo que no quieres olvidar, aunque no tenga fecha. Deseret te lo recuerda los lunes.</p>'}
      <form class="pend-nuevo" id="pend-form"><input id="pend-in" maxlength="200" placeholder="Ej: preguntarle al obispo por el campamento" enterkeyhint="done" /><button class="btn btn-secondary btn-sm" type="submit">Agregar</button></form>
    </div>`;
    cont.querySelectorAll('[data-pend]').forEach((c) => c.addEventListener('change', async () => {
      try { await llamar(`/pendientes/${c.dataset.pend}`, { method: 'PUT', body: { hecho: c.checked } }); } catch (x) { /* el wrapper avisa */ }
      pintarPendientesHome();
    }));
    cont.querySelectorAll('[data-pend-x]').forEach((b) => b.addEventListener('click', async (ev) => {
      ev.preventDefault();
      try { await llamar(`/pendientes/${b.dataset.pendX}`, { method: 'DELETE' }); } catch (x) { return; }
      pintarPendientesHome();
    }));
    $('pend-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const t = $('pend-in').value.trim();
      if (!t) return;
      try { await llamar('/pendientes', { method: 'POST', body: { texto: t } }); } catch (x) { return; }
      pintarPendientesHome();
    });
  }
  window.pintarPendientesHome = pintarPendientesHome;

  // ================= 31 · Botón "+" con opciones grandes =================
  function hoja(html) {
    const r = $('modal-root');
    r.innerHTML = `<div class="modal-backdrop bottom-sheet-backdrop" id="mas-fondo"><div class="bottom-sheet"><div class="bottom-sheet-handle"></div>${html}</div></div>`;
    $('mas-fondo').addEventListener('click', (x) => { if (x.target.id === 'mas-fondo') r.innerHTML = ''; });
    return () => { r.innerHTML = ''; };
  }
  function abrirMas(otras) {
    const puedeAct = (() => { try { return canManageAnyEvents(); } catch (x) { return false; } })();
    const puedeEnt = (() => { try { return TAB_DEFS.interviews.visible(); } catch (x) { return false; } })();
    const puedeActa = (() => { try { return TAB_DEFS.meetings.visible(); } catch (x) { return false; } })();
    const ops = [
      { k: 'rec', n: 'Recordatorio', i: 'clock', c: '#7c3aed' },
      { k: 'pend', n: 'Pendiente', i: 'note', c: '#0d9488' },
      puedeAct && { k: 'act', n: 'Actividad', i: 'calendar', c: '#16a34a' },
      puedeEnt && { k: 'ent', n: 'Entrevista', i: 'user', c: '#2563eb' },
      puedeActa && { k: 'comp', n: 'Compromiso', i: 'flag', c: '#ea580c' },
      puedeActa && { k: 'acta', n: 'Acta', i: 'clipboard', c: '#0369a1' },
    ].filter(Boolean);
    const resto = (otras || []).filter((a) => !['cal-new-event', 'iv-new', 'meeting-new'].includes(a.id));
    const cerrar = hoja(`<p class="af-lbl" style="margin:2px 6px 10px;font-weight:700">¿Qué quieres agregar?</p>
      <div class="mas-grid">${ops.map((o) => `<button type="button" class="mas-op" data-mas="${o.k}" style="--c:${o.c}"><span class="ic">${ic(o.i, 22)}</span>${o.n}</button>`).join('')}</div>
      ${resto.length ? `<div class="bottom-sheet-list mas-otros">${resto.map((a) => `<button type="button" class="bottom-sheet-item" data-otra="${a.id}"><span class="bottom-nav-icon">${a.icon}</span><span>${e(a.label)}</span></button>`).join('')}</div>` : ''}`);
    document.querySelectorAll('[data-mas]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.mas; cerrar();
      if (k === 'rec') abrirRecordatorio();
      else if (k === 'pend') abrirPendienteRapido();
      else if (k === 'act') openEventModal();
      else if (k === 'ent') runQuickCreateAction(QUICK_CREATE_ACTIONS.find((a) => a.id === 'iv-new'));
      else if (k === 'acta') runQuickCreateAction(QUICK_CREATE_ACTIONS.find((a) => a.id === 'meeting-new'));
      else if (k === 'comp' && typeof window.preguntarDeseret === 'function') window.preguntarDeseret('quiero anotar un compromiso');
    }));
    document.querySelectorAll('[data-otra]').forEach((b) => b.addEventListener('click', () => {
      const a = resto.find((x) => x.id === b.dataset.otra); cerrar(); if (a) runQuickCreateAction(a);
    }));
  }
  // Reemplaza el menú del "+" de app.js (las mismas acciones quedan en "más").
  window.openQuickCreateMenu = abrirMas;
  // El "+" se muestra a todos (también a quien no crea actividades: recordatorios y pendientes).
  function asegurarFab() {
    const fab = $('mobile-fab');
    if (!fab || fab.dataset.agenda) return;
    fab.dataset.agenda = '1';
    fab.hidden = false;
    fab.onclick = () => abrirMas(QUICK_CREATE_ACTIONS.filter((a) => { try { return a.visible(); } catch (x) { return false; } }));
  }

  function modalSimple(titulo, cuerpo, textoOk) {
    const r = $('modal-root');
    r.innerHTML = `<div class="modal-backdrop" id="ms-fondo"><div class="modal" role="dialog" aria-label="${e(titulo)}">
      <div class="modal-header"><h3>${e(titulo)}</h3><button class="modal-close" id="ms-x" aria-label="Cerrar">×</button></div>
      <div class="modal-body"><form id="ms-form">${cuerpo}</form><div id="ms-err"></div></div>
      <div class="modal-footer" style="justify-content:flex-end"><button class="btn btn-secondary" id="ms-cancel" type="button">Cancelar</button><button class="btn btn-primary" id="ms-ok" type="button">${e(textoOk)}</button></div></div></div>`;
    const cerrar = () => { r.innerHTML = ''; };
    $('ms-x').addEventListener('click', cerrar); $('ms-cancel').addEventListener('click', cerrar);
    $('ms-fondo').addEventListener('click', (x) => { if (x.target.id === 'ms-fondo') cerrar(); });
    return { cerrar, form: $('ms-form') };
  }
  function abrirRecordatorio() {
    const ahora = new Date(); const en1 = new Date(ahora.getTime() + 60 * 60000);
    const { cerrar, form } = modalSimple('Nuevo recordatorio', `
      <div class="field"><label>¿Qué te recuerdo?</label><input name="texto" maxlength="200" required placeholder="Ej: llamar al hermano Soto" /></div>
      <div class="af-chips" style="margin:-4px 0 12px;display:flex;gap:6px;flex-wrap:wrap">
        <button type="button" class="btn btn-ghost btn-sm" data-rap="1h">En 1 hora</button><button type="button" class="btn btn-ghost btn-sm" data-rap="noche">Hoy 20:00</button><button type="button" class="btn btn-ghost btn-sm" data-rap="manana">Mañana 9:00</button><button type="button" class="btn btn-ghost btn-sm" data-rap="domingo">Domingo 8:00</button>
      </div>
      <div class="two-col"><div class="field"><label>Día</label><input type="date" name="fecha" required value="${isoLocal(en1)}" /></div>
      <div class="field"><label>Hora</label><input type="time" name="hora" required value="${p2(en1.getHours())}:${p2(Math.floor(en1.getMinutes() / 5) * 5)}" /></div></div>`, 'Guardar');
    form.querySelector('[name=texto]').focus();
    form.querySelectorAll('[data-rap]').forEach((b) => b.addEventListener('click', () => {
      const d = new Date(); let h = '09:00';
      if (b.dataset.rap === '1h') { d.setTime(d.getTime() + 3600000); h = `${p2(d.getHours())}:${p2(d.getMinutes())}`; }
      else if (b.dataset.rap === 'noche') h = '20:00';
      else if (b.dataset.rap === 'manana') d.setDate(d.getDate() + 1);
      else if (b.dataset.rap === 'domingo') { d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7)); h = '08:00'; }
      form.fecha.value = isoLocal(d); form.hora.value = h;
    }));
    $('ms-ok').addEventListener('click', async () => {
      if (!form.reportValidity()) return;
      try {
        const r = await llamar('/recordatorios', { method: 'POST', body: { texto: form.texto.value, fecha: form.fecha.value, hora: form.hora.value } });
        cerrar(); confirmar(`Te recuerdo el ${fechaHumana(r.fecha)} a las ${r.hora}`, [{ n: 'Ver en Inicio', f: () => { state.view = 'home'; renderCurrentView(); } }]);
        if (state.view === 'home') renderCurrentView();
      } catch (x) { $('ms-err').innerHTML = `<div class="error-msg">${e(x.message)}</div>`; }
    });
  }
  function abrirPendienteRapido() {
    const { cerrar, form } = modalSimple('Nuevo pendiente', `<div class="field"><label>¿Qué no quieres olvidar?</label><input name="texto" maxlength="200" required placeholder="Ej: preguntarle al obispo por el campamento" /></div><p class="hint-box" style="margin:0">Queda en Inicio, sin fecha. Los lunes Deseret te recuerda los que sigan abiertos.</p>`, 'Guardar');
    form.querySelector('[name=texto]').focus();
    const ok = async () => {
      if (!form.reportValidity()) return;
      try { await llamar('/pendientes', { method: 'POST', body: { texto: form.texto.value } }); cerrar(); aviso('Pendiente guardado en Inicio'); if (state.view === 'home') pintarPendientesHome(); } catch (x) { $('ms-err').innerHTML = `<div class="error-msg">${e(x.message)}</div>`; }
    };
    $('ms-ok').addEventListener('click', ok);
    form.addEventListener('submit', (x) => { x.preventDefault(); ok(); });
  }
  window.abrirRecordatorioRapido = abrirRecordatorio;

  // ================= 36 · Tarjeta "Guardado" con Ver / Deshacer =================
  let tgTimer = null;
  function confirmar(texto, acciones = []) {
    document.querySelector('.toast-guardado')?.remove();
    const el = document.createElement('div');
    el.className = 'toast-guardado'; el.setAttribute('role', 'status');
    el.innerHTML = `<div class="tg-t">${ic('check', 18)}<span>${e(texto)}</span></div>${acciones.length ? `<div class="tg-acc">${acciones.map((a, i) => `<button type="button" data-i="${i}" class="${a.prim ? 'prim' : ''}">${e(a.n)}</button>`).join('')}</div>` : ''}`;
    document.body.appendChild(el);
    el.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => { el.remove(); acciones[Number(b.dataset.i)].f(); }));
    clearTimeout(tgTimer); tgTimer = setTimeout(() => el.remove(), 9000);
  }
  window.confirmarGuardado = (tipo, obj) => {
    borrarBorrador(tipo === 'actividad' ? 'ev-form' : 'iv-form');
    const cuando = `${fechaHumana(obj.date)}${obj.startTime ? ` a las ${String(obj.startTime).slice(0, 5)}` : ''}`;
    const ver = () => { try { state.view = 'calendar'; state.calViewMode = 'month'; const [y, m] = obj.date.split('-').map(Number); state.calMonth = new Date(y, m - 1, 1); loadCalendarData().then(renderCurrentView); } catch (x) { /* nada */ } };
    const deshacer = async () => {
      try {
        await llamar(tipo === 'actividad' ? `/events/${obj.id}` : `/interviews/${obj.id}`, { method: 'DELETE' });
        aviso(tipo === 'actividad' ? 'Listo, se deshizo: la actividad se borró' : 'Listo, se deshizo: la entrevista se borró');
        try { if (tipo === 'actividad') await refreshAfterEventChange(); else await refreshAfterInterviewChange(); } catch (x) { renderCurrentView(); }
      } catch (x) { /* el wrapper avisa */ }
    };
    const acciones = [{ n: 'Deshacer', f: deshacer }, { n: 'Ver', f: ver, prim: tipo !== 'actividad' || obj.isMeeting }];
    // 87: apenas creas una actividad, Deseret ofrece armar los preparativos.
    if (tipo === 'actividad' && !obj.isMeeting && typeof window.abrirPreparativos === 'function') acciones.push({ n: 'Armar preparativos', f: () => window.abrirPreparativos(obj.id, { sugerir: true }), prim: true });
    confirmar(`Guardado para el ${cuando}`, acciones);
  };
  window.toastGuardado = confirmar;

  // ================= 11 · Duración automática =================
  const sumarMin = (hm, min) => { const [h, m] = hm.split(':').map(Number); const t = Math.min(23 * 60 + 59, h * 60 + m + min); return `${p2(Math.floor(t / 60))}:${p2(t % 60)}`; };
  function duracionDe(form) {
    if (form.id === 'iv-form' || form.id === 'ivc-form') return 30;
    if (form.id === 'ev-form') { const t = $('ev-type-select'); return t && t.value === 'meeting' ? 60 : 0; }
    return 0;
  }
  function ponerFin(form) {
    const ini = form.querySelector('[name=startTime]'); const fin = form.querySelector('[name=endTime]');
    if (!ini || !fin || !ini.value) return;
    const min = duracionDe(form);
    if (!min) return;
    if (fin.value && !fin.dataset.auto) return; // la persona ya eligió una hora de término
    fin.value = sumarMin(ini.value, min); fin.dataset.auto = '1';
    fin.dispatchEvent(new Event('change', { bubbles: true }));
  }
  document.addEventListener('change', (x) => {
    const t = x.target; const form = t && t.closest && t.closest('form');
    if (!form) return;
    if (t.name === 'startTime' || t.id === 'ev-type-select') ponerFin(form);
    if (t.name === 'endTime' && x.isTrusted) delete t.dataset.auto;
  }, true);

  // ================= 25 · Borradores =================
  const CLAVE_B = (id) => `borrador_${id}_${(() => { try { return state.user.id; } catch (x) { return ''; } })()}`;
  function borrarBorrador(id) { try { localStorage.removeItem(CLAVE_B(id)); } catch (x) { /* nada */ } }
  function esNuevo(form) { return form.id === 'ev-form' ? !$('ev-delete') : form.id === 'iv-form' ? !$('iv-delete') : false; }
  function leerCampos(form) {
    const o = {};
    form.querySelectorAll('input, select, textarea').forEach((c) => {
      if (!c.name || c.type === 'hidden' || c.type === 'file') return;
      if (c.type === 'checkbox') { o[`${c.name}::${c.value}`] = c.checked; return; }
      if (c.type === 'radio') { if (c.checked) o[c.name] = c.value; return; }
      o[c.name] = c.value;
    });
    return o;
  }
  function vigilarBorrador(form) {
    if (form.dataset.borrador) return;
    form.dataset.borrador = '1';
    if (!esNuevo(form)) return;
    const clave = CLAVE_B(form.id);
    let previo = null;
    try { previo = JSON.parse(localStorage.getItem(clave) || 'null'); } catch (x) { previo = null; }
    if (previo && Date.now() - previo.t < 24 * 3600000 && Object.values(previo.campos || {}).some((v) => v && v !== true && String(v).trim())) {
      const caja = document.createElement('div');
      caja.className = 'hint-box borrador-aviso';
      const hora = new Date(previo.t);
      caja.innerHTML = `${ic('note', 16)} Dejaste esto a medias${previo.campos.title ? `: <b>${e(previo.campos.title)}</b>` : ''} (${p2(hora.getHours())}:${p2(hora.getMinutes())}). <span style="display:inline-flex;gap:6px;margin-left:4px"><button type="button" class="btn btn-primary btn-sm" data-b="seguir">Seguir</button><button type="button" class="btn btn-ghost btn-sm" data-b="no">Descartar</button></span>`;
      form.prepend(caja);
      caja.querySelector('[data-b=seguir]').addEventListener('click', () => {
        const c = previo.campos;
        const orden = ['organizationId', 'locationType', 'salaType'];
        const nombres = [...new Set([...orden, ...Object.keys(c)])];
        for (const n of nombres) {
          if (!(n in c)) continue;
          if (n.includes('::')) { const [nm, val] = n.split('::'); const el = form.querySelector(`[name="${nm}"][value="${CSS.escape(val)}"]`); if (el && el.checked !== c[n]) { el.checked = c[n]; el.dispatchEvent(new Event('change', { bubbles: true })); } continue; }
          const els = form.querySelectorAll(`[name="${n}"]`);
          els.forEach((el) => {
            if (el.type === 'radio') { if (el.value === c[n]) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); } }
            else if (el.value !== c[n]) { el.value = c[n]; el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('input', { bubbles: true })); }
          });
        }
        caja.remove();
      });
      caja.querySelector('[data-b=no]').addEventListener('click', () => { borrarBorrador(form.id); caja.remove(); });
    }
    let t = null;
    const guardar = () => { clearTimeout(t); t = setTimeout(() => { try { localStorage.setItem(clave, JSON.stringify({ t: Date.now(), campos: leerCampos(form) })); } catch (x) { /* nada */ } }, 400); };
    form.addEventListener('input', guardar);
    form.addEventListener('change', guardar);
  }

  // ================= 43 · Ayuda "?" =================
  document.addEventListener('click', (x) => {
    const b = x.target.closest && x.target.closest('.ayuda-q');
    if (!b) return;
    x.preventDefault(); x.stopPropagation();
    const sig = b.nextElementSibling;
    if (sig && sig.classList.contains('ayuda-txt')) { sig.remove(); return; }
    const s = document.createElement('span'); s.className = 'ayuda-txt'; s.textContent = b.dataset.ayuda;
    b.after(s);
  }, true);

  // ================= 49 · Teclado numérico en montos =================
  document.addEventListener('focusin', (x) => {
    const t = x.target;
    if (!(t instanceof HTMLInputElement) || t.getAttribute('inputmode')) return;
    if (t.type === 'number' || /amount|monto|valor|precio|cantidad|total/i.test(`${t.name} ${t.id}`)) t.setAttribute('inputmode', /cantidad/i.test(`${t.name} ${t.id}`) ? 'numeric' : 'decimal');
  });

  // ================= 47 · Recordar la pantalla al salir =================
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' || !conSesion()) return;
    try { localStorage.setItem('ultima_vista', JSON.stringify({ v: state.view, t: Date.now() })); } catch (x) { /* nada */ }
  });

  // ================= 68 · Refrescar cuando otro cambia algo =================
  let version = null; let ultimoInput = 0;
  document.addEventListener('input', () => { ultimoInput = Date.now(); }, true);
  const hayVentana = () => !!document.querySelector('#modal-root .modal-backdrop, #afiche-root .modal-backdrop, #prep-root .modal-backdrop, #orgf-root .modal-backdrop, #inf-root .modal-backdrop, #escucha-root .modal-backdrop, .bottom-sheet');
  async function revisarVersion() {
    if (!conSesion() || document.visibilityState !== 'visible') return;
    let v;
    try { const r = await fetch('/api/version', { headers: { Authorization: `Bearer ${state.token || localStorage.getItem('cow_token')}` } }); if (!r.ok) return; v = (await r.json()).v; } catch (x) { return; }
    if (version === null) { version = v; return; }
    if (v === version) return;
    // Solo se refresca si no estás escribiendo ni con una ventana abierta.
    if (hayVentana() || Date.now() - ultimoInput < 20000 || ['meetings', 'admin', 'wardGrowth', 'budget'].includes(state.view)) return;
    version = v;
    const y = window.scrollY;
    try {
      if (state.view === 'calendar' && typeof loadCalendarData === 'function') await loadCalendarData();
      window.__sinFundido = true;
      renderCurrentView();
      setTimeout(() => { window.__sinFundido = false; window.scrollTo(0, y); }, 400);
    } catch (x) { /* nada */ }
  }
  setInterval(revisarVersion, 45000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(revisarVersion, 1500); });

  // ================= 99 · Calendario anual =================
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  window.pintarAnio = async (cont, anio, filtroOrg, alElegirMes) => {
    if (!cont) return;
    let evs = [];
    try { evs = await llamar(`/events?from=${anio}-01-01&to=${anio}-12-31`); } catch (x) { cont.innerHTML = `<p class="hint-box">${e(x.message)}</p>`; return; }
    if (!document.body.contains(cont)) return;
    evs = (Array.isArray(evs) ? evs : []).filter((x) => !x.isMeeting && (typeof filtroOrg !== 'function' || filtroOrg(x.organizationId)));
    const porDia = new Map();
    evs.forEach((x) => { const l = porDia.get(x.date) || []; l.push(x); porDia.set(x.date, l); });
    const hoy = isoLocal(new Date());
    const fer = (iso) => (typeof window.feriadoDe === 'function' ? window.feriadoDe(iso) : '');
    let html = `<div class="anio-cab"><button class="btn btn-ghost btn-sm" data-anio="${anio - 1}">‹ ${anio - 1}</button><b>${anio}</b><button class="btn btn-ghost btn-sm" data-anio="${anio + 1}">${anio + 1} ›</button></div><div class="anio-grid">`;
    for (let m = 0; m < 12; m++) {
      const pri = new Date(anio, m, 1); const dias = new Date(anio, m + 1, 0).getDate();
      const desplaz = (pri.getDay() + 6) % 7; // semana parte el lunes
      const total = evs.filter((x) => x.date.slice(5, 7) === p2(m + 1)).length;
      html += `<div class="anio-mes" data-mes="${m}" role="button" tabindex="0" aria-label="${MESES[m]} ${anio}: ${total} actividades"><h4>${MESES[m]} <small>${total ? `${total} act.` : ''}</small></h4><div class="anio-dias">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d) => `<span class="dow">${d}</span>`).join('')}${'<span></span>'.repeat(desplaz)}`;
      for (let d = 1; d <= dias; d++) {
        const iso = `${anio}-${p2(m + 1)}-${p2(d)}`;
        const l = porDia.get(iso) || [];
        const colores = [...new Set(l.map((x) => x.organizationColor || '#94a3b8'))].slice(0, 3);
        html += `<span class="anio-dia ${iso === hoy ? 'hoy' : ''} ${fer(iso) ? 'feriado' : ''}" title="${e([fer(iso) ? `Feriado: ${fer(iso)}` : "", ...l.map((x) => `${x.title} (${x.organizationName || ''})`)].filter(Boolean).join('\n'))}">${d}${colores.length ? `<span class="anio-puntos">${colores.map((c) => `<i style="background:${e(c)}"></i>`).join('')}</span>` : ''}</span>`;
      }
      html += '</div></div>';
    }
    cont.innerHTML = `${html}</div>`;
    cont.querySelectorAll('[data-mes]').forEach((el) => {
      const ir = () => alElegirMes && alElegirMes(anio, Number(el.dataset.mes));
      el.addEventListener('click', ir); el.addEventListener('keydown', (x) => { if (x.key === 'Enter') ir(); });
    });
    cont.querySelectorAll('[data-anio]').forEach((b) => b.addEventListener('click', () => { state.calMonth = new Date(Number(b.dataset.anio), 0, 1); renderCalendarView(); }));
  };

  // ================= Observador: formularios nuevos, botón "+" =================
  const revisar = () => {
    if (!conSesion()) return;
    asegurarFab();
    ['ev-form', 'iv-form'].forEach((id) => { const f = $(id); if (f) vigilarBorrador(f); });
    const home = $('home-pendientes');
    if (home && !home.dataset.cargado) { home.dataset.cargado = '1'; pintarPendientesHome(); }
  };
  let pend = null;
  new MutationObserver(() => { if (!pend) pend = setTimeout(() => { pend = null; revisar(); }, 60); }).observe(document.body, { childList: true, subtree: true });
  revisar();
})();
