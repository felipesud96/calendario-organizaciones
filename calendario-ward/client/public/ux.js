// ----------------------------------------------------------------------
// DETALLES DE USO (lote de mejoras UX)
// ----------------------------------------------------------------------
//  - Íconos de línea en vez de emojis al inicio de títulos y botones.
//  - Vibración corta al guardar y al fallar (en celulares que la tengan).
//  - Botón "Guardado" en verde un instante después de guardar.
//  - Animación al completar y confeti cuando todo queda listo.
//  - Tirar hacia abajo para actualizar (Inicio, Calendario, Reuniones).
//  - Mantener presionado: menú con acciones rápidas.
//  - Horas rápidas junto a "Hora de inicio".
//  - Borrador automático del acta nueva.
//  - Arrastrar para ordenar (window.ordenarArrastrando).
// No agrega pantallas nuevas: solo mejora las que ya existen.
// ----------------------------------------------------------------------
(function () {
  const $ = (id) => document.getElementById(id);
  const e = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ic = (n, s = 16) => { try { return icon(n, s); } catch (x) { return ''; } };
  const conSesion = () => { try { return !!(state && state.user); } catch (x) { return false; } };
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
  const menosMovimiento = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ================= Vibración =================
  const vibrar = (patron) => { try { if (navigator.vibrate) navigator.vibrate(patron); } catch (x) { /* nada */ } };
  window.vibrar = vibrar;
  if (typeof toast === 'function') {
    const toastOriginal = toast;
    // eslint-disable-next-line no-global-assign
    toast = function (mensaje, tipo = 'success') { vibrar(tipo === 'error' ? [40, 60, 40] : 15); return toastOriginal(mensaje, tipo); };
  }

  // ================= Confeti =================
  window.confeti = function () {
    if (menosMovimiento()) return;
    const c = document.createElement('div');
    c.className = 'confeti'; c.setAttribute('aria-hidden', 'true');
    const colores = ['#0ea5e9', '#22c55e', '#f59e0b', '#ef4444', '#6366f1', '#ec4899'];
    for (let i = 0; i < 70; i++) {
      const p = document.createElement('i');
      p.style.left = `${Math.random() * 100}%`;
      p.style.background = colores[i % colores.length];
      p.style.animationDelay = `${Math.random() * 0.5}s`;
      p.style.animationDuration = `${1.2 + Math.random() * 0.9}s`;
      p.style.transform = `rotate(${Math.random() * 360}deg)`;
      c.appendChild(p);
    }
    document.body.appendChild(c);
    vibrar([20, 40, 20]);
    setTimeout(() => c.remove(), 2600);
  };

  // ================= api(): botón "Guardado", animación al completar =================
  const hoyISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  async function revisarSemanaCompleta() {
    try {
      const clave = `confeti_semana_${state.user.id}`;
      if (localStorage.getItem(clave) === hoyISO()) return;
      const r = await apiOriginal('/mi-semana');
      if (r && r.totales && r.totales.compromisos === 0) {
        localStorage.setItem(clave, hoyISO());
        window.confeti();
        toast('¡Cumpliste todos tus compromisos de la semana!');
      }
    } catch (x) { /* nada */ }
  }
  let apiOriginal = null;
  if (typeof api === 'function') {
    apiOriginal = api;
    // eslint-disable-next-line no-global-assign
    api = async function (ruta, opts = {}) {
      const metodo = (opts && opts.method) || 'GET';
      const boton = metodo !== 'GET' && document.activeElement && document.activeElement.tagName === 'BUTTON' ? document.activeElement : null;
      const r = await apiOriginal(ruta, opts);
      if (metodo === 'GET') return r;
      // Animación al completar un compromiso
      const mc = /^\/commitments\/(\d+)\/complete$/.exec(ruta);
      if (mc) {
        const els = document.querySelectorAll(`.assignment-card[data-id="${mc[1]}"], [data-commitment-id="${mc[1]}"].commitment-detail-row, .bp-commitment-card[data-commitment-id="${mc[1]}"], .home-item[data-tipo="compromiso"][data-id="${mc[1]}"]`);
        if (els.length && !menosMovimiento()) { els.forEach((x) => x.classList.add('anim-hecho')); await dormir(450); }
        revisarSemanaCompleta();
      }
      if (/^\/meetings$/.test(ruta) && metodo === 'POST') borrarBorradorActa();
      // Botón en verde: "Guardado"
      if (boton && boton.isConnected && /btn-primary/.test(boton.className) && !boton.dataset.okFijo) {
        const antes = boton.innerHTML;
        boton.dataset.okFijo = '1';
        boton.classList.add('btn-ok');
        boton.innerHTML = `${ic('check', 15)} Guardado`;
        setTimeout(() => { if (boton.isConnected) { boton.innerHTML = antes; boton.classList.remove('btn-ok'); } delete boton.dataset.okFijo; }, 1200);
      }
      return r;
    };
  }

  // Al marcar una casilla de pendiente o preparativo: pequeña animación.
  document.addEventListener('change', (x) => {
    const t = x.target;
    if (!t || t.type !== 'checkbox' || !t.checked) return;
    const fila = t.closest('.pend-item, .prep-item, .prep-fila, li');
    if (fila && (t.dataset.pend || t.dataset.prepMarcar)) { fila.classList.remove('anim-hecho'); void fila.offsetWidth; fila.classList.add('anim-hecho'); vibrar(15); }
  }, true);

  // ================= Íconos en vez de emojis =================
  const EMOJI_ICONO = {
    '✅': 'check', '✔️': 'check', '📋': 'clipboard', '📅': 'calendar', '🗓️': 'calendar', '🗓': 'calendar', '📆': 'calendar', '❌': 'xcirc',
    '📝': 'note', '🔎': 'search', '🔍': 'search', '🖨️': 'file', '🔗': 'share', '🔄': 'refresh', '🔁': 'refresh', '📑': 'copy',
    '➕': 'plus', '✏️': 'edit', '📄': 'file', '📇': 'user', '👤': 'user', '📁': 'file', '📂': 'file', '📷': 'camera', '💡': 'sparkle',
    '🔔': 'bell', '💾': 'save', '🎙️': 'mic', '🎤': 'mic', '🖼️': 'image', '🛠️': 'settings', '⚙️': 'settings', '💰': 'wallet',
    '💵': 'wallet', '📊': 'chart', '📈': 'trend', '🔒': 'lock', '🔓': 'unlock', '🗑️': 'trash', '👥': 'users', '⏰': 'clock',
    '🕐': 'clock', '⚠️': 'alert', '📌': 'pin', '📍': 'pin', '❤️': 'heart', '⛪': 'church', '🏛️': 'church', '📥': 'inbox',
    '📲': 'share', '📤': 'share', '⬇️': 'file', '🤝': 'users', '🏠': 'home', '🔐': 'lock', '📢': 'bell', '📞': 'user', '✉️': 'inbox', '📧': 'inbox', '🧭': 'pin', '🎯': 'flag', '🏁': 'flag', '🙋': 'user', '✨': 'sparkle', '📜': 'file', '🧾': 'file',
  };
  const RE_EMOJI = /^\s*(\p{Extended_Pictographic}️?)\s*/u;
  const SELECTOR_ICONOS = '#view-root h2, #view-root h3, #view-root h4, #view-root button, #view-root .wg-card-title, #view-root .home-card-t, #modal-root h3, #modal-root button, #modal-root .field > label';
  function cambiarEmojis(raiz) {
    raiz.querySelectorAll(SELECTOR_ICONOS).forEach((el) => {
      if (el.dataset.ico) return;
      el.dataset.ico = '1';
      const n = [...el.childNodes].find((c) => c.nodeType === 3 ? c.textContent.trim() : true);
      if (!n || n.nodeType !== 3) return;
      const m = RE_EMOJI.exec(n.textContent);
      if (!m) return;
      const nombre = EMOJI_ICONO[m[1]] || EMOJI_ICONO[m[1].replace('️', '')];
      if (!nombre) return;
      const resto = n.textContent.slice(m[0].length);
      if (!resto.trim()) return; // botón que es solo un emoji (✅ suelto): se deja igual
      n.textContent = resto;
      const s = document.createElement('span');
      s.className = 'ico-auto'; s.innerHTML = ic(nombre, 15);
      el.insertBefore(s, n);
    });
  }

  // ================= Horas rápidas =================
  const CLAVE_HORAS = 'horas_usadas_v1';
  const leerHoras = () => { try { return JSON.parse(localStorage.getItem(CLAVE_HORAS) || '{}') || {}; } catch (x) { return {}; } };
  function horasSugeridas() {
    const base = ['19:00', '19:30', '20:00'];
    const usadas = Object.entries(leerHoras()).sort((a, b) => b[1] - a[1]).map(([h]) => h).filter((h) => !base.includes(h)).slice(0, 2);
    return [...base, ...usadas].sort();
  }
  function ponerHorasRapidas(raiz) {
    raiz.querySelectorAll('form input[type=time][name=startTime]').forEach((inp) => {
      if (inp.dataset.horas) return;
      inp.dataset.horas = '1';
      const caja = document.createElement('div');
      caja.className = 'horas-rapidas';
      const pintar = () => {
        caja.innerHTML = horasSugeridas().map((h) => `<button type="button" data-h="${h}" class="${inp.value === h ? 'activa' : ''}">${h}</button>`).join('');
      };
      pintar();
      caja.addEventListener('click', (x) => {
        const b = x.target.closest('[data-h]');
        if (!b) return;
        inp.value = b.dataset.h;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        vibrar(10);
      });
      inp.addEventListener('change', () => {
        if (inp.value) { const u = leerHoras(); u[inp.value] = (u[inp.value] || 0) + 1; try { localStorage.setItem(CLAVE_HORAS, JSON.stringify(u)); } catch (x) { /* nada */ } }
        caja.querySelectorAll('[data-h]').forEach((b) => b.classList.toggle('activa', b.dataset.h === inp.value));
      });
      inp.insertAdjacentElement('afterend', caja);
    });
  }

  // ================= Borrador automático del acta nueva =================
  const CLAVE_ACTA = () => `borrador_acta_${(() => { try { return state.user.id; } catch (x) { return ''; } })()}`;
  function borrarBorradorActa() { try { localStorage.removeItem(CLAVE_ACTA()); } catch (x) { /* nada */ } }
  function leerActa(form) {
    const campos = {};
    form.querySelectorAll('input, select, textarea').forEach((c) => {
      if (!c.name || c.closest('.commitment-row') || c.type === 'file' || c.type === 'hidden') return;
      campos[c.name] = c.type === 'checkbox' ? c.checked : c.value;
    });
    const temas = [...form.querySelectorAll('#mt-agenda .commitment-row')].map((r) => ({ t: r.querySelector('.ar-topic')?.value || '', p: r.querySelector('.ar-presenter')?.value || '' })).filter((x) => x.t.trim());
    const comp = [...form.querySelectorAll('#mt-commitments .commitment-row')].map((r) => ({ d: r.querySelector('.cr-desc')?.value || '', f: r.querySelector('.cr-due')?.value || '' })).filter((x) => x.d.trim());
    return { campos, temas, comp };
  }
  function vigilarActa(form) {
    if (form.dataset.autoguardado) return;
    form.dataset.autoguardado = '1';
    const pie = $('mt-save')?.parentElement;
    const ind = document.createElement('span');
    ind.className = 'borrador-ind';
    if (pie) pie.insertBefore(ind, pie.firstChild);
    let ultimo = 0;
    const tic = setInterval(() => {
      if (!form.isConnected) return clearInterval(tic);
      if (!ultimo) return;
      const s = Math.round((Date.now() - ultimo) / 1000);
      ind.textContent = s < 60 ? `Borrador guardado hace ${Math.max(1, s)} s` : `Borrador guardado hace ${Math.round(s / 60)} min`;
    }, 1000);
    // ¿Quedó uno a medias?
    let previo = null;
    try { previo = JSON.parse(localStorage.getItem(CLAVE_ACTA()) || 'null'); } catch (x) { previo = null; }
    if (previo && Date.now() - previo.t < 3 * 86400000 && (previo.temas.length || previo.comp.length || String(previo.campos.notes || previo.campos.title || '').trim())) {
      const caja = document.createElement('div');
      caja.className = 'hint-box borrador-aviso';
      const h = new Date(previo.t);
      caja.innerHTML = `${ic('note', 16)} Tienes un acta a medias${previo.campos.title ? `: <b>${e(previo.campos.title)}</b>` : ''} (${h.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })} ${String(h.getHours()).padStart(2, '0')}:${String(h.getMinutes()).padStart(2, '0')}). <span style="display:inline-flex;gap:6px;margin-left:4px"><button type="button" class="btn btn-primary btn-sm" data-b="seguir">Seguir</button><button type="button" class="btn btn-ghost btn-sm" data-b="no">Descartar</button></span>`;
      form.prepend(caja);
      caja.querySelector('[data-b=no]').addEventListener('click', () => { borrarBorradorActa(); caja.remove(); });
      caja.querySelector('[data-b=seguir]').addEventListener('click', () => {
        const c = previo.campos;
        for (const [n, v] of Object.entries(c)) {
          const el = form.querySelector(`[name="${n}"]`);
          if (!el) continue;
          if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const rellenar = (cont, boton, datos, fn) => {
          if (!datos.length || !$(cont) || !$(boton)) return;
          $(cont).querySelectorAll('.commitment-row').forEach((r) => { const campo = r.querySelector('input[type=text], textarea'); if (campo && !campo.value.trim()) r.remove(); });
          datos.forEach((d) => { $(boton).click(); const filas = $(cont).querySelectorAll('.commitment-row'); fn(filas[filas.length - 1], d); });
        };
        rellenar('mt-agenda', 'mt-add-agenda', previo.temas, (r, d) => { if (!r) return; r.querySelector('.ar-topic').value = d.t; r.querySelector('.ar-presenter').value = d.p; });
        rellenar('mt-commitments', 'mt-add-commitment', previo.comp, (r, d) => { if (!r) return; r.querySelector('.cr-desc').value = d.d; if (d.f) r.querySelector('.cr-due').value = d.f; });
        caja.remove();
        if (previo.comp.length) toast('Recuperado. Revisa los responsables de cada compromiso.');
      });
    }
    let t = null;
    const guardar = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (!form.isConnected) return;
        try { localStorage.setItem(CLAVE_ACTA(), JSON.stringify({ t: Date.now(), ...leerActa(form) })); ultimo = Date.now(); } catch (x) { /* nada */ }
      }, 800);
    };
    form.addEventListener('input', guardar);
    form.addEventListener('change', guardar);
  }

  // ================= Arrastrar para ordenar =================
  window.ordenarArrastrando = function (cont, filaSel, asaSel) {
    if (!cont || cont.dataset.ordenable) return;
    cont.dataset.ordenable = '1';
    cont.addEventListener('pointerdown', (x) => {
      const asa = x.target.closest(asaSel);
      if (!asa || !cont.contains(asa)) return;
      const fila = asa.closest(filaSel);
      if (!fila) return;
      x.preventDefault();
      fila.classList.add('ordenando');
      vibrar(10);
      const mover = (m) => {
        const hermanos = [...cont.querySelectorAll(filaSel)].filter((f) => f !== fila);
        const despues = hermanos.find((f) => { const r = f.getBoundingClientRect(); return m.clientY < r.top + r.height / 2; });
        if (despues) { if (despues.previousElementSibling !== fila) cont.insertBefore(fila, despues); }
        else if (hermanos.length && fila !== hermanos[hermanos.length - 1].nextElementSibling) hermanos[hermanos.length - 1].after(fila);
      };
      const soltar = () => {
        fila.classList.remove('ordenando');
        document.removeEventListener('pointermove', mover);
        document.removeEventListener('pointerup', soltar);
        document.removeEventListener('pointercancel', soltar);
        cont.dispatchEvent(new Event('change', { bubbles: true }));
      };
      document.addEventListener('pointermove', mover);
      document.addEventListener('pointerup', soltar);
      document.addEventListener('pointercancel', soltar);
    });
  };

  // ================= Tirar para actualizar =================
  (function () {
    let y0 = null; let tirando = false; let ind = null;
    const VISTAS = ['home', 'calendar', 'meetings'];
    const hayVentana = () => !!document.querySelector('#modal-root .modal-backdrop, #chat-window.open, .menu-lp, #afiche-root > *, #prep-root > *, #escucha-root > *');
    const marca = () => { if (!ind) { ind = document.createElement('div'); ind.className = 'ptr'; ind.innerHTML = ic('refresh', 18); document.body.appendChild(ind); } return ind; };
    document.addEventListener('touchstart', (x) => {
      if (!conSesion() || !VISTAS.includes(state.view) || window.scrollY > 0 || hayVentana() || x.touches.length !== 1) { y0 = null; return; }
      if (x.target.closest('input, textarea, select, .cal-grid, .wk-grid, [draggable=true]')) { y0 = null; return; }
      y0 = x.touches[0].clientY; tirando = false;
    }, { passive: true });
    document.addEventListener('touchmove', (x) => {
      if (y0 === null) return;
      const d = x.touches[0].clientY - y0;
      if (d <= 0 || window.scrollY > 0) return;
      tirando = d > 75;
      const m = marca();
      m.style.transition = 'none';
      m.style.transform = `translate(-50%, ${Math.min(d * 0.5, 70) - 48}px) rotate(${d * 2}deg)`;
    }, { passive: true });
    document.addEventListener('touchend', async () => {
      if (y0 === null) return;
      y0 = null;
      if (!ind) return;
      ind.style.transition = '';
      if (!tirando) { ind.style.transform = 'translate(-50%, -48px)'; return; }
      ind.style.transform = 'translate(-50%, 20px)';
      ind.classList.add('girando');
      vibrar(10);
      try {
        if (state.view === 'calendar' && typeof loadCalendarData === 'function') await loadCalendarData();
        await Promise.resolve(renderCurrentView());
      } catch (x) { /* nada */ }
      setTimeout(() => { if (ind) { ind.classList.remove('girando'); ind.style.transform = 'translate(-50%, -48px)'; } }, 500);
    });
  })();

  // ================= Mantener presionado: menú rápido =================
  function cerrarMenu() { document.querySelectorAll('.menu-lp, .menu-lp-fondo').forEach((x) => x.remove()); }
  function abrirMenu(titulo, opciones, px, py) {
    cerrarMenu();
    const fondo = document.createElement('div'); fondo.className = 'menu-lp-fondo';
    const m = document.createElement('div'); m.className = 'menu-lp'; m.setAttribute('role', 'menu');
    m.innerHTML = `<div class="menu-lp-t">${e(titulo)}</div>${opciones.map((o, i) => `<button type="button" role="menuitem" data-i="${i}" class="${o.peligro ? 'peligro' : ''}">${ic(o.i, 17)}<span>${e(o.n)}</span></button>`).join('')}`;
    document.body.append(fondo, m);
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.max(8, Math.min(px - r.width / 2, window.innerWidth - r.width - 8))}px`;
    m.style.top = `${Math.max(8, Math.min(py + 8, window.innerHeight - r.height - 8))}px`;
    fondo.addEventListener('click', cerrarMenu);
    m.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => { cerrarMenu(); opciones[Number(b.dataset.i)].f(); }));
    vibrar(25);
  }
  const fechaTxt = (ev) => { try { return `${fmtDateHuman(ev.date)}${ev.startTime ? ` a las ${fmtTime(ev.startTime)}` : ''}`; } catch (x) { return ev.date; } };
  function opcionesEvento(ev) {
    const op = [{ n: 'Abrir', i: 'file', f: () => openItemModal(ev, 'event') }];
    let puede = false;
    try { puede = canEditEventsFor(ev.organizationId); } catch (x) { puede = false; }
    if (puede) op.push({ n: 'Duplicar', i: 'copy', f: () => openEventModal(ev, { duplicate: true }) });
    op.push({ n: 'Compartir', i: 'share', f: async () => {
      const lugar = (() => { try { return locationDisplay(ev); } catch (x) { return ev.location || ''; } })();
      const texto = `${ev.title}\n${fechaTxt(ev)}${lugar ? `\n${lugar}` : ''}`;
      if (navigator.share) { try { await navigator.share({ text: texto }); return; } catch (x) { if (x.name === 'AbortError') return; } }
      window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, '_blank', 'noopener');
    } });
    if (typeof window.abrirAfiche === 'function' && !ev.isMeeting) op.push({ n: 'Hacer afiche', i: 'image', f: () => window.abrirAfiche(ev) });
    if (puede) op.push({ n: 'Eliminar', i: 'trash', peligro: true, f: async () => {
      if (!(await confirmModal(`¿Eliminar "${ev.title}"?`, { title: 'Eliminar actividad', confirmText: 'Eliminar', danger: true }))) return;
      try { await api(`/events/${ev.id}`, { method: 'DELETE' }); toast('Actividad eliminada'); await refreshAfterEventChange(); } catch (x) { toast(x.message, 'error'); }
    } });
    return op;
  }
  function menuPara(el) {
    if (el.matches('.cal-event[data-kind="event"]')) {
      const ev = (state.events || []).find((x) => x.id === Number(el.dataset.id));
      return ev ? [ev.title, opcionesEvento(ev)] : null;
    }
    if (el.matches('.home-item[data-tipo="actividad"]')) {
      const ev = (state.events || []).find((x) => x.id === Number(el.dataset.id));
      return ev ? [ev.title, opcionesEvento(ev)] : null;
    }
    if (el.matches('.home-item[data-tipo="compromiso"]')) {
      const id = Number(el.dataset.id);
      const titulo = el.querySelector('.home-item-t')?.textContent || 'Compromiso';
      return [titulo, [
        { n: 'Marcar como hecho', i: 'check', f: async () => { try { await api(`/commitments/${id}/complete`, { method: 'PUT', body: { comment: '' } }); toast('Compromiso cumplido'); renderCurrentView(); } catch (x) { toast(x.message, 'error'); } } },
        { n: 'Ver en Reuniones', i: 'clipboard', f: () => el.click() },
      ]];
    }
    if (el.matches('.pend-item')) {
      const cb = el.querySelector('[data-pend]'); const x = el.querySelector('[data-pend-x]');
      const titulo = el.querySelector('.pend-t')?.textContent || 'Pendiente';
      return [titulo, [
        cb && !cb.checked ? { n: 'Marcar como hecho', i: 'check', f: () => cb.click() } : null,
        cb && cb.checked ? { n: 'Volver a pendiente', i: 'refresh', f: () => cb.click() } : null,
        { n: 'Copiar texto', i: 'copy', f: () => { try { navigator.clipboard.writeText(titulo); toast('Copiado'); } catch (y) { /* nada */ } } },
        x ? { n: 'Quitar', i: 'trash', peligro: true, f: () => x.click() } : null,
      ].filter(Boolean)];
    }
    return null;
  }
  (function () {
    const SEL = '.cal-event[data-kind="event"], .home-item[data-tipo="actividad"], .home-item[data-tipo="compromiso"], .pend-item';
    let timer = null; let inicio = null; let disparado = null;
    document.addEventListener('pointerdown', (x) => {
      if (x.pointerType === 'mouse' && x.button !== 0) return;
      const el = x.target.closest && x.target.closest(SEL);
      if (!el || !conSesion()) return;
      inicio = { x: x.clientX, y: x.clientY }; disparado = null;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const r = menuPara(el);
        if (!r) return;
        disparado = el;
        abrirMenu(r[0], r[1], inicio.x, inicio.y);
      }, 520);
    }, true);
    const cancelar = (x) => { if (inicio && x && x.type === 'pointermove' && Math.hypot(x.clientX - inicio.x, x.clientY - inicio.y) < 10) return; clearTimeout(timer); };
    document.addEventListener('pointermove', cancelar, true);
    document.addEventListener('pointerup', () => { clearTimeout(timer); if (disparado) setTimeout(() => { disparado = null; }, 450); }, true);
    document.addEventListener('pointercancel', () => clearTimeout(timer), true);
    document.addEventListener('scroll', () => clearTimeout(timer), true);
    // El clic que sigue al "mantener presionado" no debe abrir lo de siempre.
    document.addEventListener('click', (x) => { if (disparado && disparado.contains(x.target)) { disparado = null; x.preventDefault(); x.stopPropagation(); } }, true);
    document.addEventListener('contextmenu', (x) => { if (x.target.closest && x.target.closest(SEL)) x.preventDefault(); });
    document.addEventListener('keydown', (x) => { if (x.key === 'Escape') cerrarMenu(); });
  })();

  // ================= Observador =================
  const revisar = () => {
    if (!conSesion()) return;
    cambiarEmojis(document);
    ponerHorasRapidas(document);
    const mt = $('mt-form');
    if (mt) vigilarActa(mt);
  };
  let pend = null;
  new MutationObserver(() => { if (!pend) pend = setTimeout(() => { pend = null; revisar(); }, 50); }).observe(document.body, { childList: true, subtree: true });
  revisar();
})();
