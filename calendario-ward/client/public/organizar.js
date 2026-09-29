// ----------------------------------------------------------------------
// PREPARATIVOS DE ACTIVIDADES + FICHA DE ORGANIZACIÓN
// ----------------------------------------------------------------------
// Preparativos: dentro de cada actividad aparece "Preparación X %" con la
// lista de tareas. Quien administra la actividad arma la lista (con una
// sugerencia según el tipo de actividad, o ideas de Deseret); cada
// responsable con cuenta ve su tarea en "Mi semana" y la marca hecha. Al
// 100 %: "¡Todo listo!".
// Ficha de organización: un resumen de una organización en una sola
// ventana (no es un módulo nuevo): se abre desde Inicio con "Mi organización".
// Servidor: routes/preparativos.js
// ----------------------------------------------------------------------
(function () {
  const $ = (id) => document.getElementById(id);
  const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = () => { try { return state.token; } catch (x) { return localStorage.getItem('cow_token'); } };
  const aviso = (m, t) => { try { toast(m, t); } catch (x) { console.log(m); } };
  async function pedir(ruta, { method = 'GET', body } = {}) {
    const r = await fetch('/api' + ruta, { method, headers: { 'Content-Type': 'application/json', ...(token() ? { Authorization: `Bearer ${token()}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch (x) { /* nada */ }
    if (!r.ok) throw new Error((j && j.error) || `Error ${r.status}`);
    return j;
  }
  const fechaCorta = (iso) => { try { return fmtDateHuman(iso); } catch (x) { return iso; } };
  const ic = (n, t = 16) => { try { return icon(n, t); } catch (x) { return ''; } };

  const css = `
  .prep-box { margin-top: 14px; border: 1px solid var(--border); border-radius: 12px; padding: 12px; background: var(--white); }
  .prep-cab { display: flex; align-items: center; gap: 10px; }
  .prep-cab b { font-size: 14px; }
  .prep-cab .prep-pct { margin-left: auto; font-size: 13px; font-weight: 700; color: var(--celeste-dark); }
  .prep-barra { height: 8px; border-radius: 999px; background: var(--celeste-lighter); overflow: hidden; margin: 8px 0 4px; }
  .prep-barra i { display: block; height: 100%; border-radius: 999px; background: var(--celeste-dark); transition: width .3s ease; }
  .prep-box.listo .prep-barra i { background: var(--success); }
  .prep-listo { display: flex; align-items: center; gap: 6px; color: var(--success); font-weight: 600; font-size: 13.5px; margin: 6px 0 2px; }
  .prep-item { display: flex; align-items: flex-start; gap: 10px; padding: 7px 0; border-top: 1px solid var(--border); font-size: 13.5px; }
  .prep-item:first-of-type { border-top: 0; }
  .prep-item input { width: 18px; height: 18px; margin-top: 1px; flex-shrink: 0; accent-color: var(--celeste-dark); }
  .prep-item.hecho .prep-t { text-decoration: line-through; color: var(--ink-soft); }
  .prep-item small { display: block; color: var(--ink-soft); font-size: 12px; margin-top: 1px; }
  .prep-acc { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .prep-vacio { font-size: 13px; color: var(--ink-soft); margin: 6px 0 0; }
  #orgf-root .modal-backdrop { z-index: 1040; }
  #prep-root .modal-backdrop { z-index: 1045; }
  #prep-root .modal { max-width: 560px; }
  .prep-ed { padding: 10px 0; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; }
  .prep-ed:first-child { border-top: 0; }
  .prep-ed .r1, .prep-ed .r2 { display: flex; gap: 8px; align-items: center; }
  .prep-ed input[type=checkbox] { width: 18px; height: 18px; flex-shrink: 0; accent-color: var(--celeste-dark); }
  .prep-ed input[type=text], .prep-ed select, .prep-ed input[type=date] { box-sizing: border-box; width: 100% !important; min-width: 0; padding: 8px 10px; font-size: 13.5px; border: 1px solid var(--border); border-radius: 8px; background: var(--white); color: var(--ink); margin: 0; }
  .prep-ed .r2 { padding-left: 26px; }
  .prep-ed .r2 select { flex: 1 1 auto; }
  .prep-ed .r2 .prep-fecha { flex: 0 0 150px; width: 150px !important; }
  .prep-ed .prep-nombre { margin-left: 26px !important; width: calc(100% - 26px) !important; }
  .prep-ed .prep-quitar { border: 0; background: none; color: var(--ink-soft); font-size: 22px; line-height: 1; cursor: pointer; padding: 0 4px; flex-shrink: 0; }
  @media (max-width: 420px) { .prep-ed .r2 { flex-wrap: wrap; } .prep-ed .r2 .prep-fecha { flex: 1 1 100%; width: 100% !important; } }
  #orgf-root .modal { max-width: 620px; }
  .orgf-sec { margin-top: 16px; }
  .orgf-sec h4 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-soft); margin: 0 0 8px; display: flex; justify-content: space-between; align-items: baseline; }
  .orgf-sec h4 small { text-transform: none; letter-spacing: 0; font-weight: 400; }
  .orgf-fila { display: flex; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--border); font-size: 13.5px; }
  .orgf-fila:first-of-type { border-top: 0; }
  .orgf-fila .t { flex: 1; min-width: 0; }
  .orgf-fila .t small { display: block; color: var(--ink-soft); font-size: 12px; }
  .orgf-mini { width: 64px; flex-shrink: 0; }
  .orgf-mini .prep-barra { margin: 0; height: 6px; }
  .orgf-mini span { display: block; font-size: 11px; color: var(--ink-soft); text-align: right; margin-top: 2px; }
  .orgf-kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .orgf-kpi { border: 1px solid var(--border); border-radius: 10px; padding: 10px; }
  .orgf-kpi b { display: block; font-size: 18px; color: var(--ink); }
  .orgf-kpi span { font-size: 12px; color: var(--ink-soft); }
  .orgf-atras { color: var(--danger); font-weight: 600; }
  `;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function raiz(id) { let r = $(id); if (!r) { r = document.createElement('div'); r.id = id; document.body.appendChild(r); } return r; }
  function modal(rootId, titulo, cuerpo, pie) {
    const r = raiz(rootId);
    r.innerHTML = `<div class="modal-backdrop" id="${rootId}-fondo"><div class="modal" role="dialog" aria-label="${e(titulo)}">
      <div class="modal-header"><h3>${e(titulo)}</h3><button class="modal-close" id="${rootId}-cerrar" aria-label="Cerrar">×</button></div>
      <div class="modal-body">${cuerpo}</div>${pie || ''}</div></div>`;
    const cerrar = () => { r.innerHTML = ''; };
    $(`${rootId}-cerrar`).addEventListener('click', cerrar);
    $(`${rootId}-fondo`).addEventListener('click', (x) => { if (x.target.id === `${rootId}-fondo`) cerrar(); });
    return { r, cerrar };
  }

  // ---------------- recuadro dentro de la actividad ----------------
  const barra = (pct) => `<div class="prep-barra" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>`;
  function yoId() { try { return state.user.id; } catch (x) { return null; } }
  function htmlCaja(ev, d) {
    const listo = d.total && d.hechos === d.total;
    if (!d.total) {
      if (!d.puedeEditar) return '';
      return `<div class="prep-box"><div class="prep-cab">${ic('check')}<b>Preparativos</b></div>
        <p class="prep-vacio">Arma la lista de lo que hay que preparar y asígnala. Cada responsable la verá en su semana.</p>
        <div class="prep-acc"><button type="button" class="btn btn-secondary btn-sm" data-prep-editar>Crear lista de preparativos</button></div></div>`;
    }
    const puedeMarcar = (x) => d.puedeEditar || Number(x.responsableId) === Number(yoId());
    return `<div class="prep-box ${listo ? 'listo' : ''}">
      <div class="prep-cab">${ic('check')}<b>Preparación</b><span class="prep-pct">${d.pct}%</span></div>
      ${barra(d.pct)}
      ${listo ? `<div class="prep-listo">${ic('check')} ¡Todo listo! La actividad está preparada.</div>` : `<div style="font-size:12px;color:var(--ink-soft)">${d.hechos} de ${d.total} listos</div>`}
      <div style="margin-top:6px">${d.items.map((x) => `<label class="prep-item ${x.hecho ? 'hecho' : ''}">
        <input type="checkbox" data-prep-marcar="${x.id}" ${x.hecho ? 'checked' : ''} ${puedeMarcar(x) ? '' : 'disabled'} />
        <span><span class="prep-t">${e(x.texto)}</span><small>${e([x.responsableNombre, x.fecha ? `hasta el ${fechaCorta(x.fecha)}` : ''].filter(Boolean).join(' · ') || 'Sin responsable')}</small></span>
      </label>`).join('')}</div>
      ${d.puedeEditar ? '<div class="prep-acc"><button type="button" class="btn btn-secondary btn-sm" data-prep-editar>Editar lista</button></div>' : ''}
    </div>`;
  }
  async function pintarCaja(cont, ev) {
    if (!cont || !ev || !ev.id) return;
    let d;
    try { d = await pedir(`/events/${ev.id}/preparativos`); } catch (x) { cont.innerHTML = ''; return; }
    if (!cont.isConnected) return;
    cont.innerHTML = htmlCaja(ev, d);
    cont.querySelectorAll('[data-prep-marcar]').forEach((c) => c.addEventListener('change', async () => {
      c.disabled = true;
      try {
        const nd = await pedir(`/events/${ev.id}/preparativos/${c.dataset.prepMarcar}/marcar`, { method: 'POST', body: { hecho: c.checked } });
        cont.innerHTML = htmlCaja(ev, nd); pintarCaja(cont, ev);
        if (nd.total && nd.hechos === nd.total) aviso('¡Todo listo! La actividad está preparada.');
        actualizarEvento(ev.id, nd);
      } catch (x) { aviso(x.message, 'error'); c.checked = !c.checked; c.disabled = false; }
    }));
    cont.querySelector('[data-prep-editar]')?.addEventListener('click', () => abrirEditor(ev, d, () => pintarCaja(cont, ev)));
  }
  function actualizarEvento(id, d) {
    try { const it = state.events.find((x) => x.id === id); if (it) it.preparativos = d.items; } catch (x) { /* nada */ }
  }

  // ---------------- editor de la lista ----------------
  function abrirEditor(ev, d, alGuardar) {
    let items = (d.items || []).map((x) => ({ ...x }));
    const personas = d.personas || [];
    const opciones = (sel) => `<option value="">Sin responsable</option>${personas.map((p) => `<option value="${p.id}" ${Number(sel) === p.id ? 'selected' : ''}>${e(p.nombre)}${p.org ? ` · ${e(p.org)}` : ''}</option>`).join('')}<option value="otro" ${!sel && items.length ? '' : ''}>Otra persona (escribir nombre)…</option>`;
    const { cerrar } = modal('prep-root', `Preparativos · ${ev.title || ev.titulo || ''}`, `
      <p class="prep-vacio" style="margin:0 0 10px">Las personas con cuenta verán su tarea en <b>Mi semana</b> y recibirán un aviso.</p>
      <div id="prep-lista"></div>
      <div class="prep-acc">
        <button type="button" class="btn btn-secondary btn-sm" id="prep-agregar">+ Agregar tarea</button>
        <button type="button" class="btn btn-ghost btn-sm" id="prep-sugerir">Sugerir lista</button>
        <button type="button" class="btn btn-ghost btn-sm" id="prep-deseret"><img src="/deseret.svg" alt="" width="16" height="16" style="vertical-align:-3px"> Ideas de Deseret</button>
      </div>`,
    `<div class="modal-footer" style="justify-content:flex-end"><button class="btn btn-secondary" id="prep-cancelar">Cancelar</button><button class="btn btn-primary" id="prep-guardar">Guardar</button></div>`);
    const lista = $('prep-lista');
    const leer = () => {
      items = [...lista.querySelectorAll('.prep-ed')].map((row) => {
        const sel = row.querySelector('select').value;
        return {
          id: row.dataset.id ? Number(row.dataset.id) : undefined,
          texto: row.querySelector('.prep-texto').value,
          responsableId: sel && sel !== 'otro' ? Number(sel) : null,
          responsableNombre: sel === 'otro' ? row.querySelector('.prep-nombre').value : '',
          fecha: row.querySelector('.prep-fecha').value || null,
          hecho: row.querySelector('input[type=checkbox]').checked,
        };
      });
    };
    const pintar = () => {
      lista.innerHTML = items.length ? items.map((x) => `<div class="prep-ed" data-id="${x.id || ''}">
        <div class="r1"><input type="checkbox" ${x.hecho ? 'checked' : ''} aria-label="Hecho" /><input type="text" class="prep-texto" maxlength="120" placeholder="Qué hay que hacer" value="${e(x.texto)}" /><button type="button" class="prep-quitar" aria-label="Quitar">×</button></div>
        <div class="r2"><select aria-label="Responsable">${opciones(x.responsableId)}</select><input type="date" class="prep-fecha" value="${e(x.fecha || '')}" max="${e(ev.date || '')}" title="Hasta cuándo" aria-label="Hasta cuándo" /></div>
        <input type="text" class="prep-nombre" maxlength="60" placeholder="Nombre de la persona" value="${e(x.responsableNombre || '')}" style="${!x.responsableId && x.responsableNombre ? '' : 'display:none'}" />
        </div>`).join('') : '<p class="prep-vacio">Aún no hay tareas. Agrega una o usa "Sugerir lista".</p>';
      lista.querySelectorAll('.prep-ed').forEach((row, i) => {
        const sel = row.querySelector('select');
        if (!items[i].responsableId && items[i].responsableNombre) sel.value = 'otro';
        sel.addEventListener('change', () => { row.querySelector('.prep-nombre').style.display = sel.value === 'otro' ? '' : 'none'; if (sel.value === 'otro') row.querySelector('.prep-nombre').focus(); });
        row.querySelector('.prep-quitar').addEventListener('click', () => { leer(); items.splice(i, 1); pintar(); });
      });
    };
    pintar();
    const agregarTextos = (textos) => { leer(); const ya = new Set(items.map((x) => x.texto.trim().toLowerCase())); textos.forEach((t) => { if (!ya.has(t.toLowerCase())) items.push({ texto: t, responsableId: null, fecha: null, hecho: false }); }); pintar(); };
    $('prep-agregar').addEventListener('click', () => { leer(); items.push({ texto: '', responsableId: null, fecha: null, hecho: false }); pintar(); const ult = lista.querySelectorAll('.prep-texto'); ult[ult.length - 1]?.focus(); });
    const sugerir = async (conDeseret, btn) => {
      const antes = btn.innerHTML; btn.disabled = true; btn.textContent = 'Pensando…';
      try { const r = await pedir(`/events/${ev.id}/preparativos/sugerir${conDeseret ? '?deseret=1' : ''}`); agregarTextos(r.tareas || []); }
      catch (x) { aviso(x.message, 'error'); }
      btn.disabled = false; btn.innerHTML = antes;
    };
    $('prep-sugerir').addEventListener('click', (x) => sugerir(false, x.currentTarget));
    $('prep-deseret').addEventListener('click', (x) => sugerir(true, x.currentTarget));
    $('prep-cancelar').addEventListener('click', cerrar);
    $('prep-guardar').addEventListener('click', async () => {
      leer();
      const b = $('prep-guardar'); b.disabled = true;
      try {
        const nd = await pedir(`/events/${ev.id}/preparativos`, { method: 'PUT', body: { items: items.filter((x) => x.texto.trim()) } });
        actualizarEvento(ev.id, nd);
        cerrar(); aviso('Preparativos guardados'); if (alGuardar) alGuardar();
      } catch (x) { aviso(x.message, 'error'); b.disabled = false; }
    });
  }

  // Desde "Mi semana": abrir directo la lista de una actividad.
  async function abrirPreparativos(eventId) {
    const ev = (() => { try { return state.events.find((x) => x.id === Number(eventId)); } catch (x) { return null; } })() || { id: Number(eventId) };
    const { r } = modal('prep-root', 'Preparativos', '<div id="prep-solo"></div>');
    const cont = r.querySelector('#prep-solo');
    let d; try { d = await pedir(`/events/${ev.id}/preparativos`); } catch (x) { cont.innerHTML = `<p class="prep-vacio">${e(x.message)}</p>`; return; }
    r.querySelector('h3').textContent = `Preparativos${ev.title ? ` · ${ev.title}` : ''}`;
    await pintarCaja(cont, ev);
  }

  // ---------------- Ficha de organización ----------------
  async function abrirFichaOrganizacion(orgId) {
    const { r, cerrar } = modal('orgf-root', 'Mi organización', '<div id="orgf-cuerpo"><div class="prep-vacio">Cargando…</div></div>');
    let d;
    try { d = await pedir(`/organizaciones/${orgId}/resumen`); } catch (x) { $('orgf-cuerpo').innerHTML = `<p class="prep-vacio">${e(x.message)}</p>`; return; }
    const o = d.organizacion;
    r.querySelector('h3').innerHTML = `<span class="org-dot" style="background:${e(o.color)};margin-right:8px"></span>${e(o.nombre)}`;
    const peso = (n) => `$${Number(n || 0).toLocaleString('es-CL')}`;
    const kpis = `<div class="orgf-kpis">
      <div class="orgf-kpi"><b>${d.actividades.length}</b><span>próximas actividades</span></div>
      <div class="orgf-kpi"><b>${d.totalCompromisos}</b><span>compromisos abiertos${d.atrasados ? ` · <span class="orgf-atras">${d.atrasados} atrasado${d.atrasados === 1 ? '' : 's'}</span>` : ''}</span></div>
      ${d.presupuesto ? `<div class="orgf-kpi"><b>${d.presupuesto.tieneAsignacion ? peso(d.presupuesto.saldo) : '—'}</b><span>${d.presupuesto.tieneAsignacion ? `disponible de ${peso(d.presupuesto.asignado)}` : 'sin presupuesto asignado'}</span></div>` : `<div class="orgf-kpi"><b>${d.actas.length}</b><span>actas recientes</span></div>`}
    </div>`;
    const actividades = d.actividades.length ? d.actividades.map((a) => `<div class="orgf-fila" data-ev="${a.id}" style="cursor:pointer">
        <span class="t"><b>${e(a.titulo)}</b><small>${e([fechaCorta(a.fecha), a.hora, a.lugar].filter(Boolean).join(' · '))}</small></span>
        ${a.preparacion ? `<span class="orgf-mini">${barra(a.preparacion.pct)}<span>${a.preparacion.pct === 100 ? 'Lista' : `${a.preparacion.pct}%`}</span></span>` : '<span class="orgf-mini"><span>Sin lista</span></span>'}
      </div>`).join('') : `<p class="prep-vacio">No hay actividades próximas.${d.ultimaActividad ? ` La última fue el ${e(fechaCorta(d.ultimaActividad))}.` : ''}</p>`;
    const compromisos = d.compromisos.length ? d.compromisos.map((c) => `<div class="orgf-fila"><span class="t">${e(c.descripcion)}<small>${e([c.responsable, c.fecha ? `vence ${fechaCorta(c.fecha)}` : ''].filter(Boolean).join(' · '))}${c.atrasado ? ' · <span class="orgf-atras">atrasado</span>' : ''}</small></span></div>`).join('') : '<p class="prep-vacio">No hay compromisos abiertos.</p>';
    $('orgf-cuerpo').innerHTML = `
      ${d.otras.length > 1 ? `<select id="orgf-otra" style="width:100%;margin-bottom:12px">${d.otras.map((x) => `<option value="${x.id}" ${x.id === o.id ? 'selected' : ''}>${e(x.nombre)}</option>`).join('')}</select>` : ''}
      ${d.presidencia.length ? `<p class="prep-vacio" style="margin:0 0 12px">Presidencia: ${e(d.presidencia.join(', '))}</p>` : ''}
      ${kpis}
      <div class="orgf-sec"><h4>Próximas actividades <small>toca una para ver su preparación</small></h4>${actividades}</div>
      <div class="orgf-sec"><h4>Compromisos abiertos${d.confidenciales ? ` <small>+${d.confidenciales} confidencial${d.confidenciales === 1 ? '' : 'es'}</small>` : ''}</h4>${compromisos}${d.totalCompromisos > d.compromisos.length ? `<p class="prep-vacio">y ${d.totalCompromisos - d.compromisos.length} más en Reuniones.</p>` : ''}</div>
      ${d.actas.length ? `<div class="orgf-sec"><h4>Últimas actas</h4>${d.actas.map((a) => `<div class="orgf-fila" data-acta="${a.id}" style="cursor:pointer"><span class="t">${e(a.titulo)}<small>${e(fechaCorta(a.fecha))}</small></span></div>`).join('')}</div>` : ''}`;
    $('orgf-otra')?.addEventListener('change', (x) => abrirFichaOrganizacion(Number(x.target.value)));
    $('orgf-cuerpo').querySelectorAll('[data-ev]').forEach((row) => row.addEventListener('click', () => abrirPreparativos(Number(row.dataset.ev))));
    $('orgf-cuerpo').querySelectorAll('[data-acta]').forEach((row) => row.addEventListener('click', async () => {
      cerrar();
      try { state.view = 'meetings'; state.meetingsSubtab = 'manage'; render(); const m = await api(`/meetings/${row.dataset.acta}`); openMeetingDetailModal(m); } catch (x) { /* queda en Reuniones */ }
    }));
  }

  window.pintarPreparativosEn = (cont, ev) => pintarCaja(cont, ev);
  window.abrirPreparativos = abrirPreparativos;
  window.abrirFichaOrganizacion = abrirFichaOrganizacion;
})();
