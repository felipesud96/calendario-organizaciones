// ----------------------------------------------------------------------
// DESERET — CONSULTAS NUEVAS (puntos 3, 4, 5, 6 y 10)
// ----------------------------------------------------------------------
//   3. Sugerir horarios:      "¿cuándo puedo entrevistar a Jaime?"
//   4. Ficha de una persona:  "cuéntame de Jaime Cuenca"
//   5. Preparar reuniones:    "prepárame el consejo de barrio"
//   6. Mi semana:             "¿qué tengo esta semana?"
//  10. Aprender del uso:      👍/👎 y preguntas sin respuesta (para el admin)
// ----------------------------------------------------------------------
import { load, withDb } from './db.js';
import { isObispadoLeader } from './routes/stake.js';
import { canSeeMeetingRecord } from './routes/meetings.js';
import { isWelfareCommitteeMember } from './routes/welfare.js';
import { isMinisteringFocusLeaderHombres, isMinisteringFocusLeaderMujeres } from './routes/directory.js';
import { bloquesLibres } from './routes/publicBooking.js';
import { resumenSemana, fraseResumen } from './semana.js';
import { puedeVerFichas, buscarPersonas, fichaPersona, fichaComoTexto } from './persona.js';
import {
  resp, fechaLegible, normalizeSearchText, redactarConIA, filtrarAlucinacion,
  contextoCrecimiento, contextoMinistracion, toISO, sumarDias,
} from './chat.js';

// ---------------- Detección ----------------
const RE_FICHA = /\b(cuentame|hablame|dime|ficha|informacion|info|historial|que sabes|datos)\b\s+(de|del|sobre|acerca de)\s+/;
const RE_HORARIOS = /\b(cuando puedo|que horarios?|horarios? (libres?|disponibles?)|mis horarios|tengo (hora|espacio|tiempo)|huecos?|espacios? libres?|disponibilidad para)\b/;
const RE_PREPARAR = /\b(prepar\w*|arm\w*|sugi\w*|propon\w*|temas? para|agenda para)\b.*\b(consejo|reunion|coordinacion|presidencia|comite|junta)\b/;
const RE_SEMANA = /\b(mi semana|que tengo|tengo algo|que me toca|mis pendientes|resumen de (la|mi) semana|como viene la semana|agenda de (hoy|manana|la semana))\b/;
const RE_FEEDBACK = /\b(no supiste|sin respuesta|no respondidas|valoraciones de deseret|feedback de deseret|como le va a deseret)\b/;

export function detectarConsultaExtra(norm) {
  if (RE_FEEDBACK.test(norm)) return 'feedback';
  if (RE_PREPARAR.test(norm)) return 'preparar';
  if (RE_HORARIOS.test(norm)) return 'horarios';
  if (RE_FICHA.test(norm)) return 'ficha';
  if (RE_SEMANA.test(norm)) return 'semana';
  return null;
}

export async function manejarConsultaExtra(tipo, { mensaje, norm, usuario, hoyObj, historial }) {
  if (!usuario) return resp('🔒 Necesitas haber iniciado sesión.');
  const data = load();
  switch (tipo) {
    case 'ficha': return consultaFicha(mensaje, norm, usuario, data, historial);
    case 'horarios': return consultaHorarios(mensaje, usuario, data);
    case 'preparar': return consultaPreparar(mensaje, norm, usuario, data, hoyObj, historial);
    case 'semana': return consultaSemana(norm, usuario, data, hoyObj);
    case 'feedback': return consultaFeedback(usuario, data);
    default: return null;
  }
}

// ---------------- 4. Ficha de persona ----------------
async function consultaFicha(mensaje, norm, usuario, data, historial) {
  if (!puedeVerFichas(usuario)) return resp('🔒 Las fichas de las personas están disponibles para líderes, secretarios y el Administrador.');
  const nombre = mensaje.replace(/^.*?\b(cu[eé]ntame|h[aá]blame|dime|ficha|informaci[oó]n|info|historial|qu[eé] sabes|datos)\b\s+(de|del|sobre|acerca de)\s+(la\s+|el\s+)?/i, '').replace(/[?¿.!]+/g, '').trim();
  if (!nombre) return resp('¿De quién? Escríbeme su nombre, por ejemplo "cuéntame de Jaime Cuenca".');
  const res = buscarPersonas(nombre, data);
  if (!res.length) return resp(`🔎 No encontré a **${nombre}** en el Directorio ni entre los usuarios.`);
  if (res.length > 1) {
    return resp(`🔎 Encontré varias personas que coinciden con **${nombre}**. ¿Cuál?`, {
      opciones: res.slice(0, 6).map((r) => ({ label: `${r.nombre}${r.tieneCuenta ? ' 🔗' : ''}`, value: `ficha de ${r.nombre}` })),
    });
  }
  const f = fichaPersona(usuario, data, { directoryId: res[0].directoryId, userId: res[0].userId });
  if (!f) return resp('No pude armar la ficha de esa persona.');
  const texto = fichaComoTexto(f);
  const sistema = `Eres Deseret, asistente de OrganizaSion. Te paso la ficha de una persona del barrio, ya filtrada según los permisos de quien pregunta.
Haz un resumen pastoral y breve (3 a 5 viñetas): su situación, lo último que pasó con ella y 1 sugerencia práctica si corresponde. Usa SOLO estos datos, no inventes. Tono respetuoso, nunca de juicio.
${texto}`;
  const redactado = await redactarConIA(sistema, historial, mensaje);
  const respaldo = `📇 **${f.nombre}**\n\n` + f.secciones.map((s) => `**${s.titulo}:** ${s.resumen || (s.filas || []).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'}`).join('\n');
  return resp(redactado ? filtrarAlucinacion(redactado) : respaldo, {
    opciones: [{ label: '📇 Ver ficha completa', value: `ficha de ${f.nombre}`, ficha: { directoryId: f.directoryId, userId: f.userId } }],
  });
}

// ---------------- 3. Sugerir horarios ----------------
function consultaHorarios(mensaje, usuario, data) {
  if (usuario.role !== 'leader') return resp('🗓️ Los horarios de entrevista son para los líderes que entrevistan.');
  const org = data.organizations.find((o) => o.id === Number(usuario.organizationId));
  const u = data.users.find((x) => x.id === usuario.id);
  if (!(u.interviewAvailability || []).length) {
    return resp('🗓️ Todavía no declaraste tus horarios habituales de entrevista. Hazlo en **Entrevistas → 🗓️ Mi disponibilidad** y te sugiero los espacios libres.');
  }
  if (!org || !org.allowsInterviews) return resp('Tu organización no agenda entrevistas en la app.');
  const dias = bloquesLibres(data, u, org);
  const nombre = (mensaje.match(/entrevistar\s+(?:a|al|a la)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ.'\- ]+?)(?=[?¿.,!]|$)/i)?.[1] || '').trim();
  // Hasta 6 opciones, repartidas en distintos días (máx. 2 por día).
  const opciones = [];
  for (const d of dias) {
    for (const h of d.horas.slice(0, 2)) {
      if (opciones.length >= 6) break;
      opciones.push({ fecha: d.fecha, hora: h });
    }
  }
  if (!opciones.length) return resp('📭 No te quedan espacios libres en las próximas 3 semanas dentro de tu disponibilidad.');
  return resp(`🗓️ Tus próximos espacios libres${nombre ? ` para entrevistar a **${nombre}**` : ''} (según tu disponibilidad, sin choques con lo ya agendado):`, {
    opciones: opciones.map((o) => ({
      label: `${fechaLegible(o.fecha)} · ${o.hora}`,
      value: `agenda una entrevista${nombre ? ` con ${nombre}` : ''} el ${o.fecha} a las ${o.hora}`,
    })),
  });
}

// ---------------- 5. Preparar reuniones ----------------
async function consultaPreparar(mensaje, norm, usuario, data, hoyObj, historial) {
  if (!['admin', 'leader', 'ward_clerk'].includes(usuario.role)) return resp('🔒 Preparar reuniones está disponible para líderes y el secretario de barrio.');
  const hoy = toISO(hoyObj);
  const en14 = toISO(sumarDias(hoyObj, 14));
  const obispado = isObispadoLeader(usuario, data);
  const tipo = /\bconsejo de barrio\b/.test(norm) ? 'Consejo de Barrio'
    : /\bcoordinacion\b/.test(norm) ? 'Coordinación de Ministración'
      : /\bcomite\b/.test(norm) ? 'Comité' : /\bpresidencia\b/.test(norm) ? 'Reunión de presidencia' : 'Reunión';
  const org = (id) => data.organizations.find((o) => o.id === Number(id));
  const bloques = [];

  // Compromisos pendientes (de las actas que esta persona puede ver).
  const pend = [];
  for (const m of data.meetings || []) {
    if (m.status !== 'active' || !canSeeMeetingRecord(usuario, m, data)) continue;
    for (const c of m.commitments || []) {
      if (c.status === 'pending' && c.dueDate && c.dueDate <= en14 && !c.confidential) {
        const who = data.users.find((u) => u.id === Number(c.assignedToUserId))?.name || '—';
        pend.push({ ...c, who, atrasado: c.dueDate < hoy });
      }
    }
  }
  pend.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  if (pend.length) bloques.push(`COMPROMISOS PENDIENTES (${pend.filter((c) => c.atrasado).length} atrasados):\n` + pend.slice(0, 12).map((c) => `${c.atrasado ? '[ATRASADO] ' : ''}${c.dueDate} · ${c.who}: ${c.description}`).join('\n'));

  // Solicitudes de entrevista pendientes.
  const sol = (data.interviewRequests || []).filter((r) => r.status === 'pending' && (obispado || Number(r.organizationId) === Number(usuario.organizationId)));
  if (sol.length) bloques.push(`SOLICITUDES DE ENTREVISTA PENDIENTES: ${sol.length}`);

  // Indicadores que van bajando (Crecimiento del Barrio).
  if (['admin', 'leader', 'ward_clerk'].includes(usuario.role)) {
    const c = contextoCrecimiento('asistencia crecimiento', data);
    const bajando = c.contexto.split('\n').filter((l) => /\(-\d+ pp\)/.test(l));
    if (bajando.length) bloques.push('INDICADORES QUE BAJARON RESPECTO DEL TRIMESTRE ANTERIOR:\n' + bajando.slice(0, 6).join('\n'));
  }

  // Enfoque Ministración (si tiene permiso).
  if (isMinisteringFocusLeaderHombres(usuario, data) || isMinisteringFocusLeaderMujeres(usuario, data)) {
    bloques.push(contextoMinistracion('enfoque', usuario, data).contexto.trim());
  }

  // Bienestar: solo el conteo, sin detalles.
  if (isWelfareCommitteeMember(usuario, data)) {
    const abiertos = (data.welfareCases || []).filter((c) => c.status !== 'cerrado').length;
    if (abiertos) bloques.push(`CASOS DE BIENESTAR ACTIVOS: ${abiertos} (revisar en el módulo Bienestar; no mencionar nombres)`);
  }

  // Próximas actividades (2 semanas).
  const acts = (data.events || []).filter((e) => e.date >= hoy && e.date <= en14 && !e.isMeeting
    && (obispado || e.isWardActivity || Number(e.organizationId) === Number(usuario.organizationId)))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (acts.length) bloques.push('PRÓXIMAS ACTIVIDADES:\n' + acts.slice(0, 10).map((e) => `${e.date} ${e.startTime || ''} · ${e.title} (${org(e.organizationId)?.name || 'Barrio'})`).join('\n'));

  const contexto = bloques.join('\n\n') || 'No hay pendientes relevantes registrados en la app.';
  const sistema = `Eres Deseret, asistente de OrganizaSion. Prepara un BORRADOR DE AGENDA para: ${tipo}${obispado ? ' (Obispado)' : ''}.
Usa SOLO estos datos de la app:
${contexto}

Formato:
**${tipo} — borrador de agenda**
1. Oración y bienvenida
2..N. Temas numerados, cada uno con: el tema en negrita, por qué (1 línea con el dato concreto) y quién podría presentarlo.
Al final: **Seguimiento de compromisos** (los atrasados primero) y **Para decidir hoy** (2-3 preguntas concretas para el consejo).
Tono pastoral, centrado en las personas (Manual General 4.2: ministrar, no administrar). Máximo ~20 líneas. No inventes datos ni nombres que no estén arriba.`;
  const redactado = await redactarConIA(sistema, historial, mensaje);
  if (redactado) return resp(filtrarAlucinacion(redactado));
  // Respaldo sin IA.
  const lineas = [`📋 **${tipo} — borrador de agenda**`, '1. Oración y bienvenida'];
  let n = 2;
  if (pend.some((c) => c.atrasado)) lineas.push(`${n++}. **Compromisos atrasados** (${pend.filter((c) => c.atrasado).length}): ${pend.filter((c) => c.atrasado).slice(0, 4).map((c) => `${c.who} — ${c.description}`).join('; ')}`);
  if (bloques.some((b) => b.startsWith('INDICADORES'))) lineas.push(`${n++}. **Indicadores que bajaron** — revisar causas y acciones`);
  if (bloques.some((b) => b.includes('ENFOQUE MINISTRACIÓN'))) lineas.push(`${n++}. **Enfoque Ministración** — personas a un paso de Retener`);
  if (sol.length) lineas.push(`${n++}. **Solicitudes de entrevista pendientes** (${sol.length})`);
  if (acts.length) lineas.push(`${n++}. **Próximas actividades**: ${acts.slice(0, 4).map((e) => e.title).join(', ')}`);
  lineas.push(`${n++}. Asignaciones y oración final`);
  return resp(lineas.join('\n'));
}

// ---------------- 6. Mi semana ----------------
function consultaSemana(norm, usuario, data, hoyObj) {
  const hoy = toISO(hoyObj);
  const soloHoy = /\bhoy\b/.test(norm);
  const manana = /\bmanana\b/.test(norm);
  const desde = manana ? toISO(sumarDias(hoyObj, 1)) : hoy;
  const r = resumenSemana(usuario, data, { desde, dias: soloHoy || manana ? 1 : 7 });
  const periodo = soloHoy ? 'hoy' : manana ? 'mañana' : 'esta semana';
  const items = [...r.entrevistas, ...r.compromisos, ...r.actividades].sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora)).slice(0, 15)
    .map((x) => ({ tipo: x.tipo === 'compromiso' ? 'compromiso' : x.tipo, titulo: x.titulo, fecha: x.fecha, hora: x.hora, org: x.org, color: x.color }));
  return resp(`🐝 Para **${periodo}** tienes: ${fraseResumen(r)}.${r.totales.solicitudes ? '\n\n📥 Revisa las solicitudes en **Entrevistas → Solicitudes**.' : ''}`, items.length ? { items } : {});
}

// ---------------- 10. Aprender del uso ----------------
function consultaFeedback(usuario, data) {
  if (usuario.role !== 'admin' && !isObispadoLeader(usuario, data)) return resp('🔒 Eso lo ve el Administrador y el Obispado.');
  const sin = (data.deseretSinRespuesta || []).slice(-10).reverse();
  const fb = data.deseretFeedback || [];
  const pos = fb.filter((f) => f.valor === 1).length; const neg = fb.filter((f) => f.valor === -1).length;
  const negs = fb.filter((f) => f.valor === -1).slice(-5).reverse();
  return resp(`📈 **Deseret — cómo le va**\n\n• Valoraciones: 👍 ${pos} · 👎 ${neg}\n`
    + (negs.length ? `\n**Últimas respuestas con 👎:**\n${negs.map((f) => `• "${f.mensaje}"`).join('\n')}\n` : '')
    + (sin.length ? `\n**Preguntas que no supe responder:**\n${sin.map((s) => `• "${s.mensaje}"`).join('\n')}` : '\nNo hay preguntas sin respuesta registradas. 🎉'));
}

// Registro (anónimo: sin nombre de quién preguntó) de preguntas que cayeron
// en la respuesta genérica, y de las valoraciones 👍/👎.
export async function registrarSinRespuesta(mensaje) {
  const texto = String(mensaje || '').trim().slice(0, 200);
  if (!texto || /^(hola|buen[oa]s?|gracias|ok|chao|adios)\b/i.test(normalizeSearchText(texto))) return;
  await withDb((d) => {
    d.deseretSinRespuesta = [...(d.deseretSinRespuesta || []), { mensaje: texto, fecha: new Date().toISOString() }].slice(-200);
  });
}

export async function registrarFeedback({ mensaje, respuesta, valor }) {
  const v = Number(valor) === 1 ? 1 : -1;
  await withDb((d) => {
    d.deseretFeedback = [...(d.deseretFeedback || []), {
      mensaje: String(mensaje || '').slice(0, 200), respuesta: String(respuesta || '').slice(0, 400), valor: v, fecha: new Date().toISOString(),
    }].slice(-500);
  });
}
