// ----------------------------------------------------------------------
// "DESERET ESCUCHA LA REUNIÓN" (cliente)
// ----------------------------------------------------------------------
// Graba la reunión en el navegador y cada 5 minutos sube un trozo de audio
// al servidor, que lo transcribe y guarda SOLO el texto (ver
// server/src/routes/escucha.js). Al terminar, Deseret arma el borrador del
// acta (temas, acuerdos y compromisos) y la persona lo revisa antes de
// guardarlo.
//   - En sala: se graba el micrófono (celular al centro de la mesa).
//   - Reunión online (computador): micrófono + el audio de la pestaña o
//     pantalla de Meet/Zoom/Teams, así se escucha también a los demás.
// Uso: window.abrirEscuchaReunion({ onGuardado }) — lo llaman el botón de
// Reuniones y Consejos y Deseret ("escucha la reunión").
// ----------------------------------------------------------------------
(function () {
  const TROZO_MS = 5 * 60 * 1000;
  let st = null; // sesión en curso
  let onGuardadoCb = null;

  const token = () => { try { return localStorage.getItem('cow_token'); } catch { return null; } };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const aviso = (msg, tipo = 'success') => { if (typeof window.toast === 'function') window.toast(msg, tipo); };
  async function api(path, { method = 'GET', body, form } = {}) {
    const headers = token() ? { Authorization: `Bearer ${token()}` } : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(`/api${path}`, { method, headers, body: form || (body !== undefined ? JSON.stringify(body) : undefined) });
    let j = null; try { j = await r.json(); } catch { /* sin cuerpo */ }
    if (!r.ok) throw new Error(j?.error || `Error ${r.status}`);
    return j;
  }
  const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const hhmmss = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}:${mmss(s % 3600)}` : mmss(s));

  // ---------------- Estilos ----------------
  function estilos() {
    if (document.getElementById('escucha-estilos')) return;
    const css = document.createElement('style');
    css.id = 'escucha-estilos';
    css.textContent = `
      #escucha-root .modal { max-width: 640px; }
      .esc-fuentes { display: grid; gap: 8px; margin: 6px 0 12px; }
      .esc-fuente { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--border, #e2e8f0); border-radius: 12px; padding: 10px 12px; cursor: pointer; }
      .esc-fuente input { margin-top: 3px; }
      .esc-fuente.activa { border-color: var(--celeste, #0ea5e9); background: rgba(14,165,233,.07); }
      .esc-tips { font-size: 13px; line-height: 1.5; margin: 0; padding-left: 18px; }
      .esc-grabando { text-align: center; padding: 8px 0 4px; }
      .esc-reloj { font-size: 40px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: 1px; }
      .esc-punto { display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: #ef4444; margin-right: 8px; vertical-align: middle; animation: esc-lat 1.4s infinite; }
      .esc-punto.pausa { background: #f59e0b; animation: none; }
      @keyframes esc-lat { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
      .esc-nivel { height: 8px; background: var(--border, #e2e8f0); border-radius: 99px; overflow: hidden; margin: 12px auto 6px; max-width: 320px; }
      .esc-nivel > div { height: 100%; width: 0; background: linear-gradient(90deg, #22c55e, #eab308); transition: width .12s linear; }
      .esc-estado { font-size: 13px; color: var(--ink-soft, #64748b); }
      .esc-ultimo { font-size: 13px; background: var(--bg-soft, #f8fafc); border-radius: 10px; padding: 8px 10px; margin-top: 10px; text-align: left; max-height: 90px; overflow: auto; color: var(--ink-soft, #475569); }
      .esc-botones { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-top: 14px; }
      .esc-item { border: 1px solid var(--border, #e2e8f0); border-radius: 12px; padding: 10px; margin-bottom: 8px; display: grid; gap: 6px; position: relative; }
      .esc-item input, .esc-item textarea, .esc-item select { width: 100%; box-sizing: border-box; font: inherit; font-size: 14px; padding: 8px 10px; border: 1px solid var(--border, #cbd5e1); border-radius: 8px; background: var(--white, #fff); color: inherit; }
      .esc-item input[data-k="tema"], .esc-item input[data-k="descripcion"] { font-weight: 600; padding-right: 30px; }
      .esc-item textarea { min-height: 54px; resize: vertical; }
      .esc-quitar { position: absolute; top: 6px; right: 6px; border: 0; background: transparent; font-size: 18px; cursor: pointer; color: var(--ink-soft, #64748b); }
      .esc-comp { display: grid; grid-template-columns: 1fr; gap: 6px; }
      .esc-comp-fila { display: grid; grid-template-columns: 1fr 150px; gap: 6px; }
      @media (max-width: 520px) { .esc-comp-fila { grid-template-columns: 1fr; } }
      .esc-dicho { font-size: 12px; color: #b45309; }
      .esc-sec { font-size: 14px; font-weight: 700; margin: 14px 0 6px; }
      #escucha-pill { position: fixed; left: 50%; transform: translateX(-50%); bottom: 16px; z-index: 1200; background: #0f172a; color: #fff; border: 0; border-radius: 999px; padding: 9px 16px; font-size: 14px; box-shadow: 0 6px 20px rgba(0,0,0,.25); cursor: pointer; display: flex; align-items: center; white-space: nowrap; }
      @media (max-width: 640px) { #escucha-pill { bottom: calc(84px + env(safe-area-inset-bottom, 0px)); } }
    `;
    document.head.appendChild(css);
  }

  function raiz() {
    let r = document.getElementById('escucha-root');
    if (!r) { r = document.createElement('div'); r.id = 'escucha-root'; document.body.appendChild(r); }
    return r;
  }
  function cerrarModal() { raiz().innerHTML = ''; pintarPastilla(); }
  function modal(titulo, cuerpo, pie) {
    raiz().innerHTML = `
      <div class="modal-backdrop" id="esc-backdrop">
        <div class="modal" role="dialog" aria-labelledby="esc-titulo">
          <div class="modal-header"><h3 id="esc-titulo">${titulo}</h3><button class="modal-close" id="esc-cerrar" aria-label="Cerrar">×</button></div>
          <div class="modal-body">${cuerpo}</div>
          ${pie ? `<div class="modal-footer">${pie}</div>` : ''}
        </div>
      </div>`;
    document.getElementById('esc-cerrar').addEventListener('click', cerrarModal);
    pintarPastilla();
  }

  // Pastilla flotante mientras se graba con el panel cerrado.
  function pintarPastilla() {
    let p = document.getElementById('escucha-pill');
    const mostrar = st && st.grabando && !document.getElementById('esc-backdrop');
    if (!mostrar) { if (p) p.remove(); return; }
    if (!p) {
      p = document.createElement('button');
      p.id = 'escucha-pill'; p.type = 'button';
      p.addEventListener('click', () => pantallaGrabando());
      document.body.appendChild(p);
    }
    p.innerHTML = `<span class="esc-punto ${st.pausado ? 'pausa' : ''}"></span>Deseret ${st.pausado ? 'en pausa' : 'escuchando'} · ${hhmmss(st.segundos)}`;
  }

  // ---------------- 1. Inicio ----------------
  async function pantallaInicio() {
    estilos();
    let estado = null;
    try { estado = await api('/escucha/estado'); } catch (e) { aviso(e.message, 'error'); return; }
    if (!estado.disponible) {
      modal('🎙️ Deseret escucha la reunión', '<p>La transcripción todavía no está configurada en el servidor (falta <b>GROQ_API_KEY</b> o <b>GEMINI_API_KEY</b>). Pídele al Administrador que la configure.</p>');
      return;
    }
    const puedeOnline = !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad/i.test(navigator.userAgent);
    modal('🎙️ Deseret escucha la reunión', `
      <p style="margin-top:0">Deseret escucha la reunión, la transcribe y al final te propone el <b>acta</b> con los temas, acuerdos y compromisos. <b>Tú la revisas antes de guardarla.</b> El audio no se guarda: solo el texto, y se borra al guardar el acta.</p>
      <div class="field"><label for="esc-tit">Nombre de la reunión (opcional)</label><input id="esc-tit" type="text" maxlength="100" placeholder="Ej. Reunión de presidencia del Cuórum" /></div>
      <label style="font-weight:600">¿Dónde es la reunión?</label>
      <div class="esc-fuentes">
        <label class="esc-fuente activa"><input type="radio" name="esc-fuente" value="sala" checked /><span><b>🏠 En una sala</b><br><small>Graba el micrófono. Deja el celular al centro de la mesa y conectado a la corriente.</small></span></label>
        ${puedeOnline ? `<label class="esc-fuente"><input type="radio" name="esc-fuente" value="online" /><span><b>💻 Reunión online (Meet, Zoom, Teams)</b><br><small>Graba tu micrófono <b>y</b> el audio de la reunión. Al empezar, elige la pestaña o pantalla de la reunión y marca <b>"Compartir audio"</b>.</small></span></label>` : ''}
      </div>
      <ul class="esc-tips">
        <li>Al cerrar cada tema, di el compromiso en voz alta: <i>"Compromiso: hermano Pérez visita a los Soto antes del domingo"</i>. Así Deseret lo capta casi siempre.</li>
        <li>Usa <b>Pausa</b> en los temas confidenciales. No grabes entrevistas ni temas de dignidad.</li>
        <li>Mantén la app abierta y la pantalla encendida.</li>
      </ul>
      <label class="a11y-op" style="margin-top:12px"><input type="checkbox" id="esc-ok" /> <span>Avisé a los presentes que Deseret tomará notas de la reunión.</span></label>`,
    '<button class="btn btn-secondary" id="esc-no">Cancelar</button><button class="btn btn-primary" id="esc-empezar" disabled>🎙️ Empezar a escuchar</button>');
    document.getElementById('esc-no').addEventListener('click', cerrarModal);
    const ok = document.getElementById('esc-ok'); const btn = document.getElementById('esc-empezar');
    ok.addEventListener('change', () => { btn.disabled = !ok.checked; });
    raiz().querySelectorAll('.esc-fuente input').forEach((r) => r.addEventListener('change', () => {
      raiz().querySelectorAll('.esc-fuente').forEach((l) => l.classList.toggle('activa', l.querySelector('input').checked));
    }));
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Preparando…';
      const fuente = raiz().querySelector('.esc-fuente input:checked')?.value || 'sala';
      try { await empezar(fuente, document.getElementById('esc-tit').value.trim()); } catch (e) {
        aviso(e.message || 'No se pudo empezar', 'error');
        btn.disabled = false; btn.textContent = '🎙️ Empezar a escuchar';
      }
    });
  }

  // ---------------- 2. Grabación ----------------
  function tipoAudio() {
    const tipos = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    return tipos.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported?.(t)) || '';
  }

  async function empezar(fuente, titulo) {
    if (!window.MediaRecorder) throw new Error('Este navegador no permite grabar audio. Prueba con Chrome.');
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .catch(() => { throw new Error('No tengo permiso para usar el micrófono.'); });
    let pantalla = null;
    if (fuente === 'online') {
      try { pantalla = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); } catch {
        mic.getTracks().forEach((t) => t.stop());
        throw new Error('No se compartió la pestaña de la reunión.');
      }
      if (!pantalla.getAudioTracks().length) {
        pantalla.getTracks().forEach((t) => t.stop()); mic.getTracks().forEach((t) => t.stop());
        throw new Error('No marcaste "Compartir audio". Vuelve a empezar y activa esa opción al elegir la pestaña.');
      }
    }
    // Todo pasa por un AudioContext: mezcla micrófono + reunión y mide el nivel.
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const destino = ctx.createMediaStreamDestination();
    const analizador = ctx.createAnalyser(); analizador.fftSize = 1024;
    ctx.createMediaStreamSource(mic).connect(destino);
    if (pantalla) ctx.createMediaStreamSource(new MediaStream(pantalla.getAudioTracks())).connect(destino);
    ctx.createMediaStreamSource(destino.stream).connect(analizador);

    const { id } = await api('/escucha', { method: 'POST', body: { fuente, titulo } });
    st = {
      id, fuente, titulo, mic, pantalla, ctx, destino, analizador, mime: tipoAudio(),
      grabando: true, pausado: false, segundos: 0, segundosTrozo: 0, n: 0,
      cola: [], subiendo: false, listos: 0, ultimoTexto: '', errores: 0, recorder: null, wake: null,
    };
    if (pantalla) pantalla.getVideoTracks()[0]?.addEventListener('ended', () => { if (st?.grabando) aviso('Se dejó de compartir la pestaña: sigo escuchando solo tu micrófono.', 'error'); });
    await pedirPantallaEncendida();
    nuevoTrozo();
    st.reloj = setInterval(tic, 1000);
    st.medidor = setInterval(medirNivel, 120);
    window.addEventListener('beforeunload', antesDeSalir);
    document.addEventListener('visibilitychange', alVolver);
    pantallaGrabando();
  }

  function nuevoTrozo() {
    const rec = new MediaRecorder(st.destino.stream, { ...(st.mime ? { mimeType: st.mime } : {}), audioBitsPerSecond: 32000 });
    const partes = [];
    const n = st.n++;
    rec.ondataavailable = (e) => { if (e.data && e.data.size) partes.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(partes, { type: rec.mimeType || st?.mime || 'audio/webm' });
      if (blob.size > 1000 && st) { st.cola.push({ n, blob, intentos: 0 }); subirCola(); }
    };
    rec.start(10000);
    st.recorder = rec;
    st.segundosTrozo = 0;
  }

  function tic() {
    if (!st || !st.grabando || st.pausado) return;
    st.segundos += 1; st.segundosTrozo += 1;
    if (st.segundosTrozo * 1000 >= TROZO_MS) { const r = st.recorder; nuevoTrozo(); r.stop(); }
    const reloj = document.getElementById('esc-reloj'); if (reloj) reloj.textContent = hhmmss(st.segundos);
    pintarPastilla();
  }

  function medirNivel() {
    const barra = document.getElementById('esc-nivel');
    if (!st || !barra) return;
    const buf = new Float32Array(st.analizador.fftSize);
    st.analizador.getFloatTimeDomainData(buf);
    let suma = 0; for (let i = 0; i < buf.length; i++) suma += buf[i] * buf[i];
    const rms = Math.sqrt(suma / buf.length);
    barra.style.width = `${st.pausado ? 0 : Math.min(100, Math.round(rms * 400))}%`;
  }

  async function subirCola() {
    if (!st || st.subiendo) return;
    const item = st.cola[0];
    if (!item) { pintarEstado(); return; }
    st.subiendo = true; pintarEstado();
    try {
      const fd = new FormData();
      const ext = /mp4/.test(item.blob.type) ? 'm4a' : /ogg/.test(item.blob.type) ? 'ogg' : 'webm';
      fd.append('n', String(item.n));
      fd.append('audio', item.blob, `trozo-${item.n}.${ext}`);
      const r = await api(`/escucha/${st.id}/trozo`, { method: 'POST', form: fd });
      st.cola.shift(); st.listos += 1; st.errores = 0;
      if (r.texto) st.ultimoTexto = r.texto;
      st.subiendo = false;
      pintarEstado();
      subirCola();
    } catch (e) {
      item.intentos += 1; st.errores += 1; st.subiendo = false;
      pintarEstado(`No se pudo enviar un trozo (${e.message}). Reintento en unos segundos…`);
      // Sin internet o servidor ocupado: se reintenta; el audio sigue guardado aquí.
      setTimeout(subirCola, Math.min(60000, 5000 * item.intentos));
    }
  }

  function pintarEstado(extra) {
    const el = document.getElementById('esc-estado');
    if (!el || !st) return;
    const pend = st.cola.length;
    el.innerHTML = `${st.listos} trozo${st.listos === 1 ? '' : 's'} transcrito${st.listos === 1 ? '' : 's'}${pend ? ` · ${pend} por enviar${st.subiendo ? ' (enviando…)' : ''}` : ''} · se envía cada 5 minutos${extra ? `<br><span style="color:#b45309">${esc(extra)}</span>` : ''}`;
    const ult = document.getElementById('esc-ultimo');
    if (ult && st.ultimoTexto) { ult.style.display = ''; ult.textContent = `Lo último que entendí: «${st.ultimoTexto.slice(-220)}»`; }
  }

  function pantallaGrabando() {
    if (!st) return;
    estilos();
    modal('🎙️ Deseret está escuchando', `
      <div class="esc-grabando">
        <div><span class="esc-punto ${st.pausado ? 'pausa' : ''}" id="esc-punto"></span><span id="esc-modo">${st.pausado ? 'En pausa' : 'Escuchando'}</span> · ${st.fuente === 'online' ? 'reunión online' : 'en sala'}</div>
        <div class="esc-reloj" id="esc-reloj">${hhmmss(st.segundos)}</div>
        <div class="esc-nivel"><div id="esc-nivel"></div></div>
        <div class="esc-estado" id="esc-estado"></div>
        <div class="esc-ultimo" id="esc-ultimo" style="display:none"></div>
        <div class="esc-botones">
          <button class="btn btn-secondary" id="esc-pausa">${st.pausado ? '▶️ Reanudar' : '⏸️ Pausa'}</button>
          <button class="btn btn-primary" id="esc-fin">✅ Terminar y armar el acta</button>
        </div>
        <p class="esc-estado" style="margin-top:12px">Puedes cerrar esta ventana y seguir usando la app: sigo escuchando (verás un aviso abajo). <a href="#" id="esc-descartar">Descartar todo</a></p>
      </div>`);
    pintarEstado();
    document.getElementById('esc-pausa').addEventListener('click', () => {
      if (!st) return;
      st.pausado = !st.pausado;
      if (st.pausado) st.recorder?.pause?.(); else st.recorder?.resume?.();
      pantallaGrabando();
    });
    document.getElementById('esc-fin').addEventListener('click', terminar);
    document.getElementById('esc-descartar').addEventListener('click', (e) => { e.preventDefault(); descartar(); });
  }

  async function pedirPantallaEncendida() {
    try { if ('wakeLock' in navigator && st) st.wake = await navigator.wakeLock.request('screen'); } catch { /* no disponible */ }
  }
  function alVolver() { if (st?.grabando && document.visibilityState === 'visible') pedirPantallaEncendida(); }
  function antesDeSalir(e) { if (st?.grabando || st?.cola?.length) { e.preventDefault(); e.returnValue = ''; } }

  function soltarTodo() {
    if (!st) return;
    clearInterval(st.reloj); clearInterval(st.medidor);
    st.mic?.getTracks().forEach((t) => t.stop());
    st.pantalla?.getTracks().forEach((t) => t.stop());
    st.ctx?.close().catch(() => {});
    st.wake?.release?.().catch(() => {});
    window.removeEventListener('beforeunload', antesDeSalir);
    document.removeEventListener('visibilitychange', alVolver);
  }

  async function descartar() {
    if (!st) return;
    if (!window.confirm('¿Descartar la grabación y todo lo transcrito? No se guardará nada.')) return;
    const id = st.id;
    st.grabando = false;
    try { st.recorder?.state !== 'inactive' && st.recorder?.stop(); } catch { /* ya detenido */ }
    st.cola = [];
    soltarTodo();
    st = null;
    cerrarModal();
    api(`/escucha/${id}`, { method: 'DELETE' }).catch(() => {});
    aviso('Grabación descartada.');
  }

  async function terminar() {
    if (!st) return;
    st.grabando = false;
    try { if (st.recorder && st.recorder.state !== 'inactive') st.recorder.stop(); } catch { /* ya detenido */ }
    soltarTodo();
    modal('🧠 Armando el acta…', '<div class="esc-grabando"><div class="deseret-typing"><span></span><span></span><span></span></div><p class="esc-estado" id="esc-estado"></p><p class="esc-estado" id="esc-paso">Enviando lo último que escuché…</p></div>');
    pintarEstado();
    // Esperar a que se envíen todos los trozos (con reintentos).
    const inicio = Date.now();
    await new Promise((r) => setTimeout(r, 400));
    while (st && (st.cola.length || st.subiendo)) {
      if (Date.now() - inicio > 5 * 60 * 1000) break;
      await new Promise((r) => setTimeout(r, 700));
      pintarEstado();
    }
    if (!st) return;
    if (st.cola.length) {
      modal('⚠️ Faltan trozos por enviar', `<p>No pude enviar ${st.cola.length} trozo(s) de audio (¿sin internet?). Puedes reintentar, o armar el acta con lo que ya se transcribió.</p>`,
        '<button class="btn btn-secondary" id="esc-seguir">Armar con lo que hay</button><button class="btn btn-primary" id="esc-reint">Reintentar</button>');
      document.getElementById('esc-reint').addEventListener('click', () => { subirCola(); terminar(); });
      document.getElementById('esc-seguir').addEventListener('click', () => { st.cola = []; terminar(); });
      return;
    }
    const paso = document.getElementById('esc-paso'); if (paso) paso.textContent = 'Ordenando temas, acuerdos y compromisos…';
    try {
      const r = await api(`/escucha/${st.id}/terminar`, { method: 'POST', body: {} });
      pantallaRevision(r);
    } catch (e) {
      modal('No pude armar el acta', `<p>${esc(e.message)}</p>`, '<button class="btn btn-secondary" id="esc-desc2">Descartar</button><button class="btn btn-primary" id="esc-otra">Intentar de nuevo</button>');
      document.getElementById('esc-otra').addEventListener('click', terminar);
      document.getElementById('esc-desc2').addEventListener('click', descartar);
    }
  }

  // ---------------- 3. Revisión ----------------
  function pantallaRevision({ acta, asignables, transcripcion, tipos }) {
    const TIPOS = { general: 'Reunión general / de presidencia', consejo_barrio: 'Consejo de barrio', coordinacion_ministracion: 'Coordinación de ministración' };
    const b = { ...acta, temas: acta.temas.map((t) => ({ ...t })), compromisos: acta.compromisos.map((c) => ({ ...c, incluir: true })) };
    const opcionesResp = (sel) => asignables.map((u) => `<option value="${u.id}" ${Number(sel) === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
    const pintar = () => {
      modal('📋 Revisa el acta antes de guardarla', `
        <div class="field"><label>Nombre</label><input id="esc-r-tit" type="text" maxlength="100" value="${esc(b.titulo)}" /></div>
        <div class="esc-comp-fila">
          <div class="field"><label>Tipo</label><select id="esc-r-tipo">${tipos.map((t) => `<option value="${t}" ${b.tipo === t ? 'selected' : ''}>${TIPOS[t]}</option>`).join('')}</select></div>
          <div class="field"><label>Fecha</label><input id="esc-r-fecha" type="date" value="${esc(b.fecha)}" /></div>
        </div>
        <label class="a11y-op"><input type="checkbox" id="esc-r-conf" ${b.confidencial ? 'checked' : ''} /> <span>Acta confidencial (solo la ven quien la crea y el Obispado)</span></label>
        <div class="esc-sec">Temas (${b.temas.length})</div>
        ${b.temas.map((t, i) => `
          <div class="esc-item" data-tema="${i}">
            <button class="esc-quitar" data-quitar-tema="${i}" aria-label="Quitar tema">×</button>
            <input type="text" data-k="tema" value="${esc(t.tema)}" placeholder="Tema" />
            <textarea data-k="notas" placeholder="De qué se habló">${esc(t.notas)}</textarea>
            <textarea data-k="acuerdo" placeholder="Acuerdo (opcional)">${esc(t.acuerdo)}</textarea>
          </div>`).join('')}
        <button class="btn btn-secondary btn-sm" id="esc-mas-tema">+ Agregar tema</button>
        <div class="esc-sec">Compromisos (${b.compromisos.length})</div>
        ${b.compromisos.length ? '' : '<p class="esc-estado">No detecté compromisos. Puedes agregarlos aquí.</p>'}
        ${b.compromisos.map((c, i) => `
          <div class="esc-item esc-comp" data-comp="${i}">
            <button class="esc-quitar" data-quitar-comp="${i}" aria-label="Quitar compromiso">×</button>
            <input type="text" data-k="descripcion" value="${esc(c.descripcion)}" placeholder="Qué hará" />
            <div class="esc-comp-fila">
              <select data-k="userId">${opcionesResp(c.userId)}</select>
              <input type="date" data-k="fecha" value="${esc(c.fecha)}" />
            </div>
            ${!c.nombre && c.dicho ? `<div class="esc-dicho">Se dijo «${esc(c.dicho)}», pero no lo encontré: elige a la persona.</div>` : ''}
            ${c.sinFecha ? '<div class="esc-dicho">No se dijo fecha: puse una semana. Ajústala si hace falta.</div>' : ''}
          </div>`).join('')}
        <button class="btn btn-secondary btn-sm" id="esc-mas-comp">+ Agregar compromiso</button>
        <details style="margin-top:14px"><summary>Ver lo que transcribí</summary><textarea readonly style="width:100%; min-height:160px; margin-top:6px">${esc(transcripcion)}</textarea></details>`,
      '<button class="btn btn-secondary" id="esc-r-desc">Descartar</button><button class="btn btn-primary" id="esc-r-guardar">💾 Guardar acta</button>');
      const leer = () => {
        b.titulo = document.getElementById('esc-r-tit').value; b.tipo = document.getElementById('esc-r-tipo').value;
        b.fecha = document.getElementById('esc-r-fecha').value; b.confidencial = document.getElementById('esc-r-conf').checked;
        raiz().querySelectorAll('[data-tema]').forEach((el) => { const t = b.temas[Number(el.dataset.tema)]; el.querySelectorAll('[data-k]').forEach((x) => { t[x.dataset.k] = x.value; }); });
        raiz().querySelectorAll('[data-comp]').forEach((el) => { const c = b.compromisos[Number(el.dataset.comp)]; el.querySelectorAll('[data-k]').forEach((x) => { c[x.dataset.k] = x.value; }); });
      };
      raiz().querySelectorAll('[data-quitar-tema]').forEach((x) => x.addEventListener('click', () => { leer(); b.temas.splice(Number(x.dataset.quitarTema), 1); pintar(); }));
      raiz().querySelectorAll('[data-quitar-comp]').forEach((x) => x.addEventListener('click', () => { leer(); b.compromisos.splice(Number(x.dataset.quitarComp), 1); pintar(); }));
      document.getElementById('esc-mas-tema').addEventListener('click', () => { leer(); b.temas.push({ tema: '', notas: '', acuerdo: '' }); pintar(); });
      document.getElementById('esc-mas-comp').addEventListener('click', () => {
        leer();
        const en7 = new Date(Date.now() + 7 * 86400000).toLocaleDateString('en-CA');
        b.compromisos.push({ descripcion: '', userId: asignables[0]?.id, fecha: en7, nombre: 'ok' }); pintar();
      });
      document.getElementById('esc-r-desc').addEventListener('click', descartar);
      document.getElementById('esc-r-guardar').addEventListener('click', async (ev) => {
        leer();
        const btn = ev.currentTarget; btn.disabled = true; btn.textContent = 'Guardando…';
        try {
          const r = await api(`/escucha/${st.id}/guardar`, { method: 'POST', body: { acta: { ...b, compromisos: b.compromisos.filter((c) => String(c.descripcion).trim()) } } });
          st = null;
          cerrarModal();
          aviso(`Acta guardada: ${r.temas} tema(s) y ${r.compromisos} compromiso(s).`);
          if (typeof onGuardadoCb === 'function') onGuardadoCb(r);
        } catch (e) { aviso(e.message, 'error'); btn.disabled = false; btn.textContent = '💾 Guardar acta'; }
      });
    };
    pintar();
  }

  window.abrirEscuchaReunion = function abrirEscuchaReunion(opciones = {}) {
    if (opciones.onGuardado) onGuardadoCb = opciones.onGuardado;
    if (st) { pantallaGrabando(); return; }
    pantallaInicio();
  };
  window.escuchaEnCurso = () => !!(st && st.grabando);
}());
