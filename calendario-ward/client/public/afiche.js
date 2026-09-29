// ----------------------------------------------------------------------
// GENERADOR DE AFICHES — "Crear afiche" en cada actividad y con Deseret
// ("hazme un afiche para la noche de hogar").
// ----------------------------------------------------------------------
// Dos pantallas, con lo justo a la vista y el resto a un toque:
//   1) Crear: la idea (ya viene sugerida según el tipo de actividad), para
//      quién y qué ambiente. "Más opciones" guarda estilo, qué aparece,
//      formato, datos y QR.
//   2) Resultado: el afiche grande, versiones, y tres pestañas (Imagen /
//      Texto / Formato) para retocar. Abajo: Compartir y Descargar; el menú
//      "⋯" tiene Adjuntar a la actividad, Galería y Empezar de nuevo.
// La IA pinta solo la ilustración (servidor: routes/afiches.js); el texto
// y el QR los dibuja la app en un <canvas>, así salen sin faltas.
// ----------------------------------------------------------------------
(function () {
  const $ = (id) => document.getElementById(id);
  const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = () => { try { return state.token; } catch (x) { return localStorage.getItem('cow_token'); } };
  const aviso = (m, t) => { try { toast(m, t); } catch (x) { console.log(m); } };
  async function pedir(ruta, opts = {}) {
    const headers = { ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token() ? { Authorization: `Bearer ${token()}` } : {}) };
    // Tope de 100 s: si algo se queda pegado, se avisa en vez de girar para siempre.
    let r;
    try {
      r = await fetch('/api' + ruta, { method: opts.method || (opts.json !== undefined || opts.form ? 'POST' : 'GET'), headers, body: opts.form || (opts.json !== undefined ? JSON.stringify(opts.json) : undefined), signal: AbortSignal.timeout ? AbortSignal.timeout(100_000) : undefined });
    } catch (x) {
      throw new Error(x && x.name === 'TimeoutError' ? 'El servidor tardó demasiado. Inténtalo de nuevo en un momento.' : 'Sin conexión con el servidor. Revisa tu internet e inténtalo de nuevo.');
    }
    if (opts.blob && r.ok) return r.blob();
    let j = null; try { j = await r.json(); } catch (x) { /* sin cuerpo */ }
    if (!r.ok) throw new Error((j && j.error) || `Error ${r.status}`);
    return j;
  }

  const IC = {
    pincel: '<path d="M9.06 11.9 17 4a2.12 2.12 0 0 1 3 3l-7.94 7.94"/><path d="M7 14c-1.66 0-3 1.34-3 3 0 1.31-1 2-2 2 1 1.5 2.5 2 4 2 2.21 0 4-1.79 4-4 0-1.66-1.34-3-3-3z"/>',
    bajar: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    compartir: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
    galeria: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    chispa: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
    mas: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  };
  const ico = (n, t = 16) => `<svg width="${t}" height="${t}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px;flex-shrink:0">${IC[n]}</svg>`;

  // ---------------- estilos ----------------
  const css = `
  #afiche-root .modal-backdrop { z-index: 1050; }
  #afiche-root .modal { max-width: 540px; }
  #afiche-root .btn { gap: 6px; }
  #afiche-root .modal-header h3 { font-weight: 650; letter-spacing: -.01em; }
  .af-act { display:flex; gap:10px; align-items:center; padding:10px 12px; border:1px solid var(--border); border-radius:12px; background:var(--celeste-lighter); margin-bottom:14px; }
  .af-act b { display:block; font-size:14px; } .af-act small { color:var(--ink-soft); font-size:12.5px; }
  .af-dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
  .af-lbl { font-size:13px; font-weight:600; margin:0 0 6px; display:flex; justify-content:space-between; align-items:baseline; gap:8px; }
  .af-lbl button { background:none; border:0; padding:0; font:inherit; font-weight:500; font-size:12.5px; color:var(--celeste-dark); cursor:pointer; white-space:nowrap; }
  .af-in, #afiche-root textarea, #afiche-root select { width:100%; border:1px solid var(--border); border-radius:10px; padding:10px 12px; font:inherit; font-size:14px; background:var(--white); color:var(--ink); }
  #afiche-root textarea { min-height:78px; line-height:1.4; resize:vertical; }
  .af-chips { display:flex; flex-wrap:wrap; gap:6px; margin:4px 0 12px; }
  .af-chips.scroll { flex-wrap:nowrap; overflow-x:auto; padding-bottom:4px; scrollbar-width:none; }
  .af-chip { border:1px solid var(--border); background:var(--white); color:var(--ink); border-radius:999px; padding:6px 12px; font:inherit; font-size:13px; cursor:pointer; white-space:nowrap; flex-shrink:0; }
  .af-chip.on { background:var(--celeste-dark); border-color:var(--celeste-dark); color:#fff; }
  .af-fila { display:grid; grid-template-columns: 1fr 1fr; gap:10px; }
  .af-mas { border:1px solid var(--border); border-radius:12px; margin-top:2px; }
  .af-mas > summary { list-style:none; cursor:pointer; padding:11px 12px; display:flex; align-items:center; gap:8px; font-size:13.5px; font-weight:600; }
  .af-mas > summary::-webkit-details-marker { display:none; }
  .af-mas > summary small { flex:1; font-weight:400; color:var(--ink-soft); font-size:12.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:right; }
  .af-mas > summary::after { content:'›'; font-size:18px; color:var(--ink-soft); transition: transform .15s; }
  .af-mas[open] > summary::after { transform: rotate(90deg); }
  .af-mas > div { padding:0 12px 12px; }
  .af-fmt { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin:4px 0 12px; }
  .af-fmt button { border:1px solid var(--border); background:var(--white); border-radius:10px; padding:8px 4px; font:inherit; font-size:12px; color:var(--ink-soft); cursor:pointer; }
  .af-fmt button.on { border:2px solid var(--celeste-dark); color:var(--ink); font-weight:600; }
  .af-fmt i { display:block; margin:0 auto 4px; border:2px solid currentColor; border-radius:3px; opacity:.7; }
  .af-sw { display:flex; align-items:center; gap:10px; padding:9px 0; font-size:13.5px; cursor:pointer; }
  .af-sw span { flex:1; } .af-sw small { display:block; color:var(--ink-soft); font-size:12px; }
  .af-sw input { display:none; }
  .af-tog { width:38px; height:22px; border-radius:999px; background:#cbd5e1; position:relative; flex-shrink:0; transition: background .15s; }
  .af-tog::after { content:''; position:absolute; left:3px; top:3px; width:16px; height:16px; border-radius:50%; background:#fff; transition: left .15s; }
  .af-sw input:checked + .af-tog { background:var(--celeste-dark); }
  .af-sw input:checked + .af-tog::after { left:19px; }
  .af-nota { font-size:12px; color:var(--ink-soft); margin-top:10px; display:flex; align-items:center; gap:6px; }
  .af-nota i { width:7px; height:7px; border-radius:50%; background:#22c55e; }
  .af-lienzo { position:relative; display:flex; justify-content:center; }
  .af-lienzo canvas { max-width:100%; max-height:min(52vh, 500px); width:auto; height:auto; border-radius:12px; box-shadow:0 10px 28px rgba(15,23,42,.22); background:#e2e8f0; }
  .af-pintando { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; background:rgba(255,255,255,.72); border-radius:12px; font-weight:600; font-size:14px; color:#0f172a; }
  .af-pintando small { font-weight:400; color:#475569; }
  .af-spin { width:30px; height:30px; border-radius:50%; border:3px solid #bae6fd; border-top-color:#0369a1; animation: af-giro .8s linear infinite; }
  @keyframes af-giro { to { transform: rotate(360deg); } }
  .af-vers { display:flex; gap:8px; justify-content:center; margin:12px 0 4px; flex-wrap:wrap; }
  .af-vers button { width:42px; height:56px; border-radius:7px; border:2px solid transparent; padding:0; background:#e2e8f0 center/cover; cursor:pointer; opacity:.6; }
  .af-vers button.on { border-color:var(--celeste-dark); opacity:1; }
  .af-vers .af-otra { opacity:1; border:1.5px dashed var(--border); background:var(--white); color:var(--celeste-dark); font-size:11px; line-height:1.2; }
  .af-tabs { display:flex; gap:4px; background:var(--celeste-lighter); border-radius:10px; padding:3px; margin:12px 0 10px; }
  .af-tabs button { flex:1; border:0; background:none; border-radius:8px; padding:7px 4px; font:inherit; font-size:13px; color:var(--ink-soft); cursor:pointer; }
  .af-tabs button.on { background:var(--white); color:var(--ink); font-weight:600; box-shadow:0 1px 3px rgba(15,23,42,.12); }
  .af-panel { min-height:60px; }
  .af-panel .af-in { margin-bottom:8px; padding:8px 10px; font-size:13.5px; }
  .af-pie { display:flex; gap:8px; padding:12px 20px 20px; align-items:center; position:sticky; bottom:0; background:var(--white); border-top:1px solid var(--border); z-index:3; }
  .af-pie .btn { justify-content:center; }
  .af-wa { background:#16a34a !important; border-color:#16a34a !important; color:#fff !important; flex:1; }
  .af-menu-wrap { position:relative; }
  .af-menu { position:absolute; bottom:calc(100% + 6px); left:0; min-width:230px; background:var(--white); border:1px solid var(--border); border-radius:12px; box-shadow:var(--shadow-lg); padding:6px; z-index:2; }
  .af-menu button { display:block; width:100%; text-align:left; border:0; background:none; padding:10px 12px; border-radius:8px; font:inherit; font-size:14px; color:var(--ink); cursor:pointer; }
  .af-menu button:hover { background:var(--celeste-lighter); }
  .af-gal { display:grid; grid-template-columns:repeat(auto-fill, minmax(96px, 1fr)); gap:10px; }
  .af-gal button { border:0; padding:0; background:none; text-align:left; cursor:pointer; font:inherit; color:var(--ink); }
  .af-gal span { display:block; aspect-ratio:3/4; border-radius:10px; background:#e2e8f0 center/cover; }
  .af-gal small { display:block; font-size:11.5px; margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .af-ver img { display:block; max-width:100%; max-height:62vh; margin:0 auto; border-radius:12px; box-shadow:0 10px 28px rgba(15,23,42,.22); }
  `;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // ---------------- plantillas según el tipo de actividad ----------------
  const PLANTILLAS = [
    { re: /noche de hogar|hogar/, idea: 'Una familia reunida en el living de su casa, conversando y riendo alrededor de una mesa con once, luz cálida de lámpara', publico: 'familias', ambiente: 'tranquilo', estilo: 'acuarela', lema: '¡Trae a tu familia!' },
    { re: /servicio|limpieza|ayuda|voluntari|minga/, idea: 'Un grupo de personas trabajando juntas con guantes y herramientas en un jardín comunitario soleado, sonriendo', publico: 'todos', ambiente: 'alegre', estilo: 'moderno', lema: 'Sirvamos juntos' },
    { re: /deport|futbol|fútbol|baby|basquet|básquet|voleibol|partido|olimpiada|campeonato|cicletada|corrida/, idea: 'Jóvenes jugando un partido en una cancha al atardecer, movimiento y energía, pelota en el aire', publico: 'jovenes', ambiente: 'festivo', estilo: 'moderno', lema: '¡Ven a jugar!' },
    { re: /bautism/, idea: 'Agua tranquila y cristalina con suave luz del sol, una paloma blanca volando, flores blancas en primer plano', publico: 'todos', ambiente: 'reverente', estilo: 'acuarela', lema: 'Te invitamos a este día especial' },
    { re: /navidad|pesebre|villancico/, idea: 'Una noche estrellada de Navidad con luces cálidas, una estrella brillante en el cielo y un pueblo pequeño iluminado', publico: 'familias', ambiente: 'festivo', estilo: 'acuarela', lema: '¡Celebremos juntos!' },
    { re: /campamento|campa|excursi|paseo/, idea: 'Carpas junto a un lago rodeado de cerros y árboles, fogata encendida y cielo estrellado', publico: 'jovenes', ambiente: 'alegre', estilo: 'acuarela', lema: '¡Nos vamos de campamento!' },
    { re: /primaria|niñ|infantil/, idea: 'Niños sonriendo y jugando en un prado lleno de flores y mariposas, día soleado', publico: 'ninos', ambiente: 'alegre', estilo: 'infantil', lema: '¡Te esperamos!' },
    { re: /mujeres j[oó]venes|hombres j[oó]venes|j[oó]venes|juventud|mutual/, idea: 'Un grupo de jóvenes amigos riendo juntos al aire libre, luz dorada de atardecer', publico: 'jovenes', ambiente: 'alegre', estilo: 'realista', lema: '¡No faltes!' },
    { re: /sociedad de socorro|hermanas/, idea: 'Mujeres de distintas edades compartiendo té y conversando en un jardín con flores, ambiente acogedor', publico: 'adultos', ambiente: 'tranquilo', estilo: 'acuarela', lema: 'Te esperamos, hermana' },
    { re: /historia familiar|genealog|antepasad/, idea: 'Fotografías antiguas, un árbol genealógico dibujado y cartas sobre una mesa de madera, luz de ventana', publico: 'todos', ambiente: 'tranquilo', estilo: 'elegante', lema: 'Descubre tu historia' },
    { re: /templo/, idea: 'Un grupo de personas vestidas con ropa formal viajando juntas en bus al amanecer, rostros alegres, paisaje de cerros', publico: 'todos', ambiente: 'reverente', estilo: 'realista', lema: 'Viajemos juntos' },
    { re: /misional|mision|misioner/, idea: 'Dos jóvenes con camisa blanca y mochila caminando por una calle de barrio chileno, saludando a vecinos, día soleado', publico: 'todos', ambiente: 'alegre', estilo: 'moderno', lema: '¡Invita a un amigo!' },
    { re: /taller|charla|clase|capacitaci|devocional|conferencia/, idea: 'Personas sentadas en círculo conversando con libros y tazas de té, sala luminosa y acogedora', publico: 'adultos', ambiente: 'tranquilo', estilo: 'moderno', lema: 'Te esperamos' },
    { re: /fiesta|aniversario|celebra|kermesse|once|convivencia|cena|almuerzo|asado|fonda|dieciocho|18/, idea: 'Mesas largas con comida, guirnaldas de luces y familias celebrando al aire libre al atardecer', publico: 'familias', ambiente: 'festivo', estilo: 'acuarela', lema: '¡Ven a celebrar!' },
  ];
  const plantillaDe = (t) => { const n = String(t || '').toLowerCase(); return PLANTILLAS.find((p) => p.re.test(n)) || { idea: '', publico: 'todos', ambiente: 'alegre', estilo: 'auto', lema: '¡Te esperamos!' }; };

  const PUBLICO = [['todos', 'Todos'], ['ninos', 'Niños'], ['jovenes', 'Jóvenes'], ['adultos', 'Adultos'], ['familias', 'Familias']];
  const AMBIENTE = [['alegre', 'Alegre'], ['reverente', 'Reverente'], ['festivo', 'Festivo'], ['tranquilo', 'Tranquilo']];
  const APARECE = [['', 'Lo que calce'], ['personas', 'Personas'], ['paisaje', 'Paisaje'], ['objetos', 'Objetos'], ['sinpersonas', 'Sin personas']];
  const ESTILOS = [['auto', 'Automático'], ['acuarela', 'Acuarela'], ['realista', 'Realista'], ['moderno', 'Moderno'], ['infantil', 'Infantil'], ['elegante', 'Elegante'], ['animado', 'Dibujo animado'], ['libre', 'Escribir mi estilo…']];
  const FORMATOS = { historia: { w: 1080, h: 1920, n: 'Historia / WhatsApp', i: 'width:13px;height:22px' }, cuadrado: { w: 1080, h: 1080, n: 'Cuadrado', i: 'width:19px;height:19px' }, carta: { w: 1275, h: 1650, n: 'Hoja carta', i: 'width:16px;height:21px' } };
  const RETOQUES = [['otra', 'Otra versión'], ['colorido', 'Más colorido'], ['sobrio', 'Más sobrio'], ['luz', 'Más luz'], ['sinpersonas', 'Sin personas'], ['fondo', 'Otro fondo'], ['idea', 'Cambiar la idea']];
  const nombre = (lista, k) => (lista.find((x) => x[0] === k) || [k, k])[1];

  const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  function fechaLarga(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); if (!m) return '';
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    const s = `${DIAS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ---------------- estado de la sesión ----------------
  let S = null;
  let estado = null; // { disponible, puedeCrear, quedanHoy }
  async function cargarEstado() {
    try { estado = await pedir('/afiches/estado'); } catch (x) { estado = estado || { disponible: false, puedeCrear: false, quedanHoy: 0 }; }
    return estado;
  }
  function nuevaSesion(ev) {
    const p = plantillaDe(`${ev.titulo} ${ev.descripcion || ''} ${ev.org || ''}`);
    return {
      ev,
      opts: { idea: p.idea, publico: p.publico, ambiente: p.ambiente, aparece: '', estilo: p.estilo, estiloLibre: '', formato: 'historia' },
      textos: { org: ev.org ? `${ev.org}` : '', titulo: ev.titulo || '', lema: p.lema, fecha: fechaLarga(ev.fecha), lugar: [ev.hora ? `${ev.hora} hrs` : '', ev.lugar || ''].filter(Boolean).join('  ·  ') },
      diseno: 'arriba', datos: true, qr: false, qrUrl: location.origin,
      versiones: [], actual: -1, tab: 'imagen', pintando: false,
    };
  }
  function evDesdeEvento(it) {
    let lugar = it.location || '';
    try { lugar = locationDisplay(it) || lugar; } catch (x) { /* nada */ }
    return { id: it.id, titulo: it.title || '', fecha: it.date || '', hora: (it.startTime || '').slice(0, 5), lugar, org: it.organizationName || '', color: it.organizationColor || '#8b5cf6', descripcion: it.description || it.purpose || '', posterId: it.posterId || null, organizationId: it.organizationId };
  }
  const puedeAdjuntar = () => { try { return !!(S.ev.id && canEditEventsFor(S.ev.organizationId)); } catch (x) { return false; } };

  // ---------------- raíz del modal ----------------
  function raiz() {
    let r = $('afiche-root');
    if (!r) { r = document.createElement('div'); r.id = 'afiche-root'; document.body.appendChild(r); }
    return r;
  }
  function cerrar() { raiz().innerHTML = ''; }
  function modal(titulo, cuerpo, pie) {
    raiz().innerHTML = `<div class="modal-backdrop" id="af-fondo"><div class="modal" role="dialog" aria-label="${e(titulo)}">
      <div class="modal-header"><h3>${titulo}</h3><button class="modal-close" id="af-cerrar" aria-label="Cerrar">×</button></div>
      <div class="modal-body">${cuerpo}</div>${pie || ''}</div></div>`;
    $('af-cerrar').addEventListener('click', cerrar);
    $('af-fondo').addEventListener('click', (x) => { if (x.target.id === 'af-fondo') cerrar(); });
  }
  const chips = (lista, sel, grupo, extra = '') => `<div class="af-chips ${extra}">${lista.map(([k, n]) => `<button type="button" class="af-chip ${sel === k ? 'on' : ''}" data-g="${grupo}" data-k="${k}">${e(n)}</button>`).join('')}</div>`;
  const tarjetaAct = (ev) => `<div class="af-act"><span class="af-dot" style="background:${e(ev.color || '#8b5cf6')}"></span><div><b>${e(ev.titulo || 'Afiche')}</b><small>${e([fechaLarga(ev.fecha), ev.hora, ev.lugar, ev.org].filter(Boolean).join(' · '))}</small></div></div>`;

  // ---------------- pantalla 1: crear ----------------
  function resumenMas() {
    const o = S.opts;
    return [o.estilo === 'libre' ? (o.estiloLibre || 'Mi estilo') : nombre(ESTILOS, o.estilo), FORMATOS[o.formato].n, S.datos ? 'con datos' : 'solo imagen', S.qr ? 'QR' : ''].filter(Boolean).join(' · ');
  }
  function pantallaCrear() {
    const o = S.opts;
    const sinAct = !S.ev.id && !S.ev.titulo;
    modal('Crear afiche', `
      ${S.ev.id || S.ev.titulo ? tarjetaAct(S.ev) : ''}
      ${S.eleccion ? `<p class="af-lbl">¿Para qué actividad?</p><select id="af-elige" style="margin-bottom:14px"><option value="">— Elige una actividad —</option>${S.eleccion.map((x) => `<option value="${x.id}" ${S.ev.id === x.id ? 'selected' : ''}>${e(x.title)} · ${e(fechaLarga(x.date))}</option>`).join('')}<option value="otra">Otra (escribir el título)</option></select>` : ''}
      ${(sinAct && !S.eleccion) || S.ev.libre ? `<p class="af-lbl">Título del afiche</p><input class="af-in" id="af-tit" maxlength="80" placeholder="Ej: Noche de talentos" value="${e(S.ev.titulo || '')}" style="margin-bottom:14px" />` : ''}
      <p class="af-lbl">¿Cómo lo imaginas? <button type="button" id="af-sugerir">${ico('chispa', 14)} Sugerir otra idea</button></p>
      <textarea id="af-idea" maxlength="500" placeholder="Descríbelo con tus palabras. Ej: niños jugando en un parque al atardecer">${e(o.idea)}</textarea>
      <div class="af-fila" style="margin-top:12px">
        <div><p class="af-lbl">Para</p><select id="af-publico">${PUBLICO.map(([k, n]) => `<option value="${k}" ${o.publico === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div><p class="af-lbl">Ambiente</p><select id="af-ambiente">${AMBIENTE.map(([k, n]) => `<option value="${k}" ${o.ambiente === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      </div>
      <details class="af-mas" id="af-mas" style="margin-top:14px"><summary>Más opciones <small id="af-resumen">${e(resumenMas())}</small></summary><div>
        <p class="af-lbl" style="margin-top:4px">Estilo</p>${chips(ESTILOS, o.estilo, 'estilo')}
        <div id="af-libre-box" style="${o.estilo === 'libre' ? '' : 'display:none'};margin:-4px 0 12px"><input class="af-in" id="af-libre" maxlength="200" placeholder="Ej: realista como fotografía de cine, óleo, vitral, cómic…" value="${e(o.estiloLibre)}" /></div>
        <p class="af-lbl">Qué debe aparecer</p>${chips(APARECE, o.aparece, 'aparece')}
        <p class="af-lbl">Formato</p><div class="af-fmt">${Object.entries(FORMATOS).map(([k, f]) => `<button type="button" data-fmt="${k}" class="${o.formato === k ? 'on' : ''}"><i style="${f.i}"></i>${f.n}</button>`).join('')}</div>
        <label class="af-sw"><span>Poner los datos de la actividad<small>Título, fecha y lugar escritos por la app, sin faltas</small></span><input type="checkbox" id="af-datos" ${S.datos ? 'checked' : ''}/><i class="af-tog"></i></label>
        <label class="af-sw"><span>Agregar código QR<small>Para abrir la app o un enlace que elijas</small></span><input type="checkbox" id="af-qr" ${S.qr ? 'checked' : ''}/><i class="af-tog"></i></label>
      </div></details>
      <div class="af-nota"><i></i><span id="af-cupo">${estado && estado.disponible ? `Gratis · quedan ${estado.quedanHoy} afiches hoy en el barrio` : 'Gratis'}</span></div>`,
    `<div class="af-pie"><button class="btn btn-ghost" id="af-galeria">${ico('galeria')} Galería</button><span style="flex:1"></span><button class="btn btn-primary" id="af-crear">${ico('pincel')} Crear afiche</button></div>`);

    const leer = () => {
      o.idea = $('af-idea').value.trim();
      o.publico = $('af-publico').value; o.ambiente = $('af-ambiente').value;
      if ($('af-libre')) o.estiloLibre = $('af-libre').value.trim();
      if ($('af-tit')) { S.ev.titulo = $('af-tit').value.trim(); S.textos.titulo = S.ev.titulo; }
      S.datos = $('af-datos').checked; S.qr = $('af-qr').checked;
      $('af-resumen').textContent = resumenMas();
    };
    // Dictado por voz en la idea (el mismo micrófono de los demás campos de la app).
    try { if ((window.SpeechRecognition || window.webkitSpeechRecognition) && typeof wireDictation === 'function') wireDictation($('af-idea')); } catch (x) { /* sin dictado */ }
    raiz().querySelectorAll('.af-chip').forEach((b) => b.addEventListener('click', () => {
      o[b.dataset.g] = b.dataset.k;
      b.parentElement.querySelectorAll('.af-chip').forEach((x) => x.classList.toggle('on', x === b));
      if (b.dataset.g === 'estilo') { $('af-libre-box').style.display = b.dataset.k === 'libre' ? '' : 'none'; if (b.dataset.k === 'libre') $('af-libre').focus(); }
      leer();
    }));
    raiz().querySelectorAll('[data-fmt]').forEach((b) => b.addEventListener('click', () => { o.formato = b.dataset.fmt; raiz().querySelectorAll('[data-fmt]').forEach((x) => x.classList.toggle('on', x === b)); leer(); }));
    ['af-datos', 'af-qr', 'af-libre', 'af-publico', 'af-ambiente'].forEach((id) => $(id)?.addEventListener('change', leer));
    $('af-elige')?.addEventListener('change', (x) => {
      const v = x.target.value;
      if (v === 'otra') { S.ev = { titulo: '', libre: true }; S.eleccion = null; }
      else if (v) { const it = S.eleccion.find((y) => String(y.id) === v); const nuevo = nuevaSesion(evDesdeEvento(it)); nuevo.eleccion = S.eleccion; S = nuevo; }
      pantallaCrear();
    });
    $('af-sugerir').addEventListener('click', async () => {
      leer();
      const b = $('af-sugerir'); b.textContent = 'Pensando…'; b.disabled = true;
      try { const r = await pedir('/afiches/idea', { json: { titulo: S.ev.titulo, descripcion: S.ev.descripcion, anterior: o.idea } }); o.idea = r.idea; $('af-idea').value = r.idea; }
      catch (x) { aviso(x.message, 'error'); }
      b.innerHTML = `${ico('chispa', 14)} Sugerir otra idea`; b.disabled = false;
    });
    $('af-galeria').addEventListener('click', () => { leer(); abrirGaleria(); });
    $('af-crear').addEventListener('click', () => {
      leer();
      if (!S.ev.titulo && !o.idea) { aviso('Escribe un título o una idea para el afiche', 'error'); return; }
      if (o.estilo === 'libre' && !o.estiloLibre) { aviso('Escribe el estilo que quieres (o elige otro)', 'error'); $('af-mas').open = true; $('af-libre').focus(); return; }
      S.versiones = []; S.actual = -1;
      pantallaResultado();
      generar({});
    });
  }

  // ---------------- generar ----------------
  async function generar({ retoques = [], mismoPrompt = false, cantidad = 1 }) {
    if (S.pintando) return;
    S.pintando = true; pintarEstado();
    const o = S.opts;
    const base = S.versiones[S.actual];
    const cuerpo = {
      eventId: S.ev.id || null, titulo: S.ev.titulo, descripcion: S.ev.descripcion, organizacion: S.ev.org,
      idea: o.idea, publico: o.publico, ambiente: o.ambiente, aparece: o.aparece,
      estilo: o.estilo === 'auto' || o.estilo === 'libre' ? '' : o.estilo, estiloLibre: o.estilo === 'libre' ? o.estiloLibre : '',
      formato: o.formato, retoques, promptPrevio: base ? base.prompt : '', mismoPrompt,
    };
    try {
      const pedidos = Array.from({ length: cantidad }, () => pedir('/afiches/generar', { json: cuerpo }));
      const res = await Promise.allSettled(pedidos);
      let ok = 0; let error = null;
      for (const r of res) {
        if (r.status !== 'fulfilled') { error = r.reason; continue; }
        const a = r.value.afiche;
        if (estado) estado.quedanHoy = r.value.quedanHoy;
        const img = await cargarImagen(a.id);
        S.versiones.push({ id: a.id, prompt: a.prompt, img });
        S.actual = S.versiones.length - 1; ok += 1;
      }
      if (!ok && error) throw error;
      if (error) aviso(error.message, 'error');
    } catch (x) {
      aviso(x.message, 'error');
      if (!S.versiones.length) { S.pintando = false; pantallaCrear(); return; }
    }
    S.pintando = false;
    pintarEstado();
  }
  async function cargarImagen(id, final = false) {
    const blob = await pedir(`/afiches/${id}/imagen${final ? '?final=1' : ''}`, { blob: true });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((ok, mal) => { img.onload = ok; img.onerror = mal; img.src = url; });
    img.dataset.url = url;
    return img;
  }

  // ---------------- dibujo del afiche (canvas) ----------------
  let libQR = null;
  function cargarQR() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    if (libQR) return libQR;
    libQR = new Promise((ok) => { const sc = document.createElement('script'); sc.src = '/vendor/qrcode.js'; sc.onload = () => ok(window.qrcode); sc.onerror = () => ok(null); document.head.appendChild(sc); });
    return libQR;
  }
  function envolver(ctx, texto, ancho) {
    const palabras = String(texto || '').split(/\s+/).filter(Boolean); const lineas = []; let l = '';
    for (const p of palabras) { const t = l ? `${l} ${p}` : p; if (ctx.measureText(t).width > ancho && l) { lineas.push(l); l = p; } else l = t; }
    if (l) lineas.push(l);
    return lineas;
  }
  function rect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  async function dibujar(canvas, img, sesion) {
    const f = FORMATOS[sesion.opts.formato];
    const W = f.w; const H = f.h;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    // imagen "cover", centrada
    const esc2 = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    const iw = img.naturalWidth * esc2; const ih = img.naturalHeight * esc2;
    ctx.drawImage(img, (W - iw) / 2, (H - ih) / 2, iw, ih);
    if (!sesion.datos && !sesion.qr) return;
    const T = sesion.textos; const dis = sesion.diseno; const pad = W * 0.07;
    const grad = (y0, y1, a0, a1) => { const g = ctx.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, `rgba(10,8,30,${a0})`); g.addColorStop(1, `rgba(10,8,30,${a1})`); ctx.fillStyle = g; ctx.fillRect(0, Math.min(y0, y1), W, Math.abs(y1 - y0)); };
    if (sesion.datos) {
      if (dis === 'arriba') { grad(0, H * 0.42, 0.62, 0); grad(H * 0.72, H, 0, 0.6); }
      else if (dis === 'abajo') grad(H * 0.38, H, 0, 0.78);
      else { ctx.fillStyle = 'rgba(10,8,30,.38)'; ctx.fillRect(0, 0, W, H); }
    } else grad(H * 0.78, H, 0, 0.45);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = W * 0.012;
    const serif = 'Georgia, "Noto Serif", "Times New Roman", serif';
    const sans = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    // bloque de título
    const bloque = [];
    if (sesion.datos) {
      if (T.org) bloque.push({ t: T.org.toUpperCase(), font: `600 ${Math.round(W * 0.026)}px ${sans}`, esp: 0.18, gap: W * 0.03 });
      // título: el tamaño más grande que quepa en 3 líneas
      let tam = W * 0.12; let lineas;
      do { ctx.font = `700 ${Math.round(tam)}px ${serif}`; lineas = envolver(ctx, T.titulo, W - pad * 2); tam *= 0.93; } while ((lineas.length > 3 || lineas.some((l) => ctx.measureText(l).width > W - pad * 2)) && tam > W * 0.05);
      tam /= 0.93;
      lineas.forEach((l, i) => bloque.push({ t: l, font: `700 ${Math.round(tam)}px ${serif}`, alto: tam * 1.08, gap: i === lineas.length - 1 ? W * 0.025 : 0 }));
      if (T.lema) bloque.push({ t: T.lema, font: `italic ${Math.round(W * 0.042)}px ${serif}`, alto: W * 0.05, gap: 0 });
    }
    const altoDe = (b) => b.alto || parseFloat(/\d+px/.exec(b.font)[0]) * 1.2;
    const altoBloque = bloque.reduce((s, b) => s + altoDe(b) + (b.gap || 0), 0);
    // caja de datos (fecha / lugar) + QR
    const qrLado = sesion.qr ? W * 0.2 : 0;
    const hayCaja = sesion.datos && (T.fecha || T.lugar);
    const cajaAlto = hayCaja ? W * 0.155 : 0;
    const altoPie = Math.max(cajaAlto, qrLado ? qrLado + W * 0.045 : 0);
    let yPie = H - pad - altoPie;
    let y;
    if (dis === 'arriba' || !sesion.datos) y = H * 0.075;
    else if (dis === 'abajo') y = yPie - W * 0.05 - altoBloque;
    else y = (H - altoBloque - altoPie - W * 0.06) / 2;
    for (const b of bloque) {
      ctx.font = b.font;
      const h = altoDe(b);
      y += h * 0.82;
      if (b.esp) { ctx.save(); try { ctx.letterSpacing = `${Math.round(W * 0.026 * b.esp)}px`; } catch (x) { /* navegadores antiguos */ } ctx.fillText(b.t, W / 2, y); ctx.restore(); ctx.fillStyle = '#fff'; }
      else ctx.fillText(b.t, W / 2, y);
      y += h * 0.18 + (b.gap || 0);
    }
    if (dis === 'centro' && sesion.datos) yPie = y + W * 0.06;
    ctx.shadowBlur = 0;
    const cajaW = W - pad * 2 - (qrLado ? qrLado + W * 0.03 : 0);
    if (hayCaja) {
      const cy = yPie + (altoPie - cajaAlto) / 2;
      rect(ctx, pad, cy, cajaW, cajaAlto, W * 0.025);
      ctx.fillStyle = 'rgba(15,10,46,.58)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = W * 0.002; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
      const tx = pad + W * 0.04;
      ctx.font = `700 ${Math.round(W * 0.044)}px ${sans}`;
      ajustarTexto(ctx, T.fecha, tx, cy + cajaAlto * 0.44, cajaW - W * 0.08);
      ctx.font = `${Math.round(W * 0.036)}px ${sans}`; ctx.globalAlpha = 0.92;
      ajustarTexto(ctx, T.lugar, tx, cy + cajaAlto * 0.78, cajaW - W * 0.08);
      ctx.globalAlpha = 1; ctx.textAlign = 'center';
    }
    if (qrLado) {
      const qrcode = await cargarQR();
      if (qrcode) {
        const qx = W - pad - qrLado; const qy = yPie + (altoPie - qrLado - W * 0.045) / 2;
        rect(ctx, qx, qy, qrLado, qrLado + W * 0.045, W * 0.02); ctx.fillStyle = '#fff'; ctx.fill();
        const qr = qrcode(0, 'M'); qr.addData(sesion.qrUrl || location.origin); qr.make();
        const n = qr.getModuleCount(); const m = qrLado * 0.1; const cel = (qrLado - m * 2) / n;
        ctx.fillStyle = '#0f172a';
        for (let r = 0; r < n; r += 1) for (let c = 0; c < n; c += 1) if (qr.isDark(r, c)) ctx.fillRect(qx + m + c * cel, qy + m + r * cel, Math.ceil(cel), Math.ceil(cel));
        ctx.font = `600 ${Math.round(W * 0.022)}px ${sans}`; ctx.fillStyle = '#334155';
        ctx.fillText('Escanéame', qx + qrLado / 2, qy + qrLado + W * 0.028);
      }
    }
  }
  function ajustarTexto(ctx, t, x, y, max) {
    let s = String(t || '');
    // primero se achica la letra (hasta 70%); si aún no cabe, se corta con "…"
    const m = /(\d+(?:\.\d+)?)px/.exec(ctx.font);
    if (m) { let tam = parseFloat(m[1]); const min = tam * 0.7; while (ctx.measureText(s).width > max && tam > min) { tam *= 0.95; ctx.font = ctx.font.replace(/\d+(?:\.\d+)?px/, `${Math.round(tam)}px`); } }
    if (ctx.measureText(s).width > max) { while (s.length > 3 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1); s += '…'; }
    ctx.fillText(s, x, y);
  }

  // ---------------- pantalla 2: resultado ----------------
  function pantallaResultado() {
    modal('Tu afiche', `
      <div class="af-lienzo"><canvas id="af-canvas" width="1080" height="1920"></canvas><div class="af-pintando" id="af-pintando" style="display:none"><div class="af-spin"></div>Pintando tu afiche…<small>Suele tardar 5 a 15 segundos</small></div></div>
      <div class="af-vers" id="af-vers"></div>
      <div class="af-tabs" role="tablist">
        <button type="button" data-tab="imagen">Imagen</button><button type="button" data-tab="texto">Texto</button><button type="button" data-tab="formato">Formato</button>
      </div>
      <div class="af-panel" id="af-panel"></div>`,
    `<div class="af-pie">
       <div class="af-menu-wrap"><button class="btn btn-secondary" id="af-mas-btn" aria-label="Más acciones" title="Más acciones">${ico('mas', 18)}</button><div class="af-menu" id="af-menu" style="display:none"></div></div>
       <button class="btn btn-secondary" id="af-bajar">${ico('bajar')} Descargar</button>
       <button class="btn af-wa" id="af-compartir">${ico('compartir')} Compartir</button>
     </div>`);
    raiz().querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { S.tab = b.dataset.tab; pintarPanel(); }));
    $('af-bajar').addEventListener('click', descargar);
    $('af-compartir').addEventListener('click', compartir);
    $('af-mas-btn').addEventListener('click', (x) => { x.stopPropagation(); const m = $('af-menu'); m.style.display = m.style.display === 'none' ? '' : 'none'; if (m.style.display === '') pintarMenu(); });
    raiz().querySelector('.modal').addEventListener('click', (x) => { if (!x.target.closest('.af-menu-wrap')) { const m = $('af-menu'); if (m) m.style.display = 'none'; } });
    pintarPanel();
    pintarEstado();
  }
  function pintarMenu() {
    const items = [];
    if (puedeAdjuntar()) items.push(['adjuntar', S.ev.posterId ? 'Reemplazar el afiche de la actividad' : 'Adjuntar a la actividad']);
    items.push(['galeria', 'Galería del barrio'], ['empezar', 'Empezar de nuevo']);
    $('af-menu').innerHTML = items.map(([k, n]) => `<button type="button" data-m="${k}">${n}</button>`).join('');
    $('af-menu').querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => {
      $('af-menu').style.display = 'none';
      if (b.dataset.m === 'adjuntar') adjuntar();
      else if (b.dataset.m === 'galeria') abrirGaleria();
      else pantallaCrear();
    }));
  }
  async function pintarEstado() {
    if (!$('af-canvas')) return;
    $('af-pintando').style.display = S.pintando ? '' : 'none';
    ['af-bajar', 'af-compartir'].forEach((id) => { $(id).disabled = S.pintando || S.actual < 0; });
    const v = $('af-vers');
    v.innerHTML = S.versiones.map((x, i) => `<button type="button" class="${i === S.actual ? 'on' : ''}" data-v="${i}" style="background-image:url('${x.img.dataset.url}')" aria-label="Versión ${i + 1}"></button>`).join('')
      + (S.versiones.length && S.versiones.length < 8 ? `<button type="button" class="af-otra" id="af-mas2" ${S.pintando ? 'disabled' : ''}>+2<br>ideas</button>` : '');
    v.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => { S.actual = Number(b.dataset.v); pintarEstado(); }));
    $('af-mas2')?.addEventListener('click', () => generar({ mismoPrompt: true, cantidad: 2 }));
    if (S.actual >= 0) await dibujar($('af-canvas'), S.versiones[S.actual].img, S);
    else { const c = $('af-canvas'); const f = FORMATOS[S.opts.formato]; c.width = f.w; c.height = f.h; }
  }
  function pintarPanel() {
    raiz().querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
    const p = $('af-panel'); const T = S.textos;
    if (S.tab === 'imagen') {
      p.innerHTML = `<div class="af-chips scroll">${RETOQUES.map(([k, n]) => `<button type="button" class="af-chip" data-r="${k}">${n}</button>`).join('')}</div>
        <div class="af-nota" style="margin-top:4px"><i></i>${estado && estado.disponible ? `Gratis · quedan ${estado.quedanHoy} hoy en el barrio` : 'Gratis'}</div>`;
      p.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => {
        const k = b.dataset.r;
        if (k === 'idea') return pantallaCrear();
        if (k === 'otra') return generar({ mismoPrompt: true });
        generar({ retoques: [k] });
      }));
    } else if (S.tab === 'texto') {
      p.innerHTML = `
        <label class="af-sw" style="padding-top:0"><span>Mostrar los datos en el afiche</span><input type="checkbox" id="af-t-datos" ${S.datos ? 'checked' : ''}/><i class="af-tog"></i></label>
        <div id="af-t-campos" style="${S.datos ? '' : 'display:none'}">
          <input class="af-in" data-t="titulo" maxlength="80" placeholder="Título" value="${e(T.titulo)}" />
          <input class="af-in" data-t="lema" maxlength="80" placeholder="Frase (ej: ¡Trae a tu familia!)" value="${e(T.lema)}" />
          <div class="af-fila"><input class="af-in" data-t="fecha" maxlength="60" placeholder="Fecha" value="${e(T.fecha)}" /><input class="af-in" data-t="lugar" maxlength="80" placeholder="Hora y lugar" value="${e(T.lugar)}" /></div>
          <input class="af-in" data-t="org" maxlength="60" placeholder="Organización (arriba, pequeño)" value="${e(T.org)}" />
          <p class="af-lbl" style="margin-top:4px">Posición del texto</p>
          ${chips([['arriba', 'Arriba'], ['centro', 'Al centro'], ['abajo', 'Abajo']], S.diseno, 'diseno')}
        </div>
        <label class="af-sw"><span>Código QR<small>Lleva a la app o a un enlace que pegues</small></span><input type="checkbox" id="af-t-qr" ${S.qr ? 'checked' : ''}/><i class="af-tog"></i></label>
        <input class="af-in" id="af-t-qrurl" style="${S.qr ? '' : 'display:none'}" placeholder="https://…" value="${e(S.qrUrl)}" />`;
      let t = null;
      const redibujar = () => { clearTimeout(t); t = setTimeout(pintarEstado, 150); };
      p.querySelectorAll('[data-t]').forEach((i) => i.addEventListener('input', () => { T[i.dataset.t] = i.value; redibujar(); }));
      p.querySelectorAll('.af-chip[data-g="diseno"]').forEach((b) => b.addEventListener('click', () => { S.diseno = b.dataset.k; p.querySelectorAll('.af-chip[data-g="diseno"]').forEach((x) => x.classList.toggle('on', x === b)); pintarEstado(); }));
      $('af-t-datos').addEventListener('change', (x) => { S.datos = x.target.checked; $('af-t-campos').style.display = S.datos ? '' : 'none'; pintarEstado(); });
      $('af-t-qr').addEventListener('change', (x) => { S.qr = x.target.checked; $('af-t-qrurl').style.display = S.qr ? '' : 'none'; pintarEstado(); });
      $('af-t-qrurl').addEventListener('input', (x) => { S.qrUrl = x.target.value.trim() || location.origin; redibujar(); });
    } else {
      p.innerHTML = `<div class="af-fmt">${Object.entries(FORMATOS).map(([k, f]) => `<button type="button" data-fmt="${k}" class="${S.opts.formato === k ? 'on' : ''}"><i style="${f.i}"></i>${f.n}</button>`).join('')}</div>
        <div class="af-nota" style="margin-top:0">Cambiar el formato no gasta un afiche nuevo: se reacomoda la misma imagen.</div>`;
      p.querySelectorAll('[data-fmt]').forEach((b) => b.addEventListener('click', () => { S.opts.formato = b.dataset.fmt; pintarPanel(); pintarEstado(); }));
    }
  }

  // ---------------- compartir / descargar / adjuntar ----------------
  const nombreArchivo = () => `afiche-${String(S.textos.titulo || S.ev.titulo || 'actividad').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'actividad'}.jpg`;
  const blobFinal = () => new Promise((ok) => $('af-canvas').toBlob(ok, 'image/jpeg', 0.9));
  async function descargar() {
    const b = await blobFinal(); const url = URL.createObjectURL(b);
    const a = document.createElement('a'); a.href = url; a.download = nombreArchivo(); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    aviso('Afiche descargado');
  }
  async function compartir() {
    const b = await blobFinal();
    const file = new File([b], nombreArchivo(), { type: 'image/jpeg' });
    const texto = [S.textos.titulo, S.textos.fecha, S.textos.lugar].filter(Boolean).join(' · ');
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: S.textos.titulo || 'Afiche', text: texto }); return; } catch (x) { if (x.name === 'AbortError') return; }
    }
    await descargar();
    aviso('Tu equipo no permite compartir directo: quedó descargado para enviarlo por WhatsApp.');
  }
  async function adjuntar() {
    if (!S.ev.id || S.actual < 0) return;
    const b = await blobFinal();
    const fd = new FormData(); fd.append('eventId', String(S.ev.id)); fd.append('final', b, 'afiche.jpg');
    try {
      await pedir(`/afiches/${S.versiones[S.actual].id}/adjuntar`, { form: fd, method: 'POST' });
      S.ev.posterId = S.versiones[S.actual].id;
      try { const it = state.events.find((x) => x.id === S.ev.id); if (it) it.posterId = S.ev.posterId; } catch (x) { /* nada */ }
      aviso('Afiche adjuntado: todos lo verán en la actividad');
    } catch (x) { aviso(x.message, 'error'); }
  }

  // ---------------- galería ----------------
  async function abrirGaleria() {
    const volver = S ? (S.versiones.length ? pantallaResultado : pantallaCrear) : cerrar;
    modal('Galería del barrio', '<p class="af-nota" style="margin:0 0 12px">Toca un afiche para usarlo de base: mismo dibujo, y cambias el texto o el formato.</p><div class="af-gal" id="af-gal"><p class="af-nota">Cargando…</p></div>',
      '<div class="af-pie"><button class="btn btn-secondary" id="af-volver">Volver</button></div>');
    $('af-volver').addEventListener('click', () => { if (S && S.versiones.length) { pantallaResultado(); } else if (S) pantallaCrear(); else cerrar(); });
    let lista = [];
    try { lista = (await pedir('/afiches')).afiches || []; } catch (x) { aviso(x.message, 'error'); }
    const g = $('af-gal'); if (!g) return;
    if (!lista.length) { g.innerHTML = '<p class="af-nota">Aún no hay afiches. ¡Crea el primero!</p>'; return; }
    g.innerHTML = lista.slice(0, 24).map((a) => `<button type="button" data-id="${a.id}"><span id="af-g-${a.id}"></span><small>${e(a.titulo)}</small></button>`).join('');
    lista.slice(0, 24).forEach(async (a) => {
      try { const img = await cargarImagen(a.id, a.final); const s = $(`af-g-${a.id}`); if (s) s.style.backgroundImage = `url('${img.dataset.url}')`; a._img = img; } catch (x) { /* ya no está */ }
    });
    g.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', async () => {
      const a = lista.find((x) => String(x.id) === b.dataset.id);
      try {
        const img = await cargarImagen(a.id);
        let ev = S ? S.ev : { titulo: a.titulo };
        if (!S && a.eventId) { try { const it = state.events.find((x) => x.id === a.eventId); if (it) ev = evDesdeEvento(it); } catch (x) { /* nada */ } }
        const conservar = S;
        S = nuevaSesion(ev);
        if (conservar) { S.textos = conservar.textos; S.diseno = conservar.diseno; S.datos = conservar.datos; S.qr = conservar.qr; S.qrUrl = conservar.qrUrl; }
        S.opts = { ...S.opts, ...(a.opciones || {}) };
        S.versiones = [{ id: a.id, prompt: a.prompt, img }]; S.actual = 0;
        pantallaResultado();
      } catch (x) { aviso('No se pudo abrir ese afiche', 'error'); }
    }));
    void volver;
  }

  // ---------------- ver el afiche adjunto de una actividad ----------------
  async function verAdjunto(ev) {
    modal('Afiche', '<div class="af-ver"><p class="af-nota">Cargando…</p></div>', `<div class="af-pie">${estado && estado.puedeCrear && ev.id ? `<button class="btn btn-secondary" id="af-otro" title="Crear otro afiche" aria-label="Crear otro afiche">${ico('pincel')} Otro</button>` : ''}<button class="btn btn-secondary" id="af-v-bajar" style="flex:1">${ico('bajar')} Descargar</button><button class="btn af-wa" id="af-v-comp">${ico('compartir')} Compartir</button></div>`);
    $('af-otro')?.addEventListener('click', () => { S = nuevaSesion(ev); pantallaCrear(); });
    let img;
    try { img = await cargarImagen(ev.posterId, true); } catch (x) { raiz().querySelector('.af-ver').innerHTML = '<p class="af-nota">No se pudo cargar el afiche.</p>'; return; }
    raiz().querySelector('.af-ver').innerHTML = ''; raiz().querySelector('.af-ver').appendChild(img);
    const blob = async () => (await fetch(img.dataset.url)).blob();
    const nom = `afiche-${ev.id}.jpg`;
    $('af-v-bajar').addEventListener('click', async () => { const a = document.createElement('a'); a.href = img.dataset.url; a.download = nom; document.body.appendChild(a); a.click(); a.remove(); });
    $('af-v-comp').addEventListener('click', async () => {
      const file = new File([await blob()], nom, { type: 'image/jpeg' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: ev.titulo }); } catch (x) { /* cancelado */ } }
      else $('af-v-bajar').click();
    });
  }

  // ---------------- punto de entrada ----------------
  // abrirAfiche(evento de state.events) | abrirAfiche({ eventId }) | abrirAfiche({ buscar: 'noche de hogar' }) | abrirAfiche({ datos: {...} })
  window.abrirAfiche = async function abrirAfiche(arg = {}) {
    await cargarEstado();
    let it = null;
    const eventos = (() => { try { return state.events || []; } catch (x) { return []; } })();
    if (arg && arg.title && arg.date) it = arg;
    else if (arg.eventId) it = eventos.find((x) => x.id === Number(arg.eventId)) || null;
    const ev = it ? evDesdeEvento(it) : arg.datos ? { titulo: '', color: '#8b5cf6', ...arg.datos } : { titulo: '' };
    if (it && it.posterId && !arg.nuevo) return verAdjunto(ev);
    if (!estado.puedeCrear) { aviso('Solo los líderes y secretarios pueden crear afiches', 'error'); return; }
    S = nuevaSesion(ev);
    if (!it && !arg.datos) {
      // Desde Deseret o sin actividad: se ofrecen las próximas actividades (y la que coincida con lo pedido).
      const hoyIso = new Date().toISOString().slice(0, 10);
      const prox = eventos.filter((x) => !x.isMeeting && x.date >= hoyIso).sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime)).slice(0, 30);
      const q = String(arg.buscar || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const pal = q.split(/\s+/).filter((w) => w.length > 3 && !/^(para|afiche|poster|actividad|hazme|haz|crea|creame|genera|generame|disena|prepara|preparame|deseret)$/.test(w));
      const puntaje = (x) => pal.filter((w) => String(x.title).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(w)).length;
      const mejores = pal.length ? prox.map((x) => [x, puntaje(x)]).filter(([, p]) => p > 0).sort((a, b) => b[1] - a[1]) : [];
      if (mejores.length && (mejores.length === 1 || mejores[0][1] > mejores[1][1])) { S = nuevaSesion(evDesdeEvento(mejores[0][0])); }
      else if (prox.length) S.eleccion = prox;
      else S.ev.libre = true;
    }
    pantallaCrear();
  };
  window.verAficheActividad = (it) => { cargarEstado().then(() => verAdjunto(evDesdeEvento(it))); };
  window.afichesEstado = cargarEstado;
})();
