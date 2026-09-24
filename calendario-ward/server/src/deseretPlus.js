// ----------------------------------------------------------------------
// DESERET — SEGUNDA TANDA DE MEJORAS
// ----------------------------------------------------------------------
//   D2  Recordatorios personales    "recuérdame llamar al hno. Soto el jueves a las 19:00"
//   D3  Dictar un acta completa     "dictar acta" → temas, acuerdos y compromisos
//   D5  Deshacer                    "deshaz lo último"
//   D6  Avisos al abrir el chat     GET /api/deseret/avisos
//   D7  A quién entrevistar         "¿a quién debería entrevistar?"
//   D9  Buscar en actas antiguas    "¿qué acordamos sobre la noche de hogar?"
//   D15 Resumen de una organización "¿cómo va la Primaria este mes?"
//   D16 Explicar el Manual General  "¿quién llama a la presidenta de la Primaria?"
// Siempre con los mismos permisos que cada módulo de la app.
// ----------------------------------------------------------------------
import { load, withDb, nextId, contextoDeseret } from './db.js';
import { isObispadoLeader } from './routes/stake.js';
import { orgSeesAllInterviews, canScheduleOrg } from './routes/interviews.js';
import { isMinisteringFocusLeaderHombres, isMinisteringFocusLeaderMujeres } from './routes/directory.js';
import {
  canSeeMeetingRecord, withMeetingInfo, assignableUsersFor, EMPTY_AGENDA_ITEM_NOTES,
} from './routes/meetings.js';
import { computeCuadrante, isAdultMale, isAdultFemale } from './pastoralFocus.js';
import { resumenSemana, fraseResumen } from './semana.js';
import { sendUserPush } from './webpush.js';
import {
  resp, fechaLegible, parseFecha, parseHora, normalizeSearchText, palabrasDe,
  guardarBorrador, borrarBorrador, OPCIONES_CONFIRMAR, ES_AFIRMATIVO, vaciarCache,
  toISO, sumarDias, redactarConIA, filtrarAlucinacion, orgPorId, contextoCrecimiento,
  jsonConIA, inferOrganizationId, MESES_NOMBRE,
} from './chat.js';

const ZONA = process.env.TZ_APP || 'America/Santiago';
function ahoraChile() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
}
const LIDERES = ['admin', 'leader', 'ward_clerk', 'executive_secretary'];
const STOP = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'con', 'a', 'al', 'hermano', 'hermana', 'hno', 'hna', 'para', 'y', 'que', 'mi', 'su', 'en', 'un', 'una', 'por', 'sobre', 'lo', 'le']);
function coincideNombre(buscado, nombre) {
  const b = palabrasDe(buscado).filter((w) => w.length > 1 && !STOP.has(w));
  if (!b.length) return false;
  const p = palabrasDe(nombre);
  return b.every((w) => p.some((x) => x === w || (w.length >= 3 && x.startsWith(w))));
}

// ---------------- Detección ----------------
const RE_DESHACER = /^\s*(deshaz\w*|deshacer|revierte|revertir|anula lo (ultimo|que hiciste)|borra lo (ultimo|que hiciste)|me equivoque\W+deshaz\w*)\b/;
const RE_REC_LISTAR = /\b(mis recordatorios|que recordatorios|recordatorios (tengo|pendientes))\b/;
const RE_REC_BORRAR = /\b(borra|elimina|cancela|quita)\w*\s+(el |mi |los |mis )?recordatorios?\b/;
const RE_REC_CREAR = /\b(recuerdame|recordarme|recuerdeme|avisame|pon(me)? un recordatorio|crea(me)? un recordatorio|agrega(me)? un recordatorio)\b/;
const RE_DICTAR = /\b(dictar|dicto|dictare|voy a dictar|registra|registrar|anota|anotar|crea|crear|redacta|redactar|arma|armar)\b.{0,25}\bacta\b|^\s*acta( de la reunion)?\s*:/;
const RE_SUGERIR = /\b(a quien(es)?|quien(es)?)\b.{0,40}\b(entrevist\w*|visit\w*|priorizar|deberia (ver|llamar)|conviene (ver|llamar))\b|\bsugi\w*.{0,20}\b(entrevistas|a quien)\b/;
const RE_BUSCAR = /\b(que (acordamos|decidimos|quedamos|se acordo|se decidio|dijimos)|acuerdos? (sobre|de|del)|busca\w* en (las )?actas|en que acta|cuando (hablamos|vimos|tratamos|acordamos))\b/;
const RE_RESUMEN_ORG = /\b(como (va|van|anda|andan|esta|estan|le va a|les va a)|resumen (de|del)|balance (de|del)|estado (de|del))\b/;
const RE_MANUAL = /\b(manual( general)?|quien (llama|aparta|sostiene|recomienda|aprueba|extiende)|quien(es)? (asiste|asisten|va|van) (al|a la)|cada cuanto|con que frecuencia|cada cuanto tiempo)\b/;

export function detectarPlus(norm, data) {
  const agendaPropia = /\b(me toca|tengo|agendad\w*)\b/.test(norm);
  if (RE_DESHACER.test(norm)) return 'deshacer';
  if (RE_REC_LISTAR.test(norm)) return 'rec_listar';
  if (RE_REC_BORRAR.test(norm)) return 'rec_borrar';
  if (RE_REC_CREAR.test(norm)) return 'rec_crear';
  if (RE_DICTAR.test(norm)) return 'dictar';
  if (RE_SUGERIR.test(norm) && !agendaPropia) return 'sugerir';
  if (RE_BUSCAR.test(norm)) return 'buscar';
  if (RE_MANUAL.test(norm)) return 'manual';
  if (RE_RESUMEN_ORG.test(norm) && inferOrganizationId(norm, data.organizations || [])) return 'resumen_org';
  return null;
}

// Punto de entrada (pedido nuevo o continuación de un borrador 'plus').
export async function manejarPlus(tipo, { mensaje, mensajeMin, norm, usuario, hoyObj, historial, borrador = null, breve = false }) {
  if (!usuario) return resp('🔒 Necesitas haber iniciado sesión.');
  const data = load();
  if (borrador) tipo = borrador.datos.plus;
  switch (tipo) {
    case 'deshacer': return deshacerUltimo(usuario);
    case 'rec_crear': return crearRecordatorio({ mensaje, mensajeMin, usuario, hoyObj, borrador });
    case 'rec_listar': return listarRecordatorios(usuario, data);
    case 'rec_borrar': return borrarRecordatorio(mensaje, usuario, data, borrador);
    case 'dictar': return dictarActa({ mensaje, mensajeMin, usuario, data, hoyObj, borrador });
    case 'sugerir': return sugerirEntrevistas(usuario, data, hoyObj);
    case 'buscar': return buscarEnActas(mensaje, norm, usuario, data, historial, breve);
    case 'resumen_org': return resumenOrganizacion(mensaje, norm, usuario, data, hoyObj, historial, breve);
    case 'manual': return explicarManual(norm);
    default: return null;
  }
}

// ======================================================================
// D5 — DESHACER
// ======================================================================
// server.js corre cada mensaje dentro de contextoDeseret; db.js anota cómo
// estaban los registros antes de cada escritura. Acá se guarda esa lista
// como "lo último que hizo Deseret" de esta persona (15 minutos).
const DESHACER_MIN = 15;
export async function guardarDeshacer(usuario, texto, cambios) {
  if (!usuario || !cambios?.length) return;
  const n = (String(texto || '').match(/^\*\*\d+\.\*\*/gm) || []).length;
  const descripcion = n > 1 ? `las ${n} acciones que me pediste` : String(texto || '').split('\n')[0].replace(/[*_]/g, '').replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '').replace(/^(listo|perfecto|dale)[,!.]?\s*/i, '').replace(/[.!\s]+$/, '').slice(0, 160);
  await contextoDeseret.exit(() => withDb((d) => {
    d.deseretDeshacer = d.deseretDeshacer || {};
    d.deseretDeshacer[usuario.id] = { at: Date.now(), descripcion, cambios };
  }));
}

async function deshacerUltimo(usuario) {
  const data = load();
  const u = (data.deseretDeshacer || {})[usuario.id];
  if (!u || Date.now() - u.at > DESHACER_MIN * 60 * 1000) {
    return resp(`No tengo nada reciente que deshacer (solo puedo deshacer lo último que hice por ti en los últimos ${DESHACER_MIN} minutos).`);
  }
  const resultado = await contextoDeseret.exit(() => withDb((d) => {
    // Si alguien más cambió esos registros después, no se pisan sus cambios.
    const conflicto = u.cambios.some(({ c, id, despues }) => {
      const x = (d[c] || []).find((r) => r.id === id);
      return (x ? JSON.stringify(x) : null) !== despues;
    });
    if (conflicto) return 'conflicto';
    for (const { c, id, antes } of u.cambios) {
      d[c] = d[c] || [];
      const i = d[c].findIndex((r) => r.id === id);
      if (antes === null) { if (i >= 0) d[c].splice(i, 1); } else if (i >= 0) d[c][i] = JSON.parse(antes); else d[c].push(JSON.parse(antes));
    }
    delete d.deseretDeshacer[usuario.id];
    return 'ok';
  }));
  if (resultado === 'conflicto') {
    return resp('⚠️ No pude deshacerlo: alguien modificó esos datos después. Revísalo directamente en la app.');
  }
  vaciarCache();
  return resp(`↩️ Listo, deshice: _${u.descripcion || 'lo último que hice'}_.\n\nSi ya se había enviado un aviso (correo, WhatsApp o notificación), ese aviso no se puede retirar.`);
}

// ======================================================================
// D2 — RECORDATORIOS PERSONALES (con notificación push a la hora)
// ======================================================================
function relativa(norm) {
  const m = norm.match(/\ben (\d{1,3}|un|una|media) (minutos?|horas?|hora)\b/);
  if (!m) return null;
  const n = m[1] === 'media' ? 30 : ['un', 'una'].includes(m[1]) ? 1 : Number(m[1]);
  const min = m[1] === 'media' ? 30 : /^hora/.test(m[2]) ? n * 60 : n;
  const t = new Date(Date.now() + min * 60000);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(t).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
}
function textoRecordatorio(mensaje) {
  return mensaje
    .replace(/^.*?\b(recu[eé]rda(me|le)|recordarme|recu[eé]rdeme|av[ií]same|pon(me)? un recordatorio|cr[eé]a(me)? un recordatorio|agr[eé]ga(me)? un recordatorio)\b\s*(de|que|para|:)?\s*/i, '')
    .replace(/\s+en (\d{1,3}|un|una|media) (minutos?|horas?)\b/i, '')
    .replace(/\s*(el |este |esta |pr[oó]ximo )?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/gi, '')
    .replace(/\s*(pasado\s+)?(ma[ñn]ana|hoy)\b(?!\s+de la)/gi, '')
    .replace(/\s*(el |para el )?\d{1,2}\s+de\s+[a-záéíóúñ]+/gi, '')
    .replace(/\s*(a las?|como a las?|tipo)\s+\d{1,2}(:\d{2})?\s*(hrs?|horas)?(\s*(am|pm|de la (ma[ñn]ana|tarde|noche)))?/gi, '')
    .replace(/\s*\d{1,2}:\d{2}\s*(hrs?)?/g, '')
    .replace(/[\s,.;:]+$/, '')
    .trim();
}
async function crearRecordatorio({ mensaje, mensajeMin, usuario, hoyObj, borrador }) {
  const d = borrador ? { ...borrador.datos } : { plus: 'rec_crear' };
  const norm = normalizeSearchText(mensaje);
  if (borrador?.falta === 'hora') {
    const rel = relativa(norm);
    if (rel) Object.assign(d, rel);
    else {
      d.hora = parseHora(mensajeMin) || d.hora;
      const f = parseFecha(mensajeMin, hoyObj);
      if (f) d.fecha = f;
    }
  } else if (!borrador) {
    d.texto = textoRecordatorio(mensaje);
    const rel = relativa(norm);
    if (rel) Object.assign(d, rel);
    else { d.fecha = parseFecha(mensajeMin, hoyObj); d.hora = parseHora(mensajeMin); }
  }
  if (borrador?.falta === 'texto') d.texto = mensaje.trim();
  if (!d.texto) { guardarBorrador(usuario, 'plus', d, 'texto'); return resp('📝 ¿De qué te recuerdo?'); }
  if (!d.hora) {
    guardarBorrador(usuario, 'plus', d, 'hora');
    return resp(`⏰ ¿Cuándo te aviso para **${d.texto}**?`, { opciones: [{ label: 'En 1 hora', value: 'en 1 hora' }, { label: 'Hoy 20:00', value: 'hoy a las 20:00' }, { label: 'Mañana 9:00', value: 'mañana a las 9:00' }] });
  }
  const ahora = ahoraChile();
  if (!d.fecha) d.fecha = d.hora > ahora.hora ? ahora.fecha : toISO(sumarDias(hoyObj, 1));
  if (`${d.fecha} ${d.hora}` <= `${ahora.fecha} ${ahora.hora}`) {
    guardarBorrador(usuario, 'plus', { ...d, hora: null }, 'hora');
    return resp('⏰ Esa hora ya pasó. ¿Para cuándo te lo dejo?');
  }
  borrarBorrador(usuario);
  const data = load();
  const tienePush = (data.webPush?.subscriptions || []).some((s) => Number(s.userId) === Number(usuario.id));
  await withDb((db) => {
    db.recordatorios = db.recordatorios || [];
    db.recordatorios.push({ id: nextId(db, 'recordatorios'), userId: usuario.id, texto: d.texto.charAt(0).toUpperCase() + d.texto.slice(1), fecha: d.fecha, hora: d.hora, enviado: false, createdAt: new Date().toISOString() });
  });
  const cuando = d.fecha === ahora.fecha ? `hoy a las ${d.hora}` : `el ${fechaLegible(d.fecha)} a las ${d.hora}`;
  return resp(`⏰ Listo, te recuerdo **${cuando}**: ${d.texto}.${tienePush ? '' : '\n\nOjo: para que te llegue el aviso, activa las **notificaciones** en tu perfil (en este dispositivo).'}`);
}
function recordatoriosPendientes(usuario, data) {
  return (data.recordatorios || []).filter((r) => Number(r.userId) === Number(usuario.id) && !r.enviado)
    .sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));
}
function listarRecordatorios(usuario, data) {
  const l = recordatoriosPendientes(usuario, data);
  if (!l.length) return resp('No tienes recordatorios pendientes. Pídeme uno así: "recuérdame llamar al hno. Soto el jueves a las 19:00".');
  return resp(`⏰ Tienes **${l.length}** recordatorio${l.length === 1 ? '' : 's'} pendiente${l.length === 1 ? '' : 's'}:`, {
    items: l.slice(0, 15).map((r) => ({ tipo: 'recordatorio', titulo: r.texto, fecha: r.fecha, hora: r.hora, org: 'Recordatorio', color: null })),
  });
}
async function borrarRecordatorio(mensaje, usuario, data, borrador) {
  const l = recordatoriosPendientes(usuario, data);
  if (!l.length) return resp('No tienes recordatorios pendientes.');
  let elegidos;
  if (borrador?.falta === 'elegir') {
    const n = Number((mensaje.match(/\d+/) || [])[0]);
    elegidos = l[n - 1] ? [l[n - 1]] : [];
  } else if (/\btodos\b/i.test(mensaje)) elegidos = l;
  else {
    const q = mensaje.replace(/^.*?recordatorios?\s*(de|del|para|sobre|que)?\s*/i, '');
    elegidos = q ? l.filter((r) => palabrasDe(q).filter((w) => w.length >= 4).some((w) => palabrasDe(r.texto).some((x) => x.startsWith(w)))) : [];
    if (elegidos.length !== 1) {
      guardarBorrador(usuario, 'plus', { plus: 'rec_borrar' }, 'elegir');
      return resp('¿Cuál borro?', { opciones: l.slice(0, 6).map((r, i) => ({ label: `${i + 1}. ${r.texto.slice(0, 40)} (${r.fecha.slice(8)}/${r.fecha.slice(5, 7)} ${r.hora})`, value: String(i + 1) })) });
    }
  }
  borrarBorrador(usuario);
  if (!elegidos.length) return resp('No encontré ese recordatorio.');
  const ids = new Set(elegidos.map((r) => r.id));
  await withDb((db) => { db.recordatorios = (db.recordatorios || []).filter((r) => !ids.has(r.id)); });
  return resp(`🗑️ Borré ${elegidos.length === 1 ? `el recordatorio **${elegidos[0].texto}**` : `${elegidos.length} recordatorios`}.`);
}

// Revisa cada minuto qué recordatorios vencieron y manda la notificación.
async function enviarRecordatoriosVencidos() {
  const data = load();
  const ahora = ahoraChile();
  const vencidos = (data.recordatorios || []).filter((r) => !r.enviado && `${r.fecha} ${r.hora}` <= `${ahora.fecha} ${ahora.hora}`);
  if (!vencidos.length) return;
  for (const r of vencidos) {
    const u = data.users.find((x) => x.id === Number(r.userId));
    try { await sendUserPush(u, { title: '⏰ Recordatorio de Deseret', body: r.texto, url: '/?vista=home' }); } catch { /* sin suscripción */ }
  }
  const ids = new Set(vencidos.map((r) => r.id));
  await withDb((db) => {
    for (const r of db.recordatorios || []) if (ids.has(r.id)) { r.enviado = true; r.enviadoAt = new Date().toISOString(); }
    // Se guardan solo los últimos 30 días de recordatorios ya enviados.
    const limite = toISO(sumarDias(new Date(), -30));
    db.recordatorios = (db.recordatorios || []).filter((r) => !r.enviado || r.fecha >= limite);
  });
}
export function startRecordatoriosScheduler() {
  setInterval(() => enviarRecordatoriosVencidos().catch((e) => console.warn('[recordatorios]', e.message)), 60 * 1000);
}

// ======================================================================
// D6 — AVISOS AL ABRIR EL CHAT
// ======================================================================
export function avisosDeHoy(usuario, data = load()) {
  const r = resumenSemana(usuario, data, { dias: 1 });
  const ahora = ahoraChile();
  const recs = recordatoriosPendientes(usuario, data).filter((x) => x.fecha === ahora.fecha);
  const partes = [];
  if (r.totales.atrasados) partes.push(`**${r.totales.atrasados}** compromiso${r.totales.atrasados === 1 ? '' : 's'} atrasado${r.totales.atrasados === 1 ? '' : 's'}`);
  if (r.totales.solicitudes) partes.push(`**${r.totales.solicitudes}** solicitud${r.totales.solicitudes === 1 ? '' : 'es'} de entrevista por confirmar`);
  if (r.totales.sinMarcar) partes.push(`**${r.totales.sinMarcar}** entrevista${r.totales.sinMarcar === 1 ? '' : 's'} pasada${r.totales.sinMarcar === 1 ? '' : 's'} sin marcar`);
  const hoyAgenda = r.totales.entrevistas + r.totales.actividades + recs.length;
  if (!partes.length && !hoyAgenda) return null;
  const opciones = [];
  if (hoyAgenda) opciones.push({ label: '📅 ¿Qué tengo hoy?', value: '¿qué tengo hoy?' });
  if (r.totales.atrasados) opciones.push({ label: '✅ Ver mis compromisos', value: '¿qué compromisos tengo esta semana?' });
  if (r.totales.solicitudes) opciones.push({ label: '📥 Ver solicitudes', value: 'mis pendientes' });
  const texto = `👋 Antes de empezar:${partes.length ? ` tienes ${partes.join(', ')}.` : ''}${hoyAgenda ? ` Hoy tienes ${[r.totales.entrevistas && `${r.totales.entrevistas} entrevista${r.totales.entrevistas === 1 ? '' : 's'}`, r.totales.actividades && `${r.totales.actividades} actividad${r.totales.actividades === 1 ? '' : 'es'}`, recs.length && `${recs.length} recordatorio${recs.length === 1 ? '' : 's'}`].filter(Boolean).join(', ')}.` : ''}`;
  return { texto, opciones };
}

// Recordatorios de hoy, para sumarlos a "¿qué tengo hoy?".
export function recordatoriosComoItems(usuario, data, desde, hasta) {
  return recordatoriosPendientes(usuario, data).filter((r) => r.fecha >= desde && r.fecha <= hasta)
    .map((r) => ({ tipo: 'recordatorio', titulo: r.texto, fecha: r.fecha, hora: r.hora, org: 'Recordatorio', color: null }));
}

// "Aracena Gajardo, Gabriel Patricio" → "Gabriel Aracena" / "Gabriel Patricio Aracena Gajardo".
function nombreNatural(n) { const [ap, no] = String(n).split(','); return no ? `${no.trim()} ${ap.trim()}` : String(n); }
function nombreCorto(n) { const [ap, no] = String(n).split(','); return no ? `${no.trim().split(' ')[0]} ${ap.trim().split(' ')[0]}` : String(n).split(' ').slice(0, 2).join(' '); }

// ======================================================================
// D7 — ¿A QUIÉN ENTREVISTAR? (desde el Enfoque Ministración)
// ======================================================================
function sugerirEntrevistas(usuario, data, hoyObj) {
  const hombres = isMinisteringFocusLeaderHombres(usuario, data);
  const mujeres = isMinisteringFocusLeaderMujeres(usuario, data);
  if (!hombres && !mujeres) return resp('🔒 Las sugerencias salen del **Enfoque Ministración**, que ven el Obispado y las presidencias de Cuórum de Élderes y Sociedad de Socorro.');
  const hace90 = toISO(sumarDias(hoyObj, -90));
  const hoy = toISO(hoyObj);
  const porId = new Map((data.directoryMembers || []).map((m) => [m.id, m]));
  const clave = (s) => palabrasDe(s).sort().join(' ');
  const candidatos = [];
  for (const f of data.pastoralFocus || []) {
    const m = porId.get(f.memberId);
    if (!m || !f.asistencia) continue;
    if (!((hombres && isAdultMale(m)) || (mujeres && isAdultFemale(m)))) continue;
    const cuadrante = computeCuadrante(f);
    if (cuadrante === 'Retener') continue;
    const faltas = [!f.tieneLlamamiento && 'un llamamiento', !f.recomendacionVigente && 'la recomendación del templo', f.faltaConvenio && 'un convenio'].filter(Boolean);
    const suyas = (data.interviews || []).filter((iv) => Number(iv.memberDirectoryId) === m.id || (!iv.memberDirectoryId && clave(iv.memberName || '') === clave(m.name)));
    const agendada = suyas.some((iv) => (iv.status || 'scheduled') === 'scheduled' && iv.date >= hoy);
    if (agendada) continue;
    const reciente = suyas.some((iv) => iv.status === 'done' && iv.date >= hace90);
    // Prioridad: a un solo paso de Retener > asiste (Enfoque) > Actividad > Rescatar; sin entrevista reciente suma.
    let puntaje = { Enfoque: 30, Actividad: 20, Rescatar: 10 }[cuadrante] || 0;
    if (cuadrante === 'Enfoque' && faltas.length === 1) puntaje += 40;
    if (!reciente) puntaje += 15;
    if (f.asistencia === 'Alto') puntaje += 5;
    const porque = cuadrante === 'Enfoque' && faltas.length === 1
      ? `asiste y solo le falta ${faltas[0]} para pasar a Retener`
      : cuadrante === 'Enfoque' ? `asiste; le falta ${faltas.join(' y ')}`
        : cuadrante === 'Actividad' ? 'cumple todo pero asiste poco: una visita puede ayudar'
          : `asiste poco y le falta ${faltas.join(' y ') || 'acompañamiento'}`;
    candidatos.push({ m, cuadrante, puntaje, porque: `${porque}${reciente ? '' : ' · sin entrevista en los últimos 3 meses'}` });
  }
  if (!candidatos.length) return resp('🎉 No encontré a nadie pendiente: todos los evaluados están en Retener o ya tienen una entrevista agendada.');
  const top = candidatos.sort((a, b) => b.puntaje - a.puntaje).slice(0, 3);
  return resp(`🤝 Según el **Enfoque Ministración**, te sugiero priorizar a:\n\n${top.map((c, i) => `**${i + 1}. ${c.m.name}** (${c.cuadrante}) — ${c.porque}.`).join('\n')}\n\n¿Agendo una entrevista con alguno?`, {
    opciones: top.map((c) => ({ label: `📅 Entrevista con ${nombreCorto(c.m.name)}`, value: `agenda una entrevista con ${nombreNatural(c.m.name)}` })),
  });
}

// ======================================================================
// D9 — BUSCAR EN ACTAS ANTIGUAS
// ======================================================================
async function buscarEnActas(mensaje, norm, usuario, data, historial, breve) {
  if (!LIDERES.includes(usuario.role)) return resp('🔒 Las actas las ven los líderes y secretarios.');
  const q = norm.replace(/^.*?\b(acordamos|decidimos|quedamos|se acordo|se decidio|dijimos|acuerdos?|actas|hablamos|vimos|tratamos)\b/, '');
  const palabras = [...new Set(palabrasDe(q).filter((w) => w.length >= 4 && !STOP.has(w) && !['sobre', 'reunion', 'consejo', 'acta', 'actas'].includes(w)))];
  if (!palabras.length) return resp('¿Sobre qué tema busco? Por ejemplo: "¿qué acordamos sobre la noche de hogar misional?"');
  const raiz = (w) => w.slice(0, Math.max(4, w.length - 2));
  const coincide = (txt) => { const p = palabrasDe(txt || ''); return palabras.filter((w) => p.some((x) => x.startsWith(raiz(w)))).length; };
  const hallazgos = [];
  for (const m0 of data.meetings || []) {
    if (!canSeeMeetingRecord(usuario, m0, data)) continue;
    const m = withMeetingInfo(m0, data, usuario);
    if (m.contentRedacted) continue;
    for (const a of m.agendaItems || []) {
      const texto = [a.topic, a.notes, a.necesidad, a.analisis, a.acuerdo, a.seguimiento, a.queSeHara].filter(Boolean).join('. ');
      const n = coincide(texto);
      if (n) hallazgos.push({ n, m, tipo: 'tema', titulo: a.topic, detalle: a.acuerdo || a.seguimiento || a.queSeHara || a.notes || '' });
    }
    for (const c of m.commitments || []) {
      if (c.redacted) continue;
      const n = coincide(c.description);
      if (n) hallazgos.push({ n, m, tipo: 'compromiso', titulo: c.description, detalle: `${c.assignedToName} · ${c.status === 'completed' ? 'cumplido' : c.status === 'not_fulfilled' ? 'no cumplido' : `vence ${c.dueDate}`}` });
    }
  }
  if (!hallazgos.length) return resp(`🔎 No encontré nada en las actas sobre **${palabras.join(' ')}**.`);
  hallazgos.sort((a, b) => b.n - a.n || (b.m.date || '').localeCompare(a.m.date || ''));
  const top = hallazgos.slice(0, 6);
  const items = top.map((h) => ({ tipo: 'acta', titulo: h.titulo, fecha: h.m.date, hora: '', org: `${h.m.title}${h.detalle ? ` · ${h.detalle.slice(0, 80)}` : ''}`, color: h.m.organizationColor || null }));
  const contexto = top.map((h) => `[${h.m.date} · ${h.m.title}] ${h.tipo === 'tema' ? 'Tema' : 'Compromiso'}: ${h.titulo}${h.detalle ? ` — ${h.detalle}` : ''}`).join('\n');
  const sistema = `Eres Deseret. Responde la pregunta usando SOLO estos registros de actas (fecha · acta):\n${contexto}\n\nResponde en ${breve ? '1 frase' : '1 a 3 frases'}: qué se acordó y cuándo. No inventes nada; si los registros no responden la pregunta, dilo. Las tarjetas con los registros ya se muestran debajo.`;
  const r = await redactarConIA(sistema, historial, mensaje);
  return resp(r ? filtrarAlucinacion(r) : `🔎 Encontré **${hallazgos.length}** registro${hallazgos.length === 1 ? '' : 's'} en las actas (te muestro los más relevantes):`, { items });
}

// ======================================================================
// D15 — RESUMEN DE UNA ORGANIZACIÓN ("¿cómo va la Primaria este mes?")
// ======================================================================
async function resumenOrganizacion(mensaje, norm, usuario, data, hoyObj, historial, breve) {
  if (!LIDERES.includes(usuario.role)) return resp('🔒 Los resúmenes por organización son para líderes y secretarios.');
  const orgId = inferOrganizationId(norm, data.organizations || []);
  const org = orgPorId(data, orgId);
  if (!org) return resp('¿De qué organización? Por ejemplo: "¿cómo va la Primaria este mes?"');
  const ini = toISO(new Date(hoyObj.getFullYear(), hoyObj.getMonth(), 1, 12));
  const fin = toISO(new Date(hoyObj.getFullYear(), hoyObj.getMonth() + 1, 0, 12));
  const hoy = toISO(hoyObj);
  const mes = MESES_NOMBRE[hoyObj.getMonth()];
  const lineas = [];
  // Actividades
  const acts = (data.events || []).filter((e) => e.date >= ini && e.date <= fin && (Number(e.organizationId) === orgId || (e.involvedOrganizationIds || []).map(Number).includes(orgId)) && !e.isMeeting);
  lineas.push(`Actividades en ${mes}: ${acts.length} (${acts.filter((e) => e.date < hoy).length} ya realizadas, ${acts.filter((e) => e.date >= hoy).length} por venir)${acts.length ? ` — ${acts.slice(0, 4).map((e) => e.title).join(', ')}` : ''}`);
  // Compromisos de sus actas (solo si puede ver esas actas)
  const actas = (data.meetings || []).filter((m) => Number(m.organizationId) === orgId && canSeeMeetingRecord(usuario, m, data));
  if (actas.length) {
    const cs = actas.flatMap((m) => m.commitments || []);
    const pend = cs.filter((c) => c.status === 'pending');
    const atr = pend.filter((c) => c.dueDate && c.dueDate < hoy);
    const cumplidosMes = cs.filter((c) => c.status === 'completed' && (c.completedAt || '').slice(0, 10) >= ini);
    lineas.push(`Compromisos: ${pend.length} pendientes (${atr.length} atrasados), ${cumplidosMes.length} cumplidos este mes`);
    const ultima = actas.filter((m) => !m.sueltos).sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
    if (ultima) lineas.push(`Última reunión registrada: ${ultima.title} (${ultima.date})`);
  } else lineas.push('Actas: no hay actas registradas de esta organización que puedas ver.');
  // Entrevistas (mismos permisos que el módulo)
  if (usuario.role === 'admin' || orgSeesAllInterviews(usuario, data) || Number(usuario.organizationId) === orgId) {
    const ivs = (data.interviews || []).filter((iv) => Number(iv.organizationId) === orgId && iv.date >= ini && iv.date <= fin);
    if (ivs.length || canScheduleOrg(usuario, orgId)) lineas.push(`Entrevistas en ${mes}: ${ivs.filter((iv) => iv.status === 'done').length} realizadas, ${ivs.filter((iv) => (iv.status || 'scheduled') === 'scheduled' && iv.date >= hoy).length} agendadas`);
  }
  // Indicadores trimestrales relacionados (Crecimiento del Barrio)
  let extra = '';
  if (['admin', 'leader', 'ward_clerk'].includes(usuario.role)) {
    const c = contextoCrecimiento(normalizeSearchText(org.name), data);
    if (c?.contexto) extra = c.contexto;
  }
  const contexto = `ORGANIZACIÓN: ${org.name} — ${mes}\n${lineas.join('\n')}${extra ? `\n${extra}` : ''}`;
  const sistema = `Eres Deseret. Con SOLO estos datos, resume cómo va ${org.name} este mes.\n${contexto}\n\n${breve ? 'Máximo 2 frases, sin listas.' : 'Estructura: una conclusión en 1 frase, luego 3-4 viñetas con los números más importantes y, si algo está atrasado, una sugerencia práctica.'} No inventes datos. Tono cercano y constructivo.`;
  const r = await redactarConIA(sistema, historial, mensaje);
  return resp(r ? filtrarAlucinacion(r) : `📊 **${org.name} — ${mes}**\n\n${lineas.map((l) => `• ${l}`).join('\n')}`);
}

// ======================================================================
// D16 — EXPLICAR EL MANUAL GENERAL (base curada, con citas)
// ======================================================================
// Solo lo verificado en el Manual General (capítulos 21, 29 y 30); para
// cualquier otra cosa, Deseret lo dice y deja el enlace — nunca inventa.
const URL_MANUAL = 'https://www.churchofjesuschrist.org/study/manual/general-handbook?lang=spa';
const LLAMAMIENTOS = [
  { re: /\b(presidente del cuorum|presidente de(l)? elderes)\b/, n: 'Presidente del Cuórum de Élderes', r: 'la presidencia de estaca (en consulta con el obispo)', a: 'la presidencia de estaca y el sumo consejo', s: 'los miembros del barrio', l: 'el presidente de estaca' },
  { re: /\bconsejeros? del cuorum\b/, n: 'Consejeros de la presidencia del Cuórum de Élderes', r: 'el presidente del cuórum (en consulta con el obispo)', a: 'la presidencia de estaca y el sumo consejo', s: 'los miembros del barrio', l: 'el presidente de estaca, o un consejero o sumo consejero asignado' },
  { re: /\b(secretario del cuorum|instructor\w* del cuorum|otros llamamientos del cuorum)\b/, n: 'Otros llamamientos del Cuórum de Élderes (secretario, instructores, etc.)', r: 'la presidencia del cuórum', a: 'el obispado', s: 'los miembros del cuórum (en una reunión del cuórum)', l: 'el presidente del cuórum o un consejero asignado' },
  { re: /\bpresident[ea]s? de (la )?(sociedad de socorro|mujeres jovenes|primaria|escuela dominical)\b|\bpresident[ea]s? de (las )?organizaciones\b/, n: 'Presidentes de organizaciones del barrio (Sociedad de Socorro, Mujeres Jóvenes, Primaria y Escuela Dominical)', r: 'el obispado', a: 'el obispado', s: 'los miembros del barrio', l: 'el obispo' },
  { re: /\bconsejer[ao]s? de (la )?(sociedad de socorro|mujeres jovenes|primaria|escuela dominical|presidencia)\b/, n: 'Consejeros(as) en las presidencias de organizaciones del barrio', r: 'el presidente o la presidenta de la organización', a: 'el obispado', s: 'los miembros del barrio', l: 'el obispo o un consejero asignado' },
  { re: /\b(maestr[ao]s?|secretari[ao]s?|lider(es)?) de (la )?(sociedad de socorro|mujeres jovenes|primaria|escuela dominical)\b/, n: 'Otros llamamientos de Sociedad de Socorro, Mujeres Jóvenes, Primaria y Escuela Dominical (maestros, secretarias, etc.)', r: 'la presidencia de la organización', a: 'el obispado', s: 'los miembros del barrio', l: 'el obispo o un consejero asignado' },
  { re: /\blider misional\b/, n: 'Líder misional de barrio', r: 'el obispado (en consulta con los presidentes del Cuórum de Élderes y la Sociedad de Socorro)', a: 'el obispado', s: 'los miembros del barrio', l: 'el obispo o un consejero asignado' },
  { re: /\bmisioneros? de barrio\b/, n: 'Misioneros de barrio', r: 'el obispado, o los presidentes del Cuórum de Élderes y la Sociedad de Socorro', a: 'el obispado', s: 'los miembros del barrio', l: 'el obispo o un consejero asignado' },
  { re: /\b(templo e historia familiar|historia familiar)\b/, n: 'Líder de templo e historia familiar del barrio', r: 'el obispado (en consulta con los presidentes del Cuórum de Élderes y la Sociedad de Socorro)', a: 'el obispado', s: 'los miembros del barrio', l: 'el obispo o un consejero asignado' },
  { re: /\bsecretario de barrio\b/, n: 'Secretario de barrio (y ayudantes)', r: 'el obispado', a: 'la presidencia de estaca y el sumo consejo', s: 'los miembros del barrio', l: 'el presidente de estaca, o un consejero o sumo consejero asignado' },
  { re: /\bsecretario ejecutivo\b/, n: 'Secretario ejecutivo de barrio (y ayudantes)', r: 'el obispado', a: 'la presidencia de estaca y el sumo consejo', s: 'los miembros del barrio', l: 'el presidente de estaca, o un consejero o sumo consejero asignado' },
  { re: /\bconsejeros? del obispado\b/, n: 'Consejeros del obispado', r: 'el obispo', a: 'la presidencia de estaca y el sumo consejo', s: 'los miembros del barrio', l: 'el presidente de estaca o un consejero asignado' },
];
const TEMAS_MANUAL = [
  { re: /\b(reunion de obispado)\b/, t: '**Reunión de obispado** (Manual General 29.2.4): asisten el obispado, el secretario de barrio y el secretario ejecutivo; la preside el obispo. Se realiza **por lo general cada semana**.' },
  { re: /\b(consejo de barrio)\b/, t: '**Consejo de barrio** (Manual General 29.2.5): lo integran el obispado, el secretario de barrio, el secretario ejecutivo y los presidentes del Cuórum de Élderes, Sociedad de Socorro, Mujeres Jóvenes, Primaria y Escuela Dominical. El obispo lo planifica, preside y dirige. Se reúne **por lo general cada semana** (puede ser con menos frecuencia).' },
  { re: /\b(consejo de (la )?juventud)\b/, t: '**Consejo de la juventud del barrio** (Manual General 29.2.6): obispado, presidencias de quórum y de clase, y la presidenta de Mujeres Jóvenes. Se reúne **por lo general cada mes**.' },
  { re: /\b(entrevistas? de ministracion)\b/, t: '**Entrevistas de ministración** (Manual General 21.3): se realizan **al menos una vez por trimestre**. Las hacen el presidente del Cuórum de Élderes y sus consejeros (con los hermanos ministrantes) y la presidenta de la Sociedad de Socorro y sus consejeras (con las hermanas ministrantes). De preferencia, en persona y con ambos compañeros. Las asignaciones y compañerismos se presentan al **obispo para su aprobación** (21.2.1).' },
  { re: /\bsacramental\b/, t: '**Reunión sacramental** (Manual General 29.2.1): se realiza cada domingo y la preside el obispo, salvo que asista un miembro de la presidencia de estaca.' },
  { re: /\b(relevar|relevo|relevos)\b/, t: '**Relevos** (Manual General 30.6): la sección 30.6 explica cómo se releva a las personas de sus llamamientos. Te recomiendo leerla directamente en el Manual.' },
  { re: /\b(sostener|sostenimiento)\b/, t: '**Sostenimiento** (Manual General 30.3) y **apartamiento** (30.4): la tabla 30.8 indica quién sostiene y quién aparta en cada llamamiento. Pregúntame por uno en particular, por ejemplo: "¿quién aparta a la presidenta de la Primaria?"' },
];
function explicarManual(norm) {
  const ll = LLAMAMIENTOS.find((x) => x.re.test(norm));
  if (ll) {
    return resp(`📖 **${ll.n}** (Manual General, tabla 30.8):\n\n• **Lo recomienda:** ${ll.r}\n• **Lo aprueba:** ${ll.a}\n• **Lo sostienen:** ${ll.s}\n• **Lo llama y aparta:** ${ll.l}\n\nMás detalle en las secciones 30.2 (extender llamamientos), 30.3 (sostenimiento) y 30.4 (apartamiento).`);
  }
  const t = TEMAS_MANUAL.find((x) => x.re.test(norm));
  if (t) return resp(`📖 ${t.t}`);
  return resp(`📖 Eso no lo tengo en mi base verificada del Manual General, y prefiero no adivinar en temas de normas de la Iglesia. Puedes buscarlo aquí: ${URL_MANUAL}\n\nSí puedo responderte, con cita: quién recomienda, aprueba, sostiene y aparta cada llamamiento del barrio (tabla 30.8), las reuniones de obispado, de consejo de barrio y de juventud, las entrevistas de ministración, y qué entrevistas hace solo el obispo.`);
}

// ======================================================================
// D3 — DICTAR UN ACTA COMPLETA
// ======================================================================
const TIPOS_ACTA = { general: 'Reunión general / de presidencia', consejo_barrio: 'Consejo de barrio', coordinacion_ministracion: 'Coordinación de ministración' };
async function dictarActa({ mensaje, mensajeMin, usuario, data, hoyObj, borrador }) {
  if (!['admin', 'leader', 'ward_clerk'].includes(usuario.role)) return resp('🔒 Las actas las registran los líderes, el secretario de barrio y el Administrador.');
  const d = borrador ? { ...borrador.datos } : { plus: 'dictar', partes: [] };
  const falta = borrador?.falta || null;
  const norm = normalizeSearchText(mensaje);
  const OPC_DICTADO = [{ label: '✅ Listo, ordénala', value: 'listo' }, { label: '❌ Cancelar', value: 'cancelar' }];

  if (!falta) {
    const cuerpo = mensaje.replace(/^.*?\bacta\b\s*(de la reuni[oó]n|de hoy|del consejo)?\s*[:,.-]?\s*/i, '').trim();
    if (cuerpo.length > 60) d.partes.push(cuerpo);
    if (!d.partes.length) {
      guardarBorrador(usuario, 'plus', d, 'dictado');
      return resp('🎙️ Te escucho. Dicta la reunión: **qué reunión fue**, **de qué se habló**, **qué se acordó** y los **compromisos** (quién, qué y para cuándo). Puedes hacerlo en varias partes; cuando termines, di **"listo"**. ¿Empezamos?', { opciones: OPC_DICTADO });
    }
    guardarBorrador(usuario, 'plus', d, 'dictado');
    return resp('📝 Anotado. ¿Algo más? Cuando termines, di **"listo"**.', { opciones: OPC_DICTADO });
  }

  if (falta === 'dictado') {
    if (/^\s*(listo|termine|eso es todo|eso seria|ya esta|fin|ordenala|ordena)\b/.test(norm)) {
      if (!d.partes.length) { guardarBorrador(usuario, 'plus', d, 'dictado'); return resp('Todavía no me has dictado nada. ¿Qué se trató en la reunión?', { opciones: OPC_DICTADO }); }
      return estructurarActa(d, usuario, data, hoyObj);
    }
    d.partes.push(mensaje.trim());
    guardarBorrador(usuario, 'plus', d, 'dictado');
    return resp('📝 Anotado. ¿Algo más? Cuando termines, di **"listo"**.', { opciones: OPC_DICTADO });
  }

  if (falta === 'confirmar') {
    if (/^\s*(no|cancel\w*)\b/.test(norm)) { borrarBorrador(usuario); return resp('👌 No guardé el acta.'); }
    if (/\bsigue|agrega|falto|me falto|olvide\b/.test(norm)) {
      guardarBorrador(usuario, 'plus', { ...d, acta: null }, 'dictado');
      return resp('Dale, sigue dictando lo que faltó. Cuando termines, di **"listo"**.', { opciones: OPC_DICTADO });
    }
    if (!ES_AFIRMATIVO.test(mensajeMin)) {
      guardarBorrador(usuario, 'plus', d, 'confirmar');
      return resp('¿La guardo así? Di **sí** para guardarla, **"me faltó algo"** para seguir dictando, o **no** para descartarla.', { opciones: [...OPCIONES_CONFIRMAR, { label: '➕ Me faltó algo', value: 'me faltó algo' }] });
    }
    borrarBorrador(usuario);
    return guardarActa(d.acta, usuario);
  }
  borrarBorrador(usuario);
  return resp('No entendí. Vuelve a pedirme "dictar acta" cuando quieras.');
}

// Texto (dictado o transcripción de una reunión grabada) → acta validada:
// { titulo, tipo, fecha, temas[], compromisos[] } con los responsables ya
// buscados entre las personas asignables. La usan el dictado por chat y el
// modo "Deseret escucha la reunión" (routes/escucha.js).
export async function ordenarActa(texto, usuario, data, hoyObj, { transcripcion = false } = {}) {
  const asignables = assignableUsersFor(usuario, data);
  const obispado = isObispadoLeader(usuario, data);
  const origen = transcripcion
    ? `la TRANSCRIPCIÓN AUTOMÁTICA de una reunión grabada (puede tener errores de reconocimiento, frases cortadas y varias personas hablando; quien preside suele resumir los acuerdos y asignar los compromisos). Agrupa lo conversado en temas; ignora saludos, oraciones de apertura/cierre y conversación sin relación`
    : 'un dictado';
  const sistema = `Ordenas el acta de una reunión de un barrio de La Iglesia (Chile) a partir de ${origen}. Hoy es ${toISO(hoyObj)}.
Devuelve SOLO un JSON con esta forma:
{"titulo": "...", "tipo": "general|consejo_barrio|coordinacion_ministracion", "fecha": "AAAA-MM-DD (hoy si no la dijo)",
 "temas": [{"tema": "título corto", "notas": "de qué se habló (breve)", "acuerdo": "qué se acordó, o vacío"}],
 "compromisos": [{"responsable": "nombre tal como lo dijo, o 'yo'", "descripcion": "qué hará", "fecha_limite": "AAAA-MM-DD o vacío"}]}
Reglas: no inventes nada que no se haya dicho; un compromiso es algo que una persona concreta quedó en hacer; si no se dijo fecha límite, déjala vacía. "El sábado" = el próximo sábado desde hoy.
Personas que se pueden asignar: ${asignables.map((u) => u.name).join(', ')}.`;
  let acta = await jsonConIA(sistema, texto.slice(0, transcripcion ? 120000 : 20000));
  if (!acta || typeof acta !== 'object') acta = actaSinIA(texto, hoyObj);
  // Validar y resolver responsables.
  const fechaOk = (f) => (typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f) ? f : null);
  const tipo = TIPOS_ACTA[acta.tipo] && (acta.tipo === 'general' || obispado) ? acta.tipo : 'general';
  const fechaActa = fechaOk(acta.fecha) || toISO(hoyObj);
  const temas = (Array.isArray(acta.temas) ? acta.temas : []).filter((t) => t && String(t.tema || '').trim()).slice(0, 20)
    .map((t) => ({ tema: String(t.tema).trim().slice(0, 150), notas: String(t.notas || '').trim().slice(0, 800), acuerdo: String(t.acuerdo || '').trim().slice(0, 500) }));
  const compromisos = (Array.isArray(acta.compromisos) ? acta.compromisos : []).filter((c) => c && String(c.descripcion || '').trim()).slice(0, 20).map((c) => {
    const nombre = String(c.responsable || '').trim();
    let u = null;
    if (/^(yo|mi|m[ií])$/i.test(nombre)) u = usuario;
    else if (nombre) { const cand = asignables.filter((x) => coincideNombre(nombre, x.name)); if (cand.length === 1) [u] = cand; }
    const fecha = fechaOk(c.fecha_limite) || toISO(sumarDias(new Date(`${fechaActa}T12:00:00`), 7));
    return { userId: u?.id || usuario.id, nombre: u?.name || null, dicho: nombre, descripcion: String(c.descripcion).trim().slice(0, 300), fecha, sinFecha: !fechaOk(c.fecha_limite) };
  });
  return {
    titulo: String(acta.titulo || '').trim().slice(0, 100) || `Reunión del ${fechaLegible(fechaActa)}`,
    tipo, fecha: fechaActa, temas, compromisos, dictado: texto.slice(0, 5000),
  };
}

async function estructurarActa(d, usuario, data, hoyObj) {
  d.acta = await ordenarActa(d.partes.join('\n'), usuario, data, hoyObj);
  const { tipo, temas, compromisos } = d.acta; const fechaActa = d.acta.fecha;
  guardarBorrador(usuario, 'plus', d, 'confirmar');
  const filas = [
    ['📅', `${fechaLegible(fechaActa)} · ${TIPOS_ACTA[tipo]}`],
    ...temas.slice(0, 8).map((t, i) => [`${i + 1}.`, `${t.tema}${t.acuerdo ? ` → ${t.acuerdo}` : ''}`]),
    ...(temas.length > 8 ? [['…', `y ${temas.length - 8} temas más`]] : []),
    ...compromisos.map((c) => ['🎯', `${c.nombre || `${c.dicho || '¿?'} (no lo encontré: queda a tu nombre)`}: ${c.descripcion} · ${c.sinFecha ? 'en 1 semana' : `para el ${fechaLegible(c.fecha)}`}`]),
  ];
  const sinResolver = compromisos.filter((c) => !c.nombre).length;
  return resp(`📋 Así quedaría el acta (**${temas.length}** tema${temas.length === 1 ? '' : 's'} y **${compromisos.length}** compromiso${compromisos.length === 1 ? '' : 's'}).${sinResolver ? ` ${sinResolver === 1 ? 'Un responsable no lo encontré' : `${sinResolver} responsables no los encontré`} entre quienes puedes asignar: esos compromisos quedan a tu nombre, con el nombre en la descripción.` : ''} ¿La guardo?`, {
    tarjeta: { tipo: 'acta', titulo: d.acta.titulo, color: null, filas },
    opciones: [...OPCIONES_CONFIRMAR, { label: '➕ Me faltó algo', value: 'me faltó algo' }],
  });
}

// Sin IA: cada oración con "se compromete / va a / queda en / se encarga"
// es un compromiso; el resto, notas de un único tema.
function actaSinIA(texto, hoyObj) {
  const oraciones = texto.split(/(?<=[.!?\n])\s+/).map((s) => s.trim()).filter(Boolean);
  const compromisos = []; const notas = []; const acuerdos = [];
  let titulo = '';
  // La primera frase corta que nombra la reunión es el título.
  if (oraciones[0] && oraciones[0].split(/\s+/).length <= 6 && /\b(consejo|reuni[oó]n|presidencia|comit[eé]|coordinaci[oó]n|obispado)\b/i.test(oraciones[0])) titulo = oraciones.shift().replace(/[.!]+$/, '');
  for (const o of oraciones) {
    const ac = o.match(/^(?:se )?(?:acord[oó]|decidi[oó]|acordamos|decidimos)(?: que)?\s+(.+)$/i);
    if (ac) { acuerdos.push(ac[1].replace(/[.!]+$/, '')); continue; }
    const m = o.match(/^(?:el |la |los |las |hno\.? |hna\.? |hermano |hermana )?([A-ZÁÉÍÓÚÑ][\wáéíóúñ]+(?: [A-ZÁÉÍÓÚÑ][\wáéíóúñ]+)?)\s+(?:se compromete a|va a|queda en|se encarga de|se encargar[áa] de|tiene que|debe)\s+(.+)$/);
    if (m) {
      const descripcion = m[2].replace(/\s+(para|antes del?|hasta)\s+(el\s+)?(\d{1,2}\s+de\s+[a-záéíóúñ]+|(pr[oó]ximo\s+)?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)|ma[ñn]ana)\b.*$/i, '').replace(/[.!]+$/, '');
      compromisos.push({ responsable: m[1], descripcion, fecha_limite: parseFecha(o.toLowerCase(), hoyObj) || '' });
    } else notas.push(o);
  }
  const tipo = /consejo de barrio/i.test(titulo) ? 'consejo_barrio' : /coordinaci[oó]n de ministraci[oó]n/i.test(titulo) ? 'coordinacion_ministracion' : 'general';
  const temas = notas.length || acuerdos.length ? [{ tema: 'Temas tratados', notas: notas.join(' '), acuerdo: acuerdos.join('; ') }] : [];
  return { titulo, tipo, fecha: toISO(hoyObj), temas, compromisos };
}

async function guardarActa(acta, usuario) {
  if (!acta) return resp('No encontré el acta para guardar. Vuelve a dictarla.');
  const m = await guardarActaCore(acta, usuario);
  return resp(`✅ Guardé el acta **«${m.title}»** con ${m.agendaItems.length} tema${m.agendaItems.length === 1 ? '' : 's'} y ${m.commitments.length} compromiso${m.commitments.length === 1 ? '' : 's'}. La encuentras en **Reuniones y Consejos**, y a cada responsable le aparece su compromiso en *Mis Asignaciones*.`);
}

// Crea el acta (reunión + temas + compromisos) y la devuelve.
export async function guardarActaCore(acta, usuario, extra = {}) {
  const now = new Date();
  const hora = new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  const m = await withDb((db) => {
    const meeting = {
      id: nextId(db, 'meetings'), title: acta.titulo, date: acta.fecha, startTime: hora, endTime: null,
      type: acta.tipo, confidential: false, organizationId: usuario.organizationId || null, status: 'active',
      createdBy: usuario.id, createdAt: now.toISOString(), archivedAt: null, lastEditedBy: null, lastEditedAt: null,
      councilPrepReminderSent: false, dictadoConDeseret: true, ...extra,
      agendaItems: acta.temas.map((t) => ({
        id: nextId(db, 'agendaItems'), topic: t.tema, presenter: '', ...EMPTY_AGENDA_ITEM_NOTES,
        ...(acta.tipo === 'consejo_barrio' ? { analisis: t.notas, acuerdo: t.acuerdo } : { notes: [t.notas, t.acuerdo && `Acuerdo: ${t.acuerdo}`].filter(Boolean).join('\n') }),
      })),
      commitments: acta.compromisos.map((c) => ({
        id: nextId(db, 'commitments'), description: c.nombre || !c.dicho ? c.descripcion : `(${c.dicho}) ${c.descripcion}`,
        dueDate: c.fecha, assignedToUserId: c.userId, groupId: null, confidential: false, priority: 'media',
        status: 'pending', completedAt: null, completionComment: '', whatsappDueTodaySent: false, reassignHistory: [],
      })),
    };
    db.meetings.push(meeting);
    return meeting;
  });
  vaciarCache();
  return m;
}

// Para "¿qué tengo hoy?" leído en voz: frase natural con la agenda del día.
export function fraseAgendaHablada(items) {
  if (!items.length) return '';
  return items.slice(0, 6).map((x) => {
    const que = { entrevista: 'entrevista con', actividad: 'actividad:', compromiso: 'compromiso:', recordatorio: 'recordatorio:', solicitud: 'solicitud de', aseo: 'aseo:' }[x.tipo] || '';
    return `${x.hora ? `a las ${x.hora}, ` : ''}${que} ${x.titulo}`.trim();
  }).join('; ');
}
export { resumenSemana, fraseResumen };
