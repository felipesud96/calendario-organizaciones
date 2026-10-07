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
import { isBlockingStakeEvent } from './stakeCalendar.js';
import { resumenSemana, fraseResumen } from './semana.js';
import { recordatoriosComoItems } from './deseretPlus.js';
import { puedeVerFichas, buscarPersonas, fichaPersona, fichaComoTexto } from './persona.js';
import { TIPOS_ENTREVISTA, QUIEN_LABEL, inferirTipoEntrevista, obispoDelBarrio } from './tiposEntrevista.js';
import {
  resp, fechaLegible, normalizeSearchText, redactarConIA, filtrarAlucinacion, parseFecha,
  contextoCrecimiento, contextoMinistracion, toISO, sumarDias,
} from './chat.js';

// ---------------- Detección ----------------
// "¿Cuándo puedo hacer un campamento en noviembre?", "¿qué sábados están libres?"
const RE_FECHAS = /\b((fechas?|dias?|sabados?|viernes|domingos?|lunes|martes|miercoles|jueves|fin(es)? de semana) (que )?((estan|esta|quedan|queda|hay|tenemos|siguen) )?(libres?|disponibles?|desocupad\w*|sin actividades)|cuando (puedo|podemos|podria|podriamos|conviene|seria bueno|me recomiendas) (hacer|organizar|agendar|realizar|programar|tener)|que (dia|fecha|sabado|viernes) (conviene|esta libre|me recomiendas|recomiendas|sirve))\b/;
const RE_FICHA = /\b(cuentame|hablame|dime|ficha|informacion|info|historial|que sabes|datos)\b\s+(de|del|sobre|acerca de)\s+/;
const RE_HORARIOS = /\b(cuando puedo|que horarios?|horarios? (libres?|disponibles?)|mis horarios|tengo (hora|espacio|tiempo)|huecos?|espacios? libres?|disponibilidad para)\b/;
const RE_PREPARAR = /\b(prepar\w*|arm\w*|sugi\w*|propon\w*|temas? para|agenda para)\b.*\b(consejo|reunion|coordinacion|presidencia|comite|junta)\b/;
const RE_SEMANA = /\b(mi semana|mi dia|resumen del dia|que tengo|tengo algo|que me toca|con quien (me toca|tengo)|mis pendientes|resumen de (la|mi) semana|como viene la semana|agenda de (hoy|manana|la semana))\b/;
const RE_TIPOS = /\b(quien puede (hacer|entrevistar|dar|tomar)|quien (hace|da|toma) (la|las|el)|solo (lo|la) (hace|puede hacer) el obispo|solo el obispo|que entrevistas (puede|pueden|hace|hacen)|puede (un|el) consejero|pueden los consejeros|consejeros? (puede|pueden)|le corresponde al obispo)\b/;
const RE_FEEDBACK = /\b(no supiste|sin respuesta|no respondidas|valoraciones de deseret|feedback de deseret|como le va a deseret)\b/;

// "¿Cómo asigno una tarea?", "¿dónde veo el informe?" → explicación + botón que lleva a la pantalla.
export const RE_COMO_APP = /\b(como (hago|hacemos|puedo|podemos|se hace|se puede|creo|crear|agrego|agregar|asigno|asignar|registro|registrar|subo|subir|activo|activar|cambio|cambiar|veo|ver|saco|sacar|descargo|descargar|agendo|agendar|anoto|anotar|marco|marcar|edito|editar|uso|usar|funciona)|donde (esta|estan|veo|se ve|se ven|encuentro|puedo|se hace|se registra|se crea)|en que parte|explicame como|ensename a|ensename como)\b/;
const AYUDA_APP = [
  { re: /\b(preparativ\w*|tareas?|asign\w*|responsables?)\b/, t: 'Abre la actividad en el **Calendario**, baja a **Preparativos** y toca **Crear lista** (o **Editar lista**). En cada tarea escribe el nombre del responsable: si tiene cuenta, le llega un aviso y la ve en su semana.', b: 'Ir al Calendario', ir: { vista: 'calendar' } },
  { re: /\b(informe|reporte)\b/, t: 'En **Estadísticas → Tablero** toca **Informe del mes**. Ahí lo descargas en PDF o lo envías por WhatsApp. El día 1 de cada mes el Obispado recibe un aviso cuando está listo.', b: 'Abrir el informe', ir: { vista: 'stats', sub: 'tablero', abrir: 'informe' } },
  { re: /\b(afiches?|poster|flyer)\b/, t: 'Dentro de cada actividad está el botón **Afiche**; en el **Calendario** también está **Afiche de la semana**. Describes la imagen (o usas la sugerencia), y después mueves y agrandas el texto con los dedos.', b: 'Abrir el generador', ir: { abrir: 'afiche' } },
  { re: /\b(compromisos?|actas?|minutas?)\b/, t: 'En **Reuniones** abre o crea el acta y agrega el compromiso con su responsable y fecha. También puedes decirme: "anota un compromiso para Pedro: llamar a la familia Soto el viernes".', b: 'Ir a Reuniones', ir: { vista: 'meetings' } },
  { re: /\bentrevist\w*/, t: 'En **Entrevistas** toca **+ Nueva entrevista**, o dímelo directo: "agenda una entrevista con Jaime Cuenca el jueves a las 19:00".', b: 'Ir a Entrevistas', ir: { vista: 'interviews' } },
  { re: /\b(gastos?|boletas?|presupuesto|rendicion|reembolso)\b/, t: 'En **Presupuesto** toca **Registrar gasto**. Con **Leer boleta con foto** se llenan solos el monto, la fecha y el comercio.', b: 'Ir a Presupuesto', ir: { vista: 'budget' } },
  { re: /\b(aseo|limpieza)\b/, t: 'En **Aseo** ves los turnos de cada familia y los confirmas o cambias.', b: 'Ir a Aseo', ir: { vista: 'cleaning' } },
  { re: /\b(bienestar|ayuda|ayudas)\b/, t: 'En **Bienestar** registras los casos y la ayuda que se entrega; las evaluaciones mensuales te llegan como compromiso.', b: 'Ir a Bienestar', ir: { vista: 'welfare' } },
  { re: /\b(huella|rostro|notificacion\w*|avisos?|perfil|contrasena|clave|telefono|correo)\b/, t: 'Todo eso está en tu **Perfil** (toca tu nombre arriba): notificaciones, entrar con huella o rostro, teléfono y contraseña.', b: 'Abrir mi perfil', ir: { abrir: 'perfil' } },
  { re: /\b(buscar|busco|ficha) (a )?(una )?persona|\bdirectorio\b/, t: 'En **Inicio** toca **Buscar persona** para ver la ficha completa; o pregúntame "cuéntame de Jaime Cuenca".', b: 'Ir a Inicio', ir: { vista: 'home' } },
  { re: /\b(actividad\w*|eventos?|calendario|agend\w*|reserv\w*|capilla|salon|sala)\b/, t: 'Ve a **Calendario** y toca **+ Nueva actividad**. Completa título, fecha, hora y lugar; si ese horario o lugar ya está ocupado, te aviso apenas lo eliges. También puedes pedírmelo: "agenda una noche de hogar el viernes a las 19:30".', b: 'Crear una actividad', ir: { vista: 'calendar', abrir: 'nueva-actividad' } },
];
function ayudaApp(norm) {
  const a = AYUDA_APP.find((x) => x.re.test(norm));
  if (!a) return null;
  return resp(a.t, { opciones: [{ label: a.b, value: a.b, ir: a.ir }] });
}

export function detectarConsultaExtra(norm) {
  if (RE_COMO_APP.test(norm) && AYUDA_APP.some((x) => x.re.test(norm))) return 'comoapp';
  if (RE_FEEDBACK.test(norm)) return 'feedback';
  if (RE_TIPOS.test(norm)) return 'tipos';
  if (RE_PREPARAR.test(norm)) return 'preparar';
  if (RE_FECHAS.test(norm) && !/\bentrevist/.test(norm)) return 'fechas';
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
    case 'fechas': return consultaFechas(norm, data, hoyObj);
    case 'comoapp': return ayudaApp(norm);
    case 'preparar': return consultaPreparar(mensaje, norm, usuario, data, hoyObj, historial);
    case 'semana': return consultaSemana(norm, usuario, data, hoyObj);
    case 'feedback': return consultaFeedback(usuario, data);
    case 'tipos': return consultaTipos(norm, data);
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
Haz un resumen breve y cercano (3 a 5 viñetas): su situación, lo último que pasó con ella y 1 sugerencia práctica si corresponde. Usa SOLO estos datos, no inventes. Tono respetuoso, nunca de juicio.
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

// ---------------- Fechas libres para una actividad ----------------
// Días sin actividades del barrio ni actividades de Estaca que bloqueen.
const MESES_N = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS_N = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const DIAS_C = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
function consultaFechas(norm, data, hoyObj) {
  const hoy = toISO(hoyObj);
  let desde = toISO(sumarDias(hoyObj, 1)); let hasta = toISO(sumarDias(hoyObj, 42)); let periodo = 'las próximas 6 semanas';
  const iMes = MESES_N.findIndex((m) => new RegExp(`\\b${m}\\b`).test(norm));
  if (iMes >= 0) {
    const [y, m] = hoy.split('-').map(Number);
    const anio = iMes + 1 < m ? y + 1 : y;
    const ini = `${anio}-${String(iMes + 1).padStart(2, '0')}-01`;
    const fin = toISO(new Date(anio, iMes + 1, 0));
    desde = ini > desde ? ini : desde; hasta = fin; periodo = MESES_N[iMes];
  } else if (/\bproxima semana\b/.test(norm)) { desde = toISO(sumarDias(hoyObj, 1)); hasta = toISO(sumarDias(hoyObj, 13)); periodo = 'las próximas 2 semanas'; }
  else if (/\beste mes\b/.test(norm)) { const [y, m] = hoy.split('-').map(Number); hasta = toISO(new Date(y, m, 0)); periodo = 'lo que queda del mes'; }
  if (hasta < desde) return resp(`Ya no quedan días de ${periodo} para revisar.`);
  // Días de la semana pedidos (por defecto: viernes y sábados, los habituales para actividades).
  let dias = DIAS_N.map((d, i) => (new RegExp(`\\b${d}s?\\b`).test(norm) ? i : -1)).filter((i) => i >= 0);
  if (/\bfin(es)? de semana\b/.test(norm)) dias = [5, 6];
  const porDefecto = !dias.length;
  if (porDefecto) dias = [5, 6];
  const keywords = data.stakeCalendar?.nonBlockingKeywords;
  const bloqueaEstaca = (f) => (data.stakeEvents || []).some((s) => s.date === f && isBlockingStakeEvent(s, keywords));
  const libres = []; const casi = [];
  const [y0, m0, d0] = desde.split('-').map(Number);
  for (let d = new Date(y0, m0 - 1, d0); toISO(d) <= hasta; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if (!dias.includes(d.getDay())) continue;
    const f = toISO(d);
    if (bloqueaEstaca(f)) continue;
    const ese = (data.events || []).filter((e) => e.date === f && !e.isMeeting);
    if (!ese.length) libres.push(f); else if (ese.length === 1) casi.push({ f, t: ese[0].title });
  }
  const mAct = norm.match(/\b(hacer|organizar|agendar|realizar|programar|tener) (un|una|el|la) ([a-z ]{3,30}?)(?= (en|para|el|este|esta|de|del)\b|[?.!]|$)/);
  const que = mAct ? `${/^(una|la)$/.test(mAct[2]) ? 'una' : 'un'} ${mAct[3].trim()}` : 'una actividad';
  const etiqueta = (f) => { const [y, m, d] = f.split('-').map(Number); const x = new Date(y, m - 1, d); return `${DIAS_C[x.getDay()]} ${d} ${MESES_N[m - 1].slice(0, 3)}`; };
  const nombresDias = dias.map((i) => ({ 0: 'domingos', 1: 'lunes', 2: 'martes', 3: 'miércoles', 4: 'jueves', 5: 'viernes', 6: 'sábados' }[i])).join(' y ');
  if (!libres.length && !casi.length) return resp(`📭 En ${periodo} no encontré ${nombresDias} libres: todos tienen actividades del barrio o de Estaca.`);
  const lista = libres.slice(0, 6);
  const texto = libres.length
    ? `🗓️ ${nombresDias.charAt(0).toUpperCase() + nombresDias.slice(1)} libres en ${periodo} (sin actividades del barrio ni de Estaca): **${libres.slice(0, 8).map(etiqueta).join(', ')}**.${casi.length ? `\n\nCon solo una actividad: ${casi.slice(0, 4).map((c) => `${etiqueta(c.f)} (${c.t})`).join(', ')}.` : ''}${porDefecto ? '\n\nRevisé viernes y sábados; si quieres otro día, dime por ejemplo "¿qué jueves están libres?".' : ''}\n\nToca una fecha para agendar ${que}:`
    : `En ${periodo} no hay ${nombresDias} totalmente libres. Los que tienen solo una actividad: ${casi.slice(0, 6).map((c) => `${etiqueta(c.f)} (${c.t})`).join(', ')}.`;
  return resp(texto, { opciones: (lista.length ? lista : casi.slice(0, 4).map((c) => c.f)).map((f) => ({ label: etiqueta(f), value: `agenda ${que} el ${f}` })) });
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
Tono cercano, de ministración, centrado en las personas (Manual General 4.2: ministrar, no administrar). Máximo ~20 líneas. No inventes datos ni nombres que no estén arriba.`;
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
  const soloHoy = /\b(hoy|mi dia|del dia)\b/.test(norm);
  const manana = /\bmanana\b/.test(norm) && !/\bpasado\s*manana\b/.test(norm);
  // Un día puntual: "¿qué tengo el jueves?", "¿qué tengo el 30?"
  const diaPuntual = !soloHoy && !manana && !/\bsemana\b/.test(norm) ? parseFecha(norm, hoyObj) : null;
  const desde = diaPuntual || (manana ? toISO(sumarDias(hoyObj, 1)) : hoy);
  const r = resumenSemana(usuario, data, { desde, dias: soloHoy || manana || diaPuntual ? 1 : 7 });
  const periodo = soloHoy ? 'hoy' : manana ? 'mañana' : diaPuntual ? `el ${fechaLegible(diaPuntual)}` : 'esta semana';
  const recs = recordatoriosComoItems(usuario, data, r.desde, r.hasta);
  const items = [...r.entrevistas, ...r.compromisos, ...r.actividades, ...recs].sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora)).slice(0, 15)
    .map((x) => ({ tipo: x.tipo === 'compromiso' ? 'compromiso' : x.tipo, titulo: x.titulo, fecha: x.fecha, hora: x.hora, org: x.org, color: x.color }));
  const frase = fraseResumen(r);
  const recTxt = recs.length ? `${recs.length} recordatorio${recs.length === 1 ? '' : 's'}` : '';
  const todo = recTxt ? (/nada pendiente/.test(frase) ? recTxt : `${frase} y ${recTxt}`) : frase;
  return resp(`Para **${periodo}** tienes: ${todo}.${r.totales.solicitudes ? '\n\n📥 Revisa las solicitudes en **Entrevistas → Solicitudes**.' : ''}`, items.length ? { items } : {});
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


// ---------------- Quién puede hacer cada entrevista (Manual General 31.2.2) ----------------
function consultaTipos(norm, data) {
  const ob = obispoDelBarrio(data);
  const k = inferirTipoEntrevista(norm);
  const t = k ? TIPOS_ENTREVISTA.find((x) => x.key === k) : null;
  if (t && !/\b(que entrevistas|cuales)\b/.test(norm)) {
    return resp(`📖 **${t.label}**: ${QUIEN_LABEL[t.quien].toLowerCase()}${t.quien === 'obispo' && ob ? ` (${ob.name})` : ''}${t.ref ? ` — Manual General ${t.ref}` : ''}.${t.nota ? `\n\nℹ️ ${t.nota}` : ''}`);
  }
  const grupo = (q) => TIPOS_ENTREVISTA.filter((x) => x.quien === q).map((x) => `• ${x.label}${x.ref ? ` _(${x.ref})_` : ''}`).join('\n');
  return resp(`📖 **Quién hace cada entrevista** (Manual General, tabla 31.2.2):\n\n`
    + `**Solo el obispo${ob ? ` (${ob.name})` : ''}:**\n${grupo('obispo')}\n\n`
    + `**El obispo o un consejero asignado:**\n${grupo('obispado')}\n\n`
    + `**Presidencias de Cuórum de Élderes / Sociedad de Socorro:**\n${grupo('presidencia')}\n\n`
    + '_Cuando agendas uno de estos tipos, la app revisa que el entrevistador corresponda._');
}
