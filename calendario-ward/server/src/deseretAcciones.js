// ----------------------------------------------------------------------
// DESERET — ACCIONES (puntos 1 y 2 de la segunda lista de mejoras)
// ----------------------------------------------------------------------
// Además de agendar, Deseret puede:
//   • reprogramar una entrevista        ("pasa la entrevista de Jaime al jueves a las 20:00")
//   • cancelar una entrevista           ("cancela la entrevista con Jaime")
//   • marcar una entrevista hecha / no  ("marca como hecha la entrevista de Jaime")
//   • confirmar / rechazar solicitudes  ("confirma la solicitud de Jaime")
//   • completar un compromiso propio    ("completé el compromiso de visitar a los Pérez")
//   • crear un compromiso               ("anota un compromiso para el hno. Soto: visitar a la familia Pérez el domingo")
//
// Reglas comunes (las mismas de la app, nunca más permisivas):
//   - Solo se ofrecen registros que la persona puede ver y modificar con las
//     mismas funciones de permisos de las rutas (canScheduleOrg, canDecideFor…).
//   - Si hay más de un candidato, se ofrecen como botones para elegir.
//   - SIEMPRE se muestra una tarjeta de confirmación antes de cambiar algo.
//   - Se envían los mismos avisos (email / WhatsApp) que cuando se hace
//     desde la pantalla correspondiente.
// ----------------------------------------------------------------------
import { load, withDb, nextId } from './db.js';
import { canScheduleOrg } from './routes/interviews.js';
import { assignableUsersFor } from './routes/meetings.js';
import { isObispadoLeader } from './routes/stake.js';
import {
  sendCancellationEmail, sendRescheduleEmail, sendInterviewCancelledWhatsApp,
  sendInterviewRescheduledWhatsApp, sendInterviewScheduledWhatsApp,
} from './notifications.js';
import {
  resp, fechaLegible, parseFecha, parseHora, normalizeSearchText, palabrasDe,
  guardarBorrador, borrarBorrador, OPCIONES_CONFIRMAR, ES_AFIRMATIVO, vaciarCache,
  toISO, opcionesFecha, OPCIONES_HORA, orgPorId, sumarDias, inferOrganizationId,
} from './chat.js';

// ---------------- Detección por reglas (sin IA) ----------------
// El orden importa: "confirma la solicitud" antes que "confirma".
const REGLAS = [
  ['rechazar_solicitud', /\b(rechaz\w*|declin\w*)\b.*\bsolicitud/],
  ['confirmar_solicitud', /\b(confirm\w*|acept\w*|aprueb\w*|aprob\w*)\b.*\bsolicitud/],
  ['cancelar_entrevista', /\b(cancel\w*|anul\w*|suspend\w*|elimin\w*|borr\w*)\b.*\bentrevista/],
  ['reprogramar_entrevista', /\b(reprogram\w*|cambi\w*|mueve|muev\w*|mover|pasa|pasar|posterg\w*|adelant\w*|corre|correr)\b.*\bentrevista/],
  ['marcar_entrevista', /(\b(marc\w*)\b.*\bentrevista|\bentrevista\b.*\b(se hizo|no se hizo|hecha|realizada)\b|\b(ya entreviste|no vino|no llego|no se pudo)\b)/],
  ['crear_compromiso', /\b(anot\w*|cre\w*|agreg\w*|registr\w*|asign\w*|nuevo)\b.*\bcompromiso/],
  ['completar_compromiso', /(\b(complet\w*|cumpl\w*|termin\w*)\b.*\bcompromiso|\bcompromiso\b.*\b(listo|hecho|completado|cumplido)\b|\bmarc\w*\b.*\bcompromiso)/],
];

export function detectarAccion(norm) {
  for (const [accion, re] of REGLAS) if (re.test(norm)) return accion;
  return null;
}

// Herramientas para la IA (se suman a las de agendar en chat.js).
export const HERRAMIENTAS_ACCIONES = [
  { name: 'reprogramar_entrevista', description: 'Cambiar la fecha y/o la hora de una entrevista YA agendada.', props: { nombre: 'Persona entrevistada', fecha: 'Nueva fecha AAAA-MM-DD, si la dijo', hora: 'Nueva hora HH:MM 24h, si la dijo' } },
  { name: 'cancelar_entrevista', description: 'Cancelar una entrevista ya agendada.', props: { nombre: 'Persona entrevistada', motivo: 'Motivo, si lo dijo' } },
  { name: 'marcar_entrevista', description: 'Marcar una entrevista como realizada o no realizada.', props: { nombre: 'Persona entrevistada', resultado: 'hecha | no_hecha', comentario: 'Comentario, si lo dijo' } },
  { name: 'confirmar_solicitud', description: 'Confirmar una solicitud de entrevista pendiente.', props: { nombre: 'Quién pidió la entrevista', hora: 'Hora HH:MM si quiere cambiarla' } },
  { name: 'rechazar_solicitud', description: 'Rechazar una solicitud de entrevista pendiente.', props: { nombre: 'Quién pidió la entrevista', motivo: 'Motivo, si lo dijo' } },
  { name: 'completar_compromiso', description: 'Marcar como completado un compromiso propio.', props: { texto: 'Palabras clave del compromiso', comentario: 'Comentario, si lo dijo' } },
  { name: 'crear_compromiso', description: 'Registrar un compromiso nuevo para alguien.', props: { responsable: 'Nombre del responsable ("yo" si es para sí mismo)', descripcion: 'Qué tiene que hacer', fecha_limite: 'AAAA-MM-DD, si la dijo', reunion: 'Dónde anotarlo, SOLO si lo dijo: nombre del acta/reunión, "nueva" o "ninguna" (compromiso suelto, sin reunión)' } },
].map((h) => ({
  type: 'function',
  function: {
    name: h.name,
    description: h.description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(h.props).map(([k, d]) => [k, k === 'resultado'
        ? { type: 'string', enum: ['hecha', 'no_hecha'], description: d }
        : { type: 'string', description: d }])),
    },
  },
}));

// ---------------- Utilidades ----------------
const STOP = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'con', 'a', 'al', 'hermano', 'hermana', 'hno', 'hna', 'para', 'y', 'que', 'mi', 'su']);
function coincideNombre(buscado, nombre) {
  const b = palabrasDe(buscado).filter((w) => w.length > 1 && !STOP.has(w));
  if (!b.length) return false;
  const p = palabrasDe(nombre);
  return b.every((w) => p.some((x) => x === w || (w.length >= 3 && x.startsWith(w))));
}

// "…entrevista de/con/a Jaime Cuenca el jueves…" → "Jaime Cuenca"
function nombreDesdeFrase(mensaje, palabraClave) {
  const re = new RegExp(`${palabraClave}\\w*\\s+(?:de|con|a|del|para)\\s+(?:la\\s+|el\\s+)?([A-ZÁÉÍÓÚÑa-záéíóúñ.'\\- ]+?)(?=\\s+(?:el|al|para|a las?|hoy|ma[ñn]ana|pasado|este|esta|pr[oó]xim\\w*|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|como|porque|ya|no|se)\\b|[.,:;]|$)`, 'i');
  const m = mensaje.match(re);
  return m ? m[1].trim() : null;
}

// La fecha/hora NUEVA de un "pasa la del jueves al viernes": se busca
// después de la última " al " / " para el ".
function parteNueva(mensajeMin) {
  const i = Math.max(mensajeMin.lastIndexOf(' al '), mensajeMin.lastIndexOf(' para el '), mensajeMin.lastIndexOf(' para '));
  return i >= 0 ? mensajeMin.slice(i) : mensajeMin;
}

function tarjetaEntrevista(g, data, titulo, extraFilas = []) {
  const org = orgPorId(data, g.organizationId);
  return {
    tipo: 'entrevista',
    titulo,
    color: org?.color || null,
    filas: [['🙋', g.nombres], ['📅', `${fechaLegible(g.date)} · ${g.startTime}`], ['🏷️', org?.name || ''], ...extraFilas],
  };
}

// Entrevistas agendadas (futuras o de los últimos 14 días, para poder
// marcarlas) que esta persona puede modificar, agrupadas por reunión.
function entrevistasEditables(usuario, data, hoyISO, incluirPasadas) {
  const desde = incluirPasadas ? toISO(sumarDias(new Date(`${hoyISO}T12:00:00`), -14)) : hoyISO;
  const grupos = new Map();
  for (const iv of data.interviews || []) {
    if ((iv.status || 'scheduled') !== 'scheduled' || iv.date < desde) continue;
    if (!canScheduleOrg(usuario, iv.organizationId)) continue;
    const g = grupos.get(iv.groupId) || { groupId: iv.groupId, date: iv.date, startTime: iv.startTime, organizationId: iv.organizationId, rows: [] };
    g.rows.push(iv);
    grupos.set(iv.groupId, g);
  }
  return [...grupos.values()].map((g) => ({ ...g, nombres: g.rows.map((r) => r.memberName).join(', ') }))
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
}

function canDecideFor(user, data, organizationId) {
  if (user.role === 'admin') return true;
  if (user.role === 'executive_secretary') return Number(user.organizationId) === Number(organizationId);
  if (user.role !== 'leader') return false;
  if (Number(user.organizationId) === Number(organizationId)) return true;
  return isObispadoLeader(user, data);
}

function misCompromisos(usuario, data) {
  const out = [];
  for (const m of data.meetings || []) {
    if (m.status !== 'active') continue;
    for (const c of m.commitments || []) {
      if (c.status === 'pending' && Number(c.assignedToUserId) === Number(usuario.id)) out.push({ c, m });
    }
  }
  return out.sort((a, b) => a.c.dueDate.localeCompare(b.c.dueDate));
}

// Elegir entre varios candidatos (botones) o seguir con el único.
function elegir(usuario, d, candidatos, texto, etiqueta) {
  d.candidatos = candidatos.slice(0, 6).map((x) => x.id);
  guardarBorrador(usuario, 'accion', d, 'elegir');
  return resp(texto, {
    opciones: [
      ...candidatos.slice(0, 6).map((x, i) => ({ label: `${i + 1}. ${etiqueta(x)}`, value: String(i + 1) })),
      { label: 'Cancelar', value: 'cancelar' },
    ],
  });
}

// ----------------------------------------------------------------------
// Punto de entrada: `accion` detectada (reglas o IA), `args` de la IA si hubo.
// `borrador` = continuación de una acción a medias.
// ----------------------------------------------------------------------
export async function manejarAccion({ accion, args = {}, mensaje, mensajeMin, usuario, hoyObj, borrador = null }) {
  if (!usuario) return resp('🔒 Necesitas haber iniciado sesión.');
  const data = load();
  const hoyISO = toISO(hoyObj);
  const d = borrador ? { ...borrador.datos } : { accion, args };
  const falta = borrador ? borrador.falta : null;
  accion = d.accion;

  // Respuesta a "¿cuál de estos?"
  if (falta === 'elegir') {
    const n = mensajeMin.match(/^\s*(\d{1,2})\b/);
    const id = n ? d.candidatos?.[Number(n[1]) - 1] : null;
    if (!id) {
      borrarBorrador(usuario);
      return resp('No entendí cuál. Vuelve a pedírmelo con un poco más de detalle (por ejemplo, el nombre completo o la fecha).');
    }
    d.elegido = id;
  }

  switch (accion) {
    case 'reprogramar_entrevista':
    case 'cancelar_entrevista':
    case 'marcar_entrevista':
      return accionEntrevista(d, falta, mensaje, mensajeMin, usuario, data, hoyObj, hoyISO);
    case 'confirmar_solicitud':
    case 'rechazar_solicitud':
      return accionSolicitud(d, falta, mensaje, mensajeMin, usuario, data);
    case 'completar_compromiso':
      return accionCompletarCompromiso(d, falta, mensaje, mensajeMin, usuario, data);
    case 'crear_compromiso':
      return accionCrearCompromiso(d, falta, mensaje, mensajeMin, usuario, data, hoyObj);
    default:
      borrarBorrador(usuario);
      return resp('No sé hacer eso todavía.');
  }
}

// ---------------- Entrevistas ----------------
async function accionEntrevista(d, falta, mensaje, mensajeMin, usuario, data, hoyObj, hoyISO) {
  const a = d.args || {};
  const verbo = { reprogramar_entrevista: 'reprogramar', cancelar_entrevista: 'cancelar', marcar_entrevista: 'marcar' }[d.accion];

  if (!d.elegido) {
    const lista = entrevistasEditables(usuario, data, hoyISO, d.accion === 'marcar_entrevista');
    if (!lista.length) { borrarBorrador(usuario); return resp('📭 No encontré entrevistas agendadas que puedas modificar.'); }
    const nombre = a.nombre || nombreDesdeFrase(mensaje, 'entrevista');
    let cand = nombre ? lista.filter((g) => g.rows.some((r) => coincideNombre(nombre, r.memberName))) : lista;
    if (nombre && !cand.length) { borrarBorrador(usuario); return resp(`🔎 No encontré una entrevista agendada con **${nombre}** que puedas ${verbo}.`); }
    // "la de mañana": si nombraron una fecha y hay varias, filtrar por esa fecha.
    const f = d.accion === 'reprogramar_entrevista' ? null : parseFecha(mensajeMin, hoyObj);
    if (f && cand.length > 1 && cand.some((g) => g.date === f)) cand = cand.filter((g) => g.date === f);
    if (cand.length > 1) {
      return elegir(usuario, d, cand.map((g) => ({ id: g.groupId, g })), `¿Cuál entrevista quieres ${verbo}?`,
        (x) => `${x.g.nombres} · ${fechaLegible(x.g.date)} ${x.g.startTime}`);
    }
    d.elegido = cand[0].groupId;
  }

  const g = entrevistasEditables(usuario, data, hoyISO, true).find((x) => x.groupId === d.elegido);
  if (!g) { borrarBorrador(usuario); return resp('Esa entrevista ya no está disponible (puede que otra persona la haya cambiado).'); }
  const preguntar = (f, texto, extra = {}) => { guardarBorrador(usuario, 'accion', d, f); return resp(texto, extra); };

  if (d.accion === 'reprogramar_entrevista') {
    if (!d.fecha && !d.hora) {
      const trozo = falta === 'elegir' ? '' : parteNueva(mensajeMin);
      d.fecha = (a.fecha && /^\d{4}-\d{2}-\d{2}$/.test(a.fecha) ? a.fecha : null) || (trozo ? parseFecha(trozo, hoyObj) : null);
      d.hora = (a.hora && /^\d{2}:\d{2}$/.test(a.hora) ? a.hora : null) || (trozo ? parseHora(trozo) : null);
    } else if (falta === 'fecha' || falta === 'hora') {
      d.fecha = d.fecha || parseFecha(mensajeMin, hoyObj);
      d.hora = parseHora(mensajeMin) || d.hora;
    }
    if (falta === 'confirmar') {
      if (ES_AFIRMATIVO.test(mensajeMin)) return ejecutarReprogramar(g, d, usuario);
      const f2 = parseFecha(mensajeMin, hoyObj); const h2 = parseHora(mensajeMin);
      if (f2) d.fecha = f2; if (h2) d.hora = h2;
    }
    if (!d.fecha && !d.hora) return preguntar('fecha', `📅 ¿Para qué día pasamos la entrevista con **${g.nombres}**? (hoy es ${fechaLegible(g.date)} a las ${g.startTime})`, { opciones: opcionesFecha(hoyObj) });
    const nuevaFecha = d.fecha || g.date; const nuevaHora = d.hora || g.startTime;
    if (nuevaFecha < toISO(hoyObj)) { d.fecha = null; return preguntar('fecha', '📅 Esa fecha ya pasó. ¿Para qué día la pasamos?', { opciones: opcionesFecha(hoyObj) }); }
    if (!d.hora && falta !== 'confirmar' && falta !== 'hora') {
      return preguntar('hora', `🕐 ¿A qué hora el ${fechaLegible(nuevaFecha)}? (hoy está a las ${g.startTime})`, { opciones: [{ label: `Misma hora (${g.startTime})`, value: `a las ${g.startTime}` }, ...OPCIONES_HORA] });
    }
    return preguntar('confirmar', '📝 ¿La reprogramo así? Se les avisará a los participantes.', {
      tarjeta: tarjetaEntrevista({ ...g, date: nuevaFecha, startTime: nuevaHora }, data, 'Reprogramar entrevista', [['↩️', `Antes: ${fechaLegible(g.date)} · ${g.startTime}`]]),
      opciones: OPCIONES_CONFIRMAR,
    });
  }

  if (d.accion === 'cancelar_entrevista') {
    if (falta === 'confirmar') {
      if (ES_AFIRMATIVO.test(mensajeMin)) return ejecutarCancelar(g, d, usuario);
      borrarBorrador(usuario);
      return resp('👌 No la cancelé.');
    }
    d.motivo = d.args?.motivo || (mensaje.match(/porque\s+(.+)$/i)?.[1] || '').trim();
    return preguntar('confirmar', '⚠️ ¿Cancelo esta entrevista? Quedará en el historial como "no se hizo" y se les avisará a los participantes.', {
      tarjeta: tarjetaEntrevista(g, data, 'Cancelar entrevista', d.motivo ? [['💬', d.motivo]] : []),
      opciones: [{ label: '✅ Sí, cancelar', value: 'confirmar' }, { label: 'No', value: 'cancelar' }],
    });
  }

  // marcar_entrevista
  if (!d.resultado) {
    const r = d.args?.resultado;
    d.resultado = r === 'no_hecha' || /\b(no se hizo|no vino|no llego|no se pudo|no_hecha|no hecha|no realizada)\b/.test(normalizeSearchText(mensajeMin)) ? 'not_done'
      : r === 'hecha' || /\b(hecha|se hizo|realizada|ya entreviste|lista)\b/.test(normalizeSearchText(mensajeMin)) ? 'done' : null;
    d.comentario = d.args?.comentario || (mensaje.match(/(?:porque|comentario:?)\s+(.+)$/i)?.[1] || '').trim();
  }
  if (falta === 'resultado') {
    d.resultado = /\bno\b/.test(normalizeSearchText(mensajeMin)) ? 'not_done' : 'done';
  }
  if (!d.resultado) {
    return preguntar('resultado', `¿La entrevista con **${g.nombres}** se hizo?`, { opciones: [{ label: '✅ Se hizo', value: 'se hizo' }, { label: '❌ No se hizo', value: 'no se hizo' }] });
  }
  if (falta === 'confirmar') {
    if (ES_AFIRMATIVO.test(mensajeMin)) return ejecutarMarcar(g, d, usuario);
    borrarBorrador(usuario);
    return resp('👌 La dejé como estaba.');
  }
  return preguntar('confirmar', '📝 ¿La marco así?', {
    tarjeta: tarjetaEntrevista(g, data, d.resultado === 'done' ? '✅ Marcar como hecha' : '❌ Marcar como no hecha', d.comentario ? [['💬', d.comentario]] : []),
    opciones: OPCIONES_CONFIRMAR,
  });
}

async function ejecutarReprogramar(g, d, usuario) {
  borrarBorrador(usuario);
  const previous = { date: g.date, startTime: g.startTime };
  const nuevaFecha = d.fecha || g.date; const nuevaHora = d.hora || g.startTime;
  const actualizadas = await withDb((db) => {
    const rows = db.interviews.filter((i) => i.groupId === g.groupId && (i.status || 'scheduled') === 'scheduled');
    for (const iv of rows) {
      // si tenía hora de término, se corre con la misma duración
      if (iv.endTime) {
        const dur = (Number(iv.endTime.slice(0, 2)) * 60 + Number(iv.endTime.slice(3))) - (Number(iv.startTime.slice(0, 2)) * 60 + Number(iv.startTime.slice(3)));
        const fin = Number(nuevaHora.slice(0, 2)) * 60 + Number(nuevaHora.slice(3)) + Math.max(dur, 0);
        iv.endTime = `${String(Math.floor(fin / 60) % 24).padStart(2, '0')}:${String(fin % 60).padStart(2, '0')}`;
      }
      iv.date = nuevaFecha; iv.startTime = nuevaHora;
      iv.reminderSent = false; iv.whatsappTodayReminderSent = false;
      iv.updatedAt = new Date().toISOString();
    }
    return rows.map((r) => ({ ...r }));
  });
  vaciarCache();
  const data = load();
  for (const iv of actualizadas) {
    sendRescheduleEmail(iv, previous);
    sendInterviewRescheduledWhatsApp(iv, iv.memberUserId ? data.users.find((u) => u.id === Number(iv.memberUserId)) : null, previous);
  }
  return resp(`🔄 **Listo, reprogramada:** ${g.nombres}, ahora el **${fechaLegible(nuevaFecha)} a las ${nuevaHora}** (antes ${fechaLegible(previous.date)} ${previous.startTime}).`);
}

async function ejecutarCancelar(g, d, usuario) {
  borrarBorrador(usuario);
  const filas = await withDb((db) => {
    const rows = db.interviews.filter((i) => i.groupId === g.groupId);
    for (const iv of rows) {
      iv.status = 'not_done';
      iv.comment = `Cancelada${d.motivo ? `: ${d.motivo}` : ''} (vía Deseret)`;
      iv.markedAt = new Date().toISOString();
      iv.markedBy = usuario.id;
    }
    return rows.map((r) => ({ ...r }));
  });
  vaciarCache();
  const data = load();
  for (const iv of filas) {
    sendCancellationEmail(iv);
    sendInterviewCancelledWhatsApp(iv, iv.memberUserId ? data.users.find((u) => u.id === Number(iv.memberUserId)) : null);
  }
  return resp(`❌ **Cancelada** la entrevista con **${g.nombres}** del ${fechaLegible(g.date)}. Quedó en el historial como "no se hizo".`);
}

async function ejecutarMarcar(g, d, usuario) {
  borrarBorrador(usuario);
  await withDb((db) => {
    for (const iv of db.interviews.filter((i) => i.groupId === g.groupId)) {
      iv.status = d.resultado;
      iv.comment = d.comentario || '';
      iv.markedAt = new Date().toISOString();
      iv.markedBy = usuario.id;
    }
  });
  vaciarCache();
  return resp(d.resultado === 'done'
    ? `✅ Marqué como **hecha** la entrevista con **${g.nombres}**.`
    : `❌ Marqué como **no hecha** la entrevista con **${g.nombres}**.`);
}

// ---------------- Solicitudes de entrevista ----------------
async function accionSolicitud(d, falta, mensaje, mensajeMin, usuario, data) {
  const pendientes = (data.interviewRequests || []).filter((r) => r.status === 'pending' && canDecideFor(usuario, data, r.organizationId))
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  if (!d.elegido) {
    if (!pendientes.length) { borrarBorrador(usuario); return resp('📭 No tienes solicitudes de entrevista pendientes.'); }
    const nombre = d.args?.nombre || nombreDesdeFrase(mensaje, 'solicitud');
    const cand = nombre ? pendientes.filter((r) => coincideNombre(nombre, r.memberName) || coincideNombre(nombre, r.nombreEscrito || '')) : pendientes;
    if (nombre && !cand.length) { borrarBorrador(usuario); return resp(`🔎 No encontré una solicitud pendiente de **${nombre}**.`); }
    if (cand.length > 1) {
      return elegir(usuario, d, cand.map((r) => ({ id: r.id, r })), '¿Cuál solicitud?', (x) => `${x.r.memberName} · ${fechaLegible(x.r.date)} ${x.r.startTime}`);
    }
    d.elegido = cand[0].id;
  }
  const r = pendientes.find((x) => x.id === d.elegido);
  if (!r) { borrarBorrador(usuario); return resp('Esa solicitud ya fue decidida.'); }
  const org = orgPorId(data, r.organizationId);
  const tarjeta = {
    tipo: 'entrevista', titulo: d.accion === 'confirmar_solicitud' ? 'Confirmar solicitud' : 'Rechazar solicitud', color: org?.color || null,
    filas: [['🙋', r.memberName], ['📅', `${fechaLegible(r.date)} · ${d.hora || r.startTime}`], ['🏷️', org?.name || ''], ...(r.targetLeaderName ? [['👤', `con ${r.targetLeaderName}`]] : []), ...(r.note ? [['📝', r.note]] : [])],
  };
  const preguntar = (f, texto, extra = {}) => { guardarBorrador(usuario, 'accion', d, f); return resp(texto, extra); };
  if (falta !== 'confirmar') {
    d.hora = d.hora || (d.args?.hora && /^\d{2}:\d{2}$/.test(d.args.hora) ? d.args.hora : null);
    d.motivo = d.motivo || d.args?.motivo || (mensaje.match(/porque\s+(.+)$/i)?.[1] || '').trim();
    if (d.motivo) tarjeta.filas.push(['💬', d.motivo]);
    return preguntar('confirmar', d.accion === 'confirmar_solicitud' ? '📝 ¿La confirmo? Se crea la entrevista y se le avisa.' : '📝 ¿La rechazo?', { tarjeta, opciones: OPCIONES_CONFIRMAR });
  }
  if (!ES_AFIRMATIVO.test(mensajeMin)) { borrarBorrador(usuario); return resp('👌 La dejé pendiente.'); }
  borrarBorrador(usuario);
  const now = new Date().toISOString();
  if (d.accion === 'rechazar_solicitud') {
    await withDb((db) => {
      const x = db.interviewRequests.find((y) => y.id === r.id);
      if (x && x.status === 'pending') Object.assign(x, { status: 'rejected', decidedBy: usuario.id, decidedAt: now, decisionComment: d.motivo || '' });
    });
    vaciarCache();
    return resp(`❌ Rechacé la solicitud de **${r.memberName}**.`);
  }
  // Confirmar: igual que PUT /api/interview-requests/:id/confirm.
  const iv = await withDb((db) => {
    const x = db.interviewRequests.find((y) => y.id === r.id);
    if (!x || x.status !== 'pending') return null;
    const newId = nextId(db, 'interviews');
    const hora = d.hora || x.startTime;
    const nueva = {
      id: newId, groupId: newId,
      memberName: x.memberName, memberUserId: x.memberUserId, memberPhone: x.memberPhone || '', memberEmail: '',
      ...(x.memberDirectoryId ? { memberDirectoryId: x.memberDirectoryId } : {}),
      description: x.note || '', location: '', sala: '',
      interviewerName: x.targetLeaderName || usuario.name || '',
      ...(x.targetLeaderUserId ? { interviewerUserId: x.targetLeaderUserId } : { interviewerUserId: usuario.id }),
      interviewerEmail: '', interviewerPhone: '',
      date: x.date, startTime: hora, endTime: d.hora ? null : x.endTime,
      organizationId: x.organizationId, scheduledBy: usuario.id,
      reminderSent: false, whatsappTodayReminderSent: false, status: 'scheduled', comment: '',
      markedAt: null, markedBy: null, createdAt: now, updatedAt: now,
    };
    db.interviews.push(nueva);
    Object.assign(x, { status: 'confirmed', decidedBy: usuario.id, decidedAt: now, resultingInterviewId: newId });
    return nueva;
  });
  if (!iv) return resp('Esa solicitud ya fue decidida por otra persona.');
  vaciarCache();
  const data2 = load();
  sendInterviewScheduledWhatsApp(iv, iv.memberUserId ? data2.users.find((u) => u.id === Number(iv.memberUserId)) : null);
  return resp(`✅ Confirmé la solicitud: entrevista con **${iv.memberName}** el **${fechaLegible(iv.date)} a las ${iv.startTime}**. _Si quieres agregar lugar o sala, edítala en Entrevistas._`, {
    items: [{ tipo: 'entrevista', titulo: iv.memberName, fecha: iv.date, hora: iv.startTime, org: org?.name || '', color: org?.color || null }],
  });
}

// ---------------- Compromisos ----------------
async function accionCompletarCompromiso(d, falta, mensaje, mensajeMin, usuario, data) {
  const mios = misCompromisos(usuario, data);
  if (!d.elegido) {
    if (!mios.length) { borrarBorrador(usuario); return resp('🎉 No tienes compromisos pendientes.'); }
    const texto = d.args?.texto || mensaje.replace(/^.*?compromiso\w*\s*(de|del|para|:)?\s*/i, '');
    const palabras = palabrasDe(texto).filter((w) => w.length > 3 && !STOP.has(w) && !/^(complet|cumpl|termin|marc|listo|hecho)/.test(w));
    let cand = palabras.length ? mios.filter(({ c }) => { const p = palabrasDe(c.description); return palabras.filter((w) => p.some((x) => x.startsWith(w.slice(0, 5)))).length >= Math.min(2, palabras.length); }) : mios;
    if (!cand.length) cand = mios;
    if (cand.length > 1) {
      return elegir(usuario, d, cand.map(({ c }) => ({ id: c.id, c })), '¿Cuál compromiso completaste?', (x) => `${x.c.description.slice(0, 60)} (vence ${x.c.dueDate.slice(8)}/${x.c.dueDate.slice(5, 7)})`);
    }
    d.elegido = cand[0].c.id;
  }
  const f = mios.find(({ c }) => c.id === d.elegido);
  if (!f) { borrarBorrador(usuario); return resp('Ese compromiso ya no está pendiente.'); }
  if (falta !== 'confirmar') {
    d.comentario = d.args?.comentario || (mensaje.match(/(?:comentario:?|porque)\s+(.+)$/i)?.[1] || '').trim();
    guardarBorrador(usuario, 'accion', d, 'confirmar');
    return resp('📝 ¿Lo marco como completado?', {
      tarjeta: { tipo: 'compromiso', titulo: f.c.description, color: null, filas: [['📋', f.m.title], ['📅', `Vence ${fechaLegible(f.c.dueDate)}`], ...(d.comentario ? [['💬', d.comentario]] : [])] },
      opciones: OPCIONES_CONFIRMAR,
    });
  }
  borrarBorrador(usuario);
  if (!ES_AFIRMATIVO.test(mensajeMin)) return resp('👌 Lo dejé pendiente.');
  const ok = await withDb((db) => {
    for (const m of db.meetings) {
      const c = (m.commitments || []).find((x) => x.id === f.c.id);
      if (c && c.status === 'pending' && m.status === 'active') {
        Object.assign(c, { status: 'completed', completedAt: new Date().toISOString(), completionComment: d.comentario || '' });
        return true;
      }
    }
    return false;
  });
  vaciarCache();
  return resp(ok ? `✅ ¡Bien hecho! Marqué como completado: **${f.c.description}**.` : 'Ese compromiso ya estaba completado.');
}

// ¿Dónde se anota un compromiso nuevo? En un acta activa, en una reunión
// nueva, o "suelto" (sin reunión formal: queda en un acta interna
// "Compromisos sin reunión" de esa persona, y le aparece igual en
// Mis Asignaciones al responsable).
const RE_SUELTO = /\b(sin (acta|reunion|agenda|consejo)|solo (el |un |como )?compromiso|suelto|ninguna( reunion| acta)?|no (es )?de (ninguna )?(reunion|acta))\b/;
const RE_NUEVA = /\b(nuev[oa]|otra|crear|crea|abre|abrir)\b.*\b(acta|reunion|agenda|consejo)\b|^\s*(una )?(nuev[oa]|otra)\b/;
const TITULO_SUELTOS = 'Compromisos sin reunión';
function opcionesDestino(actas) {
  return [
    ...actas.map((m, i) => ({ label: `${i + 1}. 📋 ${m.title.slice(0, 40)} (${fechaCortaActa(m.date)})`, value: String(i + 1) })),
    { label: `${actas.length + 1}. 🆕 Reunión nueva`, value: 'reunión nueva' },
    { label: `${actas.length + 2}. 📌 Solo el compromiso`, value: 'sin reunión' },
  ];
}
function actasEditables(usuario, data) {
  return (data.meetings || [])
    .filter((m) => m.status === 'active' && !m.sueltos && (usuario.role === 'admin' || Number(m.createdBy) === Number(usuario.id)))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 3);
}
const fechaCortaActa = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');
function etiquetaDestino(d) {
  if (d.destino?.tipo === 'suelto') return 'Solo el compromiso (sin reunión)';
  if (d.destino?.tipo === 'nueva') return `Reunión nueva: ${d.destino.titulo || '(sin nombre)'}`;
  if (d.destino?.tipo === 'acta') return `Acta: ${d.destino.titulo}`;
  return '';
}
// Interpreta la respuesta a "¿Dónde lo anoto?" (texto, número o voz).
function leerDestino(txt, actas) {
  const t = normalizeSearchText(txt);
  if (RE_SUELTO.test(t)) return { tipo: 'suelto' };
  if (RE_NUEVA.test(t)) return { tipo: 'nueva' };
  const ordinales = [/\b(1|uno|una|primer\w*)\b/, /\b(2|dos|segund\w*)\b/, /\b(3|tres|tercer\w*)\b/, /\b(4|cuatro|cuart\w*)\b/, /\b(5|cinco|quint\w*)\b/];
  const n = ordinales.findIndex((re) => re.test(t));
  const opciones = [...actas.map((m) => ({ tipo: 'acta', id: m.id, titulo: m.title })), { tipo: 'nueva' }, { tipo: 'suelto' }];
  // Solo en respuestas cortas ("1", "la segunda", "opción 3"): en una frase
  // larga, "una" o "dos" suelen ser parte de la descripción.
  if (n >= 0 && opciones[n] && palabrasDe(t).length <= 3) return opciones[n];
  // Por nombre: "en la del consejo", "la de presidencia".
  const palabras = palabrasDe(t).filter((w) => w.length >= 4 && !['acta', 'reunion', 'agenda', 'anota', 'anotalo', 'ponlo', 'agregalo'].includes(w));
  const hit = actas.filter((m) => palabras.some((w) => palabrasDe(m.title).some((x) => x.startsWith(w))));
  if (hit.length === 1) return { tipo: 'acta', id: hit[0].id, titulo: hit[0].title };
  return null;
}

// "toda la presidencia de la Primaria", "todo el obispado", "la presidencia
// del cuórum" → las personas de esa presidencia a las que se puede asignar
// (líderes de esa organización, sin los secretarios).
function grupoDesdeTexto(texto, usuario, data, asignables) {
  const t = normalizeSearchText(texto);
  let orgId = null; let nombre = '';
  if (/\b(todo el obispado|al obispado|el obispado completo|los del obispado|para el obispado)\b/.test(t)) {
    orgId = (data.organizations || []).find((o) => o.name === 'Obispado')?.id; nombre = 'Obispado';
  } else if (/\b(toda la presidencia|la presidencia|toda mi presidencia|mi presidencia)\b/.test(t)) {
    orgId = inferOrganizationId(t.replace(/^.*?presidencia/, ''), data.organizations || []) || (/\bmi presidencia\b/.test(t) ? usuario.organizationId : null);
    if (!orgId && /\b(toda la presidencia|la presidencia)\s*($|[:,.]|que\b)/.test(t)) orgId = usuario.organizationId;
    const org = orgPorId(data, orgId);
    nombre = org ? `Presidencia de ${org.name}` : '';
  }
  if (!orgId) return null;
  const miembros = asignables.filter((u) => Number(u.organizationId) === Number(orgId) && u.role === 'leader' && u.calling !== 'Secretario');
  if (!miembros.length) return null;
  return { ids: miembros.map((u) => u.id), nombre };
}

async function accionCrearCompromiso(d, falta, mensaje, mensajeMin, usuario, data, hoyObj) {
  if (!['admin', 'leader', 'ward_clerk'].includes(usuario.role)) {
    borrarBorrador(usuario);
    return resp('🚫 Solo los líderes, el secretario de barrio y el Administrador registran compromisos.');
  }
  const asignables = assignableUsersFor(usuario, data);
  const preguntar = (f, texto, extra = {}) => { guardarBorrador(usuario, 'accion', d, f); return resp(texto, extra); };

  if (falta === 'elegir') { d.responsableId = d.elegido; delete d.elegido; }
  if (!d.descripcion) {
    d.descripcion = (d.args?.descripcion || (mensaje.match(/:\s*(.+)$/)?.[1]) || '').trim()
      .replace(/\s+(para\s+)?(el|este|esta)\s+(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b.*$/i, '')
      // Quitar "…, sin reunión" / "…en el acta del consejo" (eso es DÓNDE, no QUÉ).
      .replace(/[,;]?\s*(sin (acta|reuni[oó]n|agenda)|como compromiso suelto|solo (el |un |como )?compromiso|en (una )?(nuev[oa]|otra) (acta|reuni[oó]n|agenda)|(en|al) (el |la )?(acta|reuni[oó]n|agenda) (de|del)\b.*)\s*[.!]?$/i, '')
      .replace(/\s+(para\s+)?(el|este|esta)\s+(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b.*$/i, '')
      .replace(/\s+(para\s+|antes\s+del?\s+|hasta\s+)?(el\s+)?\d{1,2}\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|sept?iembre|octubre|noviembre|diciembre)(\s+de\s+\d{4})?\b.*$/i, '')
      .replace(/\s+(para\s+)?(el\s+)?(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?|ma[ñn]ana|hoy)\s*$/i, '').trim();
  }
  if (!d.responsableId && !d.responsableTexto) {
    d.responsableTexto = d.args?.responsable || (mensaje.match(/compromiso\w*\s+(?:para|a)\s+(?:el\s+|la\s+)?([A-ZÁÉÍÓÚÑa-záéíóúñ.'\- ]+?)(?=\s*[:,]|\s+(?:de|que|debe|tiene)\b|$)/i)?.[1] || '').trim();
  }
  if (falta === 'responsable') d.responsableTexto = mensaje.trim();
  if (falta === 'descripcion') d.descripcion = mensaje.trim();
  if (falta === 'fecha') d.fechaLimite = parseFecha(mensajeMin, hoyObj);
  if (!d.fechaLimite) d.fechaLimite = (d.args?.fecha_limite && /^\d{4}-\d{2}-\d{2}$/.test(d.args.fecha_limite) ? d.args.fecha_limite : null) || (falta ? null : parseFecha(mensajeMin, hoyObj));

  // Dónde anotarlo: si ya lo dijo en la primera frase ("…sin reunión",
  // "…en el acta del consejo", "…en una reunión nueva") no se pregunta.
  const actas = actasEditables(usuario, data);
  if (!falta && !d.destino) {
    const dicho = [d.args?.reunion, /\b(sin (acta|reunion|reunión|agenda)|suelto|solo (el |un )?compromiso|(nuev[oa]|otra) (acta|reuni[oó]n|agenda)|(en|al) (el |la )?(acta|reuni[oó]n|agenda|consejo)\b.*)/i.exec(mensaje)?.[0]].filter(Boolean).join(' ');
    if (dicho) {
      if (/^\s*ningun/i.test(d.args?.reunion || '')) d.destino = { tipo: 'suelto' };
      else d.destino = leerDestino(dicho, actas) || undefined;
    }
  }
  if (falta === 'destino') {
    const x = leerDestino(mensaje, actas);
    if (!x) {
      guardarBorrador(usuario, 'accion', d, 'destino');
      return resp('No entendí dónde anotarlo. Elige una opción (o di "sin reunión" / "reunión nueva"):', { opciones: opcionesDestino(actas) });
    }
    d.destino = x;
  }
  if (falta === 'titulo_acta') {
    const titulo = mensaje.trim().replace(/^(se llama|llamala|ponle|el nombre es)\s+/i, '').replace(/[.!]+$/, '');
    d.destino = { tipo: 'nueva', titulo: titulo.charAt(0).toUpperCase() + titulo.slice(1) };
  }
  // En la confirmación también se puede cambiar dónde va.
  if (falta === 'confirmar' && !ES_AFIRMATIVO.test(mensajeMin)) {
    const t = normalizeSearchText(mensaje);
    if (/\bcambiar (donde|reunion|acta)\b/.test(t)) d.destino = undefined;
    else if (RE_SUELTO.test(t) || RE_NUEVA.test(t) || /\b(acta|reunion)\b/.test(t)) d.destino = leerDestino(mensaje, actas) || d.destino;
  }

  // D11: compromiso para un grupo completo ("toda la presidencia de la
  // Sociedad de Socorro", "todo el obispado"): uno por persona, agrupados.
  if (!d.responsableId && !d.responsableIds) {
    // Solo se mira la parte del "para quién" (no la descripción, que podría
    // mencionar "la presidencia" por otra razón).
    const paraQuien = falta === 'responsable' ? mensaje : falta ? '' : (mensaje.match(/compromiso\w*\s+(?:para|a)\s+([^:]+?)(?::|$)/i)?.[1] || '');
    const g = grupoDesdeTexto(`${d.responsableTexto || ''} ${paraQuien}`, usuario, data, asignables);
    if (g && g.ids.length > 1) { d.responsableIds = g.ids; d.responsableId = g.ids[0]; d.grupoNombre = g.nombre; } else if (g) d.responsableId = g.ids[0];
  }
  if (!d.responsableId) {
    if (!d.responsableTexto) return preguntar('responsable', '👤 ¿Para quién es el compromiso? (una persona, o un grupo como "toda la presidencia de la Primaria")', { opciones: [{ label: 'Para mí', value: 'yo' }] });
    if (/^(yo|mi|m[ií]|para m[ií]|m[ií] mismo|m[ií] misma)$/i.test(d.responsableTexto.trim())) d.responsableId = usuario.id;
    else {
      const cand = asignables.filter((u) => coincideNombre(d.responsableTexto, u.name));
      if (!cand.length) { d.responsableTexto = ''; return preguntar('responsable', `🔎 No encontré a esa persona entre quienes puedes asignar compromisos. ¿Para quién es? (escribe su nombre)`); }
      if (cand.length > 1) return elegir(usuario, d, cand, '¿A quién se lo asigno?', (u) => u.name);
      d.responsableId = cand[0].id;
    }
  }
  if (!d.descripcion) return preguntar('descripcion', '📝 ¿Qué tiene que hacer? (describe el compromiso)');
  if (!d.fechaLimite) return preguntar('fecha', '📅 ¿Para cuándo?', { opciones: [...opcionesFecha(hoyObj).slice(1), { label: 'En una semana', value: toISO(sumarDias(hoyObj, 7)) }] });

  const resp_ = d.responsableIds
    ? { name: `${d.grupoNombre} (${d.responsableIds.map((id) => asignables.find((u) => u.id === id)?.name.split(' ')[0]).filter(Boolean).join(', ')})` }
    : asignables.find((u) => u.id === d.responsableId) || (d.responsableId === usuario.id ? usuario : null);
  if (!resp_) { borrarBorrador(usuario); return resp('🚫 No puedes asignarle compromisos a esa persona.'); }
  if (!d.destino) {
    // La pregunta lleva las opciones en el texto (numeradas) para que se
    // entienda también cuando Deseret la lee en voz alta.
    const lista = [...actas.map((m) => `el acta «${m.title}» del ${fechaCortaActa(m.date)}`), 'una reunión nueva', 'solo el compromiso, sin reunión'];
    const texto = `📋 ¿Dónde lo anoto? ${lista.map((x, i) => `**${i + 1}.** ${x}`).join(' · ')}`;
    return preguntar('destino', texto, { opciones: opcionesDestino(actas) });
  }
  if (d.destino.tipo === 'nueva' && !d.destino.titulo) {
    const org = orgPorId(data, usuario.organizationId);
    const sug = [org ? `Reunión de presidencia ${org.name}` : 'Reunión de presidencia', ...(isObispadoLeader(usuario, data) ? ['Consejo de barrio', 'Reunión de obispado'] : []), 'Reunión de coordinación'];
    return preguntar('titulo_acta', '🆕 ¿Cómo se llama la reunión? (queda con fecha de hoy; después puedes completarla en Reuniones y Consejos)', { opciones: sug.map((x) => ({ label: x, value: x })) });
  }
  if (d.destino.tipo === 'acta' && !actas.some((m) => m.id === d.destino.id)) d.destino = undefined;
  if (!d.destino) return preguntar('destino', '📋 Esa acta ya no está activa. ¿Dónde lo anoto?', { opciones: opcionesDestino(actas) });
  if (falta !== 'confirmar' || !ES_AFIRMATIVO.test(mensajeMin)) {
    if (falta === 'confirmar') {
      // "el sábado" / "para el 30" en el paso de confirmar = corregir la fecha.
      const f2 = parseFecha(mensajeMin, hoyObj);
      if (f2) d.fechaLimite = f2;
      else if (/^\s*(no|cancel\w*)\b/i.test(mensajeMin)) { borrarBorrador(usuario); return resp('👌 No lo registré.'); }
    }
    return preguntar('confirmar', '📝 ¿Lo registro así? (puedes cambiar la fecha, ej. "el sábado", o dónde se anota)', {
      tarjeta: { tipo: 'compromiso', titulo: d.descripcion, color: null, filas: [['👤', resp_.name], ['📅', `Para el ${fechaLegible(d.fechaLimite)}`], ['📋', etiquetaDestino(d)]] },
      opciones: [...OPCIONES_CONFIRMAR, { label: '📋 Cambiar dónde se anota', value: 'cambiar dónde' }],
    });
  }
  borrarBorrador(usuario);
  // Se anota donde la persona eligió: un acta activa, una reunión nueva
  // (con fecha de hoy) o su acta interna de "Compromisos sin reunión".
  const now = new Date();
  const hora = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const nuevaActa = (db, extra) => {
    const m = {
      id: nextId(db, 'meetings'), date: toISO(hoyObj), startTime: hora, endTime: null,
      type: 'general', confidential: false, organizationId: usuario.organizationId || null, status: 'active',
      createdBy: usuario.id, createdAt: now.toISOString(), archivedAt: null, lastEditedBy: null, lastEditedAt: null,
      agendaItems: [], commitments: [], councilPrepReminderSent: false, ...extra,
    };
    db.meetings.push(m);
    return m;
  };
  const acta = await withDb((db) => {
    let m = null;
    if (d.destino.tipo === 'acta') m = db.meetings.find((x) => x.id === d.destino.id && x.status === 'active');
    if (!m && d.destino.tipo === 'suelto') m = db.meetings.find((x) => x.sueltos && x.status === 'active' && Number(x.createdBy) === Number(usuario.id));
    if (!m && d.destino.tipo === 'suelto') m = nuevaActa(db, { title: TITULO_SUELTOS, sueltos: true });
    if (!m) {
      const esConsejo = /consejo de barrio/i.test(d.destino.titulo || '') && isObispadoLeader(usuario, data);
      m = nuevaActa(db, { title: d.destino.titulo || 'Reunión', type: esConsejo ? 'consejo_barrio' : 'general' });
    }
    const ids = d.responsableIds || [d.responsableId];
    const groupId = ids.length > 1 ? `grp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : null;
    for (const assignedToUserId of ids) {
      m.commitments.push({
        id: nextId(db, 'commitments'), description: d.descripcion, dueDate: d.fechaLimite, assignedToUserId,
        groupId, confidential: false, priority: 'media', status: 'pending', completedAt: null, completionComment: '',
        whatsappDueTodaySent: false, reassignHistory: [],
      });
    }
    m.lastEditedBy = usuario.id; m.lastEditedAt = now.toISOString();
    return m.title;
  });
  vaciarCache();
  const donde = d.destino.tipo === 'suelto'
    ? 'Quedó como compromiso suelto (sin reunión)'
    : d.destino.tipo === 'nueva' ? `Creé la reunión **«${acta}»** con fecha de hoy y quedó ahí` : `Quedó en el acta **«${acta}»**`;
  if (d.responsableIds) return resp(`✅ Compromiso grupal registrado para **${resp_.name}**: ${d.descripcion} (para el **${fechaLegible(d.fechaLimite)}**). ${d.destino.tipo === 'suelto' ? 'Quedó como compromiso suelto (sin reunión)' : `Quedó en el acta **«${acta}»**`}; a cada uno le aparece en *Mis Asignaciones*.`);
  return resp(`✅ Compromiso registrado para **${resp_.name}**: ${d.descripcion} (para el **${fechaLegible(d.fechaLimite)}**). ${donde}, y le aparece en *Mis Asignaciones*.`);
}
