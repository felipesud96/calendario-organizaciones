// ----------------------------------------------------------------------
// DESERET — CONSULTA LIBRE SOBRE LOS DATOS DE LA APP
// ----------------------------------------------------------------------
// Para cualquier pregunta que no tenga una respuesta "programada"
// ("¿cuáles son los casos de bienestar vigentes?", "¿cuántas veces se ha
// ayudado al hermano Soto?", "¿qué organización tiene más compromisos
// atrasados?", "¿cuánto gastamos este trimestre por organización?"...).
//
// Cómo funciona (3 pasos):
//   1. VISTAS: se arma, para quien pregunta, una "vista" de cada tipo de
//      dato que PUEDE ver — con los mismos permisos y la misma redacción
//      (confidencialidad) que las pantallas de la app. Lo que no puede ver
//      simplemente no existe para la consulta.
//   2. PLAN: la IA recibe solo la DESCRIPCIÓN de esas vistas (nombres de
//      campos, nunca los datos) y arma una consulta en JSON: qué vista,
//      qué filtros, si contar / sumar / agrupar / listar.
//   3. RESULTADO: el servidor ejecuta la consulta (los números los calcula
//      el programa, no la IA) y la IA redacta la respuesta con ese
//      resultado. Si hay varias filas, se muestra además como cuadro.
//
// Si no hay IA configurada o la pregunta no es sobre datos, devuelve null
// y Deseret sigue con su flujo de siempre.
// ----------------------------------------------------------------------
import { isObispadoLeader } from './routes/stake.js';
import { isWelfareCommitteeMember } from './routes/welfare.js';
import { orgSeesAllInterviews } from './routes/interviews.js';
import { canSeeMeeting } from './routes/events.js';
import { withMeetingInfo } from './routes/meetings.js';
import { isMinisteringFocusLeaderHombres, isMinisteringFocusLeaderMujeres } from './routes/directory.js';
import { computeCuadrante, ageFromBirthDate, categoryFor, isAdultMale, isAdultFemale } from './pastoralFocus.js';
import { INDICATOR_DEFS } from './wardGrowth.js';
import { TIPOS_ENTREVISTA } from './tiposEntrevista.js';
import { callingLabel } from './db.js';
import { resp, jsonConIA, redactarConIA, filtrarAlucinacion, fechaLegible } from './chat.js';

const MAX_FILAS_TABLA = 25;
const corto = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const dia = (s) => (s ? String(s).slice(0, 10) : '');
const siNo = (v) => (v === true ? 'sí' : v === false ? 'no' : '');
const nombreNatural = (n) => { const s = String(n || ''); if (!s.includes(',')) return s; const [a, b] = s.split(','); return `${b.trim()} ${a.trim()}`; };
const trimestreDe = (fecha) => { const [y, m] = String(fecha || '').split('-').map(Number); return y && m ? `T${Math.ceil(m / 3)} ${y}` : ''; };

// ======================================================================
// 1. VISTAS (con permisos)
// ======================================================================
// Cada vista: { descripcion, campos: { campo: 'descripción (valores)' }, filas() }.
// filas() se calcula solo si la consulta la usa.
function construirVistas(u, data) {
  const org = (id) => data.organizations.find((o) => o.id === Number(id));
  const orgNombre = (id) => org(id)?.name || '';
  const usuarioNombre = (id) => data.users.find((x) => x.id === Number(id))?.name || '';
  const obispado = isObispadoLeader(u, data);
  const rol = u.role;
  const v = {};

  // ---------------- Bienestar ----------------
  if (['admin', 'leader'].includes(rol) && isWelfareCommitteeMember(u, data)) {
    const casos = data.welfareCases || [];
    v.bienestar_casos = {
      descripcion: 'Casos de bienestar (uno por persona/necesidad). "Vigente" = estado abierto o en_seguimiento.',
      campos: {
        persona: 'nombre de la persona ayudada', estado: 'abierto | en_seguimiento | cerrado', vigente: 'sí | no',
        categorias: 'alimento, vivienda, empleo, medico, otro (puede tener varias, separadas por coma)',
        descripcion: 'descripción breve de la necesidad', responsable: 'quién lleva el caso',
        creado: 'fecha YYYY-MM-DD', actualizado: 'fecha', tipo_ayuda: 'una vez | por período', meses_ayuda: 'número',
        ayuda_otorgada: 'fecha en que se otorgó la ayuda', proxima_revision: 'fecha', seguimientos: 'cantidad de notas de seguimiento',
        revisiones: 'cantidad de revisiones', extensiones: 'veces que se decidió extender la ayuda', cierres: 'veces cerrado', reaperturas: 'veces reabierto',
        cerrado_el: 'fecha',
      },
      filas: () => casos.map((c) => ({
        persona: nombreNatural(c.memberName), estado: c.status, vigente: siNo(c.status !== 'cerrado'),
        categorias: (c.categories || []).join(', '), descripcion: corto(c.description, 140), responsable: usuarioNombre(c.createdBy),
        creado: dia(c.createdAt), actualizado: dia(c.updatedAt),
        tipo_ayuda: c.aidType === 'periodo' ? 'por período' : c.aidType === 'unica_vez' ? 'una vez' : '',
        meses_ayuda: c.aidType === 'periodo' ? Number(c.aidMonths) || null : null,
        ayuda_otorgada: dia(c.aidGrantedAt), proxima_revision: dia(c.nextReviewDate),
        seguimientos: (c.actions || []).length, revisiones: (c.reviews || []).length,
        extensiones: (c.reviews || []).filter((r) => r.decision === 'extender').length,
        cierres: (c.closures || []).length, reaperturas: (c.reopenLog || []).length, cerrado_el: dia(c.closedAt),
      })),
    };
    v.bienestar_historial = {
      descripcion: 'Historial de cada caso de bienestar, un evento por fila: apertura, ayuda otorgada, seguimientos, revisiones, cierres y reaperturas. Sirve para "cuántas veces se ha ayudado a…".',
      campos: {
        persona: 'nombre', fecha: 'YYYY-MM-DD', evento: 'caso abierto | ayuda otorgada | seguimiento | revisión: extender | revisión: solucionado | cierre | reapertura',
        detalle: 'nota breve', categorias: 'categorías del caso',
      },
      filas: () => casos.flatMap((c) => {
        const base = { persona: nombreNatural(c.memberName), categorias: (c.categories || []).join(', ') };
        return [
          { ...base, fecha: dia(c.createdAt), evento: 'caso abierto', detalle: corto(c.description, 100) },
          ...(c.aidGrantedAt ? [{ ...base, fecha: dia(c.aidGrantedAt), evento: 'ayuda otorgada', detalle: c.aidType === 'periodo' ? `por ${c.aidMonths} mes(es)` : 'una vez' }] : []),
          ...(c.actions || []).map((a) => ({ ...base, fecha: dia(a.date || a.createdAt), evento: 'seguimiento', detalle: corto(a.note, 100) })),
          ...(c.reviews || []).map((r) => ({ ...base, fecha: dia(r.date || r.createdAt), evento: `revisión: ${r.decision}`, detalle: corto(r.notes, 100) })),
          ...(c.closures || []).map((x) => ({ ...base, fecha: dia(x.closedAt), evento: 'cierre', detalle: corto(x.note, 100) })),
          ...(c.reopenLog || []).map((x) => ({ ...base, fecha: dia(x.reopenedAt), evento: 'reapertura', detalle: '' })),
        ];
      }),
    };
  }

  // ---------------- Entrevistas ----------------
  const tipoLabel = (k) => TIPOS_ENTREVISTA.find((t) => t.key === k)?.label || 'General / seguimiento';
  let entrevistas = [];
  if (['member', 'ward_clerk', 'financial_clerk'].includes(rol)) entrevistas = (data.interviews || []).filter((i) => Number(i.memberUserId) === u.id);
  else if (orgSeesAllInterviews(u, data)) entrevistas = data.interviews || [];
  else entrevistas = (data.interviews || []).filter((i) => Number(i.organizationId) === Number(u.organizationId) || Number(i.memberUserId) === u.id);
  v.entrevistas = {
    descripcion: 'Entrevistas agendadas y realizadas (una fila por persona entrevistada).',
    campos: {
      persona: 'nombre del entrevistado', organizacion: 'organización que entrevista', entrevistador: 'nombre de quien entrevista',
      tipo: 'tipo de entrevista', fecha: 'YYYY-MM-DD', hora: 'HH:MM', trimestre: 'T1 2026, etc.',
      estado: 'agendada | realizada | no realizada | sin marcar (pasó y no se marcó)', lugar: 'lugar', motivo: 'motivo breve', resultado: 'comentario de resultado',
    },
    filas: () => {
      const hoy = new Date().toISOString().slice(0, 10);
      return entrevistas.map((i) => ({
        persona: nombreNatural(i.memberName), organizacion: orgNombre(i.organizationId), entrevistador: i.interviewerName || '',
        tipo: tipoLabel(i.interviewType), fecha: i.date, hora: i.startTime || '', trimestre: trimestreDe(i.date),
        estado: i.status === 'done' ? 'realizada' : i.status === 'not_done' ? 'no realizada' : i.date >= hoy ? 'agendada' : 'sin marcar',
        lugar: [i.location, i.sala].filter(Boolean).join(' · '), motivo: corto(i.description, 100), resultado: corto(i.comment, 100),
      }));
    },
  };

  // ---------------- Solicitudes de entrevista ----------------
  if (!['member', 'ward_clerk', 'financial_clerk'].includes(rol)) {
    const sol = obispado ? data.interviewRequests || [] : (data.interviewRequests || []).filter((r) => Number(r.organizationId) === Number(u.organizationId));
    v.solicitudes_entrevista = {
      descripcion: 'Solicitudes de entrevista hechas por miembros (desde la app o el enlace público).',
      campos: { persona: 'quién pidió', organizacion: 'organización', lider: 'con quién pidió', fecha: 'fecha pedida', hora: 'hora', estado: 'pendiente | confirmada | rechazada', origen: 'app | enlace', pedida_el: 'fecha de la solicitud' },
      filas: () => sol.map((r) => ({
        persona: nombreNatural(r.memberName), organizacion: orgNombre(r.organizationId), lider: r.targetLeaderName || '', fecha: r.date, hora: r.startTime || '',
        estado: { pending: 'pendiente', confirmed: 'confirmada', rejected: 'rechazada' }[r.status] || r.status, origen: r.source === 'enlace' ? 'enlace' : 'app', pedida_el: dia(r.createdAt),
      })),
    };
  }

  // ---------------- Actas, temas y compromisos ----------------
  if (['admin', 'leader', 'ward_clerk'].includes(rol)) {
    const actas = () => (obispado ? data.meetings || [] : (data.meetings || []).filter((m) => Number(m.organizationId) === Number(u.organizationId)))
      .map((m) => withMeetingInfo(m, data, u));
    const tipoActa = (t) => ({ consejo_barrio: 'consejo de barrio', coordinacion_ministracion: 'coordinación de ministración' }[t] || 'reunión');
    v.actas = {
      descripcion: 'Reuniones con acta (consejos, presidencias, comités).',
      campos: { titulo: 'título', tipo: 'reunión | consejo de barrio | coordinación de ministración', organizacion: 'organización', fecha: 'YYYY-MM-DD', trimestre: 'T1 2026…', estado: 'activa | archivada', temas: 'cantidad de temas', compromisos: 'cantidad de compromisos', confidencial: 'sí | no' },
      filas: () => actas().filter((m) => !m.sueltos).map((m) => ({
        titulo: m.title, tipo: tipoActa(m.type), organizacion: m.organizationName, fecha: m.date, trimestre: trimestreDe(m.date),
        estado: m.status === 'archived' ? 'archivada' : 'activa', temas: (m.agendaItems || []).length, compromisos: (m.commitments || []).length, confidencial: siNo(!!m.confidential),
      })),
    };
    v.actas_temas = {
      descripcion: 'Temas tratados en las actas, con lo que se acordó (los confidenciales aparecen como "(Tema confidencial)").',
      campos: { acta: 'título del acta', fecha: 'fecha del acta', organizacion: 'organización', tema: 'tema', presenta: 'quién lo presenta', acuerdo: 'acuerdo / qué se hará', seguimiento: 'seguimiento', resuelto: 'sí | no' },
      filas: () => actas().filter((m) => !m.sueltos).flatMap((m) => (m.agendaItems || []).map((a) => ({
        acta: m.title, fecha: m.date, organizacion: m.organizationName, tema: corto(a.topic, 120), presenta: a.presenter || '',
        acuerdo: corto(a.acuerdo || a.queSeHara || a.notes, 160), seguimiento: corto(a.seguimiento || a.quienLoHara, 100), resuelto: siNo(!!a.seguimientoResuelto),
      }))),
    };
    v.compromisos = {
      descripcion: 'Compromisos (tareas) asignados en las actas. "Atrasado" = pendiente con fecha límite ya pasada.',
      campos: {
        descripcion: 'qué hay que hacer', responsable: 'persona asignada', organizacion: 'organización del acta', acta: 'título del acta',
        fecha_limite: 'YYYY-MM-DD', estado: 'pendiente | cumplido | no cumplido', atrasado: 'sí | no', prioridad: 'alta | media | baja', cumplido_el: 'fecha', trimestre: 'trimestre de la fecha límite',
      },
      filas: () => actas().flatMap((m) => (m.commitments || []).map((c) => ({
        descripcion: corto(c.description, 140), responsable: c.assignedToName || '', organizacion: m.organizationName, acta: m.sueltos ? '(sin reunión)' : m.title,
        fecha_limite: c.dueDate || '', estado: { pending: 'pendiente', completed: 'cumplido', not_fulfilled: 'no cumplido' }[c.status] || c.status,
        atrasado: siNo(!!c.isOverdue), prioridad: c.priority || 'media', cumplido_el: dia(c.completedAt), trimestre: trimestreDe(c.dueDate),
      }))),
    };
  }

  // ---------------- Actividades ----------------
  const verEvaluacion = (e) => ['admin', 'leader'].includes(rol) && (rol === 'admin' || Number(e.organizationId) === Number(u.organizationId));
  v.actividades = {
    descripcion: 'Actividades y eventos del calendario (y reuniones privadas que puede ver). Incluye la asistencia evaluada cuando la hay.',
    campos: {
      titulo: 'título', organizacion: 'organización que la organiza', invitadas: 'otras organizaciones participantes', fecha: 'YYYY-MM-DD', hora: 'HH:MM', trimestre: 'T1 2026…',
      lugar: 'lugar', proposito: 'Espiritual | Físico | Académico | Social | Servicio', de_barrio: 'sí | no (actividad de todo el barrio)', es_reunion: 'sí | no',
      confirmados: 'personas que confirmaron asistencia', asistencia_esperada: 'número', asistencia_real: 'número',
    },
    filas: () => (data.events || []).filter((e) => canSeeMeeting(u, e)).map((e) => {
      const ev = verEvaluacion(e) ? (data.eventEvaluations || []).find((x) => Number(x.eventId) === e.id) : null;
      return {
        titulo: e.title, organizacion: orgNombre(e.organizationId), invitadas: (e.involvedOrganizationIds || []).map(orgNombre).filter(Boolean).join(', '),
        fecha: e.date, hora: e.startTime || '', trimestre: trimestreDe(e.date), lugar: [e.location, e.sala].filter(Boolean).join(' · '), proposito: e.purpose || '',
        de_barrio: siNo(!!e.isWardActivity), es_reunion: siNo(!!e.isMeeting), confirmados: (e.rsvps || []).filter((r) => r.response === 'yes').length,
        asistencia_esperada: ev ? Number(ev.expectedAttendance) || null : null, asistencia_real: ev ? Number(ev.actualAttendance) || null : null,
      };
    }),
  };

  // ---------------- Presupuesto ----------------
  if (['admin', 'leader', 'financial_clerk'].includes(rol)) {
    const total = obispado || rol === 'financial_clerk';
    const cat = (x) => (x.categoryType === 'custom' ? (data.budgetCategories || []).find((c) => c.id === Number(x.budgetCategoryId))?.name || 'Otra' : orgNombre(x.organizationId));
    const mia = (x) => total || (x.categoryType === 'organization' && Number(x.organizationId) === Number(u.organizationId));
    const q = (s) => { const m = String(s || '').match(/^(\d{4})-?Q?(\d)$/i); return m ? `T${m[2]} ${m[1]}` : String(s || ''); };
    v.presupuesto_gastos = {
      descripcion: 'Gastos registrados del presupuesto (montos en pesos chilenos).',
      campos: { categoria: 'organización o categoría', trimestre: 'T1 2026…', monto: 'número (CLP)', descripcion: 'detalle', fecha: 'YYYY-MM-DD' },
      filas: () => (data.budgetExpenses || []).filter(mia).map((x) => ({ categoria: cat(x), trimestre: q(x.quarter), monto: Number(x.amount) || 0, descripcion: corto(x.description, 100), fecha: x.date || '' })),
    };
    v.presupuesto_asignado = {
      descripcion: 'Presupuesto asignado por trimestre y categoría (CLP).',
      campos: { categoria: 'organización o categoría', trimestre: 'T1 2026…', monto: 'número (CLP)' },
      filas: () => (data.budgetAllocations || []).filter(mia).map((x) => ({ categoria: cat(x), trimestre: q(x.quarter), monto: Number(x.amount) || 0 })),
    };
    v.presupuesto_solicitudes = {
      descripcion: 'Solicitudes de gasto (reembolsos) y su estado.',
      campos: { categoria: 'organización o categoría', monto: 'número (CLP)', descripcion: 'detalle', fecha: 'fecha', estado: 'pendiente | aprobada | rechazada', solicitante: 'quién pidió' },
      filas: () => (data.budgetExpenseRequests || []).filter((r) => total || Number(r.requestedBy) === u.id).map((r) => ({
        categoria: cat(r), monto: Number(r.amount) || 0, descripcion: corto(r.description, 100), fecha: r.date || dia(r.createdAt),
        estado: { pending: 'pendiente', approved: 'aprobada', rejected: 'rechazada' }[r.status] || r.status, solicitante: usuarioNombre(r.requestedBy),
      })),
    };
  }

  // ---------------- Discursos, aseo y Directorio (Obispado) ----------------
  if (['admin', 'leader'].includes(rol) && obispado) {
    v.discursos = {
      descripcion: 'Discursos dados en la reunión sacramental.',
      campos: { persona: 'quién habló', fecha: 'YYYY-MM-DD', trimestre: 'T1 2026…', tema: 'tema' },
      filas: () => (data.talks || []).map((t) => ({ persona: nombreNatural(t.speakerName), fecha: t.date, trimestre: trimestreDe(t.date), tema: corto(t.topic, 100) })),
    };
    v.aseo = {
      descripcion: 'Turnos de aseo de la capilla por familia.',
      campos: { familia: 'nombre de la familia', fecha: 'YYYY-MM-DD', estado: 'agendado | realizado | no realizado' },
      filas: () => (data.cleaningShifts || []).map((s) => ({ familia: s.familyName || (data.families || []).find((f) => f.id === s.familyId)?.name || '', fecha: s.date, estado: { done: 'realizado', not_done: 'no realizado' }[s.status] || 'agendado' })),
    };
    v.directorio = {
      descripcion: 'Directorio de miembros del barrio (todas las edades).',
      campos: { persona: 'nombre', edad: 'años', sexo: 'hombre | mujer', organizacion: 'Primaria | Hombres Jóvenes | Mujeres Jóvenes | Cuórum de Élderes | Sociedad de Socorro | Sin clasificar', tiene_cuenta: 'sí | no (usa la app)' },
      filas: () => (data.directoryMembers || []).map((m) => ({
        persona: nombreNatural(m.name), edad: ageFromBirthDate(m.birthDate), sexo: m.sex === 'V' ? 'hombre' : 'mujer', organizacion: categoryFor(m),
        tiene_cuenta: siNo(data.users.some((x) => x.name && nombreNatural(x.name).toLowerCase() === nombreNatural(m.name).toLowerCase())),
      })),
    };
  }

  // ---------------- Enfoque Ministración ----------------
  const verH = isMinisteringFocusLeaderHombres(u, data);
  const verM = isMinisteringFocusLeaderMujeres(u, data);
  if (verH || verM) {
    const miembros = () => (data.directoryMembers || []).filter((m) => (verH && isAdultMale(m)) || (verM && isAdultFemale(m)));
    const conv = { si: 'sí', no: 'pendiente', na: 'no aplica' };
    v.enfoque_ministracion = {
      descripcion: `Enfoque Ministración: evaluación de ${verH && verM ? 'hombres y mujeres adultos' : verH ? 'hombres adultos' : 'mujeres adultas'}. Cuadrantes: Retener (asiste y cumple todo), Enfoque (asiste pero le falta algo), Actividad (cumple todo pero asiste poco), Rescatar (asiste poco y le falta algo).`,
      campos: {
        persona: 'nombre', edad: 'años', sexo: 'hombre | mujer', organizacion: 'Cuórum de Élderes | Sociedad de Socorro', evaluado: 'sí | no',
        cuadrante: 'Retener | Enfoque | Actividad | Rescatar', asistencia: 'Alto | Medio | Bajo', tiene_llamamiento: 'sí | no', recomendacion_vigente: 'sí | no',
        investidura: 'sí | pendiente | no aplica', sellamiento: 'sí | pendiente | no aplica', ordenacion: 'sí | pendiente | no aplica', convenio_pendiente: 'sí | no', actualizado: 'fecha de la última evaluación',
      },
      filas: () => miembros().map((m) => {
        const f = (data.pastoralFocus || []).find((x) => x.memberId === m.id);
        const ok = !!(f && f.asistencia);
        return {
          persona: nombreNatural(m.name), edad: ageFromBirthDate(m.birthDate), sexo: m.sex === 'V' ? 'hombre' : 'mujer', organizacion: categoryFor(m), evaluado: siNo(ok),
          cuadrante: ok ? computeCuadrante(f) : '', asistencia: ok ? f.asistencia : '', tiene_llamamiento: ok ? siNo(f.tieneLlamamiento) : '', recomendacion_vigente: ok ? siNo(f.recomendacionVigente) : '',
          investidura: ok && f.convenios ? conv[f.convenios.investidura] || '' : '', sellamiento: ok && f.convenios ? conv[f.convenios.sellamiento] || '' : '',
          ordenacion: ok && f.convenios ? conv[f.convenios.ordenacion] || '' : '', convenio_pendiente: ok ? siNo(!!f.faltaConvenio) : '', actualizado: ok ? dia(f.updatedAt) : '',
        };
      }),
    };
    v.enfoque_historial = {
      descripcion: 'Cambios anteriores de cada persona en el Enfoque Ministración (en qué cuadrante estaba antes y hasta cuándo).',
      campos: { persona: 'nombre', hasta: 'fecha en que cambió', cuadrante: 'cuadrante que tenía', asistencia: 'Alto | Medio | Bajo' },
      filas: () => miembros().flatMap((m) => ((data.pastoralFocus || []).find((x) => x.memberId === m.id)?.history || []).map((h) => ({
        persona: nombreNatural(m.name), hasta: dia(h.changedAt), cuadrante: h.cuadrante || '', asistencia: h.asistencia || '',
      }))),
    };
  }

  // ---------------- Crecimiento del Barrio ----------------
  if (['admin', 'leader', 'ward_clerk'].includes(rol)) {
    v.crecimiento_indicadores = {
      descripcion: 'Indicadores trimestrales de Crecimiento del Barrio (valor real y potencial). Porcentaje = real / potencial.',
      campos: { trimestre: 'T1 2026…', anio: 'año', numero_trimestre: '1-4', indicador: INDICATOR_DEFS.map((d) => d.label).join(' | '), real: 'número', potencial: 'número o vacío', porcentaje: 'real/potencial en %' },
      filas: () => (data.quarterlyStats || []).flatMap((s) => INDICATOR_DEFS.map((d) => {
        const x = s.indicators?.[String(d.number)] || {};
        const real = x.real ?? null; const pot = x.pot ?? null;
        return { trimestre: s.label || `T${s.quarter} ${s.year}`, anio: s.year, numero_trimestre: s.quarter, indicador: d.label, real, potencial: pot, porcentaje: real !== null && pot ? Math.round((real / pot) * 100) : null };
      })),
    };
    v.conversos = {
      descripcion: 'Conversos registrados en cada trimestre y su seguimiento.',
      campos: { trimestre: 'T1 2026…', persona: 'nombre', sexo: 'hombre | mujer', edad: 'años', asiste: 'sí | no', tiene_llamamiento: 'sí | no' },
      filas: () => (data.quarterlyStats || []).flatMap((s) => (s.converts || []).map((c) => ({
        trimestre: s.label || `T${s.quarter} ${s.year}`, persona: c.name, sexo: c.sex === 'V' ? 'hombre' : 'mujer', edad: c.age ?? null, asiste: siNo(c.attended), tiene_llamamiento: siNo(c.hasCalling),
      }))),
    };
  }

  // ---------------- Acuerdos entre organizaciones ----------------
  if (['admin', 'leader', 'ward_clerk'].includes(rol)) {
    v.acuerdos = {
      descripcion: 'Acuerdos de coordinación entre organizaciones.',
      campos: { titulo: 'título', organizaciones: 'organizaciones participantes', estado: 'activo | archivado', descripcion: 'detalle' },
      filas: () => (data.interOrgAgreements || []).filter((a) => obispado || (a.organizationIds || []).map(Number).includes(Number(u.organizationId))).map((a) => ({
        titulo: a.title, organizaciones: (a.organizationIds || []).map(orgNombre).join(', '), estado: a.status === 'archived' ? 'archivado' : 'activo', descripcion: corto(a.description, 120),
      })),
    };
  }

  // ---------------- Usuarios / líderes ----------------
  if (['admin', 'leader'].includes(rol)) {
    const ROL = { admin: 'Administrador', leader: 'Líder', member: 'Miembro', executive_secretary: 'Secretario Ejecutivo', ward_clerk: 'Secretario de Barrio', financial_clerk: 'Secretario de Finanzas' };
    v.usuarios = {
      descripcion: 'Personas con cuenta en la app, con su rol, organización y llamamiento.',
      campos: { persona: 'nombre', rol: Object.values(ROL).join(' | '), organizacion: 'organización', llamamiento: 'Obispo, Presidente/a, Consejero/a, Secretario/a o vacío' },
      filas: () => data.users.map((x) => ({ persona: x.name, rol: ROL[x.role] || x.role, organizacion: orgNombre(x.organizationId), llamamiento: callingLabel(orgNombre(x.organizationId), x.calling) || '' })),
    };
  }

  // ---------------- Mis recordatorios ----------------
  v.mis_recordatorios = {
    descripcion: 'Recordatorios personales que le pidió a Deseret.',
    campos: { texto: 'qué recordar', fecha: 'YYYY-MM-DD', hora: 'HH:MM', enviado: 'sí | no' },
    filas: () => (data.recordatorios || []).filter((r) => Number(r.userId) === u.id).map((r) => ({ texto: r.texto, fecha: r.fecha, hora: r.hora, enviado: siNo(!!r.enviado) })),
  };
  return v;
}

// ======================================================================
// 2. EJECUCIÓN DE UNA CONSULTA
// ======================================================================
const nrm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const palabras = (s) => nrm(s).replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !['de', 'del', 'la', 'las', 'los', 'el', 'hermano', 'hermana', 'hno', 'hna'].includes(w));
const esNumero = (x) => typeof x === 'number' || (typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Number(x)) && !/^\d{4}-\d{2}/.test(x));

// "contiene" para nombres: todas las palabras buscadas aparecen (o son el
// comienzo de alguna palabra) — "Soto" encuentra "Juan Soto Pérez".
function contiene(valor, buscado) {
  const w = palabras(valor); const b = palabras(buscado);
  if (!b.length) return nrm(valor).includes(nrm(buscado));
  return b.every((x) => w.some((p) => p === x || (x.length >= 3 && p.startsWith(x)))) || nrm(valor).includes(nrm(buscado));
}

function cumple(fila, { campo, op = '=', valor }) {
  if (!(campo in fila)) return true; // campo inexistente: no se filtra (evita respuestas vacías por un error de la IA)
  const x = fila[campo];
  const cmp = (a, b) => (esNumero(a) && esNumero(b) ? Number(a) - Number(b) : nrm(a).localeCompare(nrm(b)));
  switch (op) {
    case '=': case '==': return esNumero(x) && esNumero(valor) ? Number(x) === Number(valor) : nrm(x) === nrm(valor) || (String(valor).length >= 3 && /persona|responsable|entrevistador|familia|lider|solicitante/.test(campo) && contiene(x, valor));
    case '!=': return nrm(x) !== nrm(valor);
    case 'contiene': return contiene(x, valor);
    case 'no_contiene': return !contiene(x, valor);
    case '>': return x !== '' && x !== null && cmp(x, valor) > 0;
    case '>=': return x !== '' && x !== null && cmp(x, valor) >= 0;
    case '<': return x !== '' && x !== null && cmp(x, valor) < 0;
    case '<=': return x !== '' && x !== null && cmp(x, valor) <= 0;
    case 'entre': return Array.isArray(valor) && x !== '' && x !== null && cmp(x, valor[0]) >= 0 && cmp(x, valor[1]) <= 0;
    case 'en': return Array.isArray(valor) && valor.some((v) => nrm(v) === nrm(x));
    case 'vacio': return x === '' || x === null || x === undefined;
    case 'no_vacio': return !(x === '' || x === null || x === undefined);
    default: return true;
  }
}

function agregado(filas, operacion, campo) {
  if (operacion === 'contar') return filas.length;
  const nums = filas.map((f) => f[campo]).filter((x) => x !== null && x !== '' && esNumero(x)).map(Number);
  if (!nums.length) return null;
  if (operacion === 'sumar') return nums.reduce((a, b) => a + b, 0);
  if (operacion === 'promedio') return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
  if (operacion === 'minimo') return Math.min(...nums);
  if (operacion === 'maximo') return Math.max(...nums);
  return filas.length;
}

export function ejecutarConsulta(c, vistas) {
  const vista = vistas[c.coleccion];
  if (!vista) return { error: `sin acceso o no existe: ${c.coleccion}` };
  let filas = vista.filas();
  for (const f of Array.isArray(c.filtros) ? c.filtros : []) filas = filas.filter((x) => cumple(x, f));
  const operacion = c.operacion || 'listar';
  const agrupar = [].concat(c.agrupar || []).filter((g) => filas.length === 0 || g in filas[0]);
  if (agrupar.length) {
    const grupos = new Map();
    for (const x of filas) {
      // Campos con varios valores separados por coma (ej. categorías) cuentan en cada uno.
      const claves = agrupar.length === 1 && /categorias|invitadas|organizaciones/.test(agrupar[0])
        ? String(x[agrupar[0]] || '(sin dato)').split(/\s*,\s*/).filter(Boolean)
        : [agrupar.map((g) => (x[g] === '' || x[g] === null || x[g] === undefined ? '(sin dato)' : x[g])).join(' · ')];
      for (const k of claves) { if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(x); }
    }
    const op = operacion === 'listar' ? 'contar' : operacion;
    let res = [...grupos.entries()].map(([grupo, fs]) => ({ grupo, valor: agregado(fs, op, c.campo) }));
    const dir = c.ordenar?.dir === 'asc' ? 1 : -1;
    res.sort((a, b) => (c.ordenar?.campo === 'grupo' ? String(a.grupo).localeCompare(String(b.grupo)) * (c.ordenar?.dir === 'desc' ? -1 : 1) : ((a.valor ?? 0) - (b.valor ?? 0)) * dir));
    if (c.limite) res = res.slice(0, Number(c.limite));
    return { tipo: 'grupos', agrupadoPor: agrupar.join(' · '), operacion: op, campo: c.campo || null, total_filas: filas.length, grupos: res };
  }
  if (operacion !== 'listar') return { tipo: 'valor', operacion, campo: c.campo || null, total_filas: filas.length, valor: agregado(filas, operacion, c.campo) };
  if (c.ordenar?.campo && filas.length && c.ordenar.campo in filas[0]) {
    const k = c.ordenar.campo; const dir = c.ordenar.dir === 'asc' ? 1 : -1;
    filas = [...filas].sort((a, b) => (esNumero(a[k]) && esNumero(b[k]) ? (Number(a[k]) - Number(b[k])) : String(a[k] ?? '').localeCompare(String(b[k] ?? ''))) * dir);
  }
  const total = filas.length;
  const campos = Array.isArray(c.campos) && c.campos.length ? c.campos.filter((k) => !filas.length || k in filas[0]) : null;
  const lim = Math.min(Number(c.limite) || 40, 60);
  return { tipo: 'filas', total_filas: total, filas: filas.slice(0, lim).map((x) => (campos ? Object.fromEntries(campos.map((k) => [k, x[k]])) : x)) };
}

// ======================================================================
// 3. PREGUNTA → PLAN → RESPUESTA
// ======================================================================
function esquemaTexto(vistas) {
  return Object.entries(vistas).map(([nombre, v]) => `### ${nombre}: ${v.descripcion}\n${Object.entries(v.campos).map(([k, d]) => `- ${k}: ${d}`).join('\n')}`).join('\n\n');
}

const PARECE_DATOS = /\b(cuant[oa]s?|cual(es)?|quien(es)?|que (casos?|personas?|hermanos?|hermanas?|familias?|organizacion|actividades?|entrevistas?|compromisos?|gastos?|discursos?)|lista\w*|muestra\w*|dame|dime|compar\w*|promedio|total(es)?|suma|mas|menos|mayor|menor|ultim[oa]s?|historial|veces|estadistic\w*|ranking|porcentaje|cuando fue|hay\b|tiene[n]?\b|vigentes?|pendientes?|atrasad\w*|gastad\w*|gasto|presupuesto|bienestar)\b/;

export function pareceConsultaDeDatos(norm) {
  // Lo próximo de la agenda ya tiene su respuesta con tarjetas de colores.
  if (/\b(actividad(es)?|eventos?|calendario|aseo|limpieza|entrevistas?)\b/.test(norm) && /\b(proxim\w*|siguiente|esta semana|este mes|hoy|manana|que viene)\b/.test(norm)) return false;
  return PARECE_DATOS.test(norm);
}

export async function consultaLibre({ mensaje, usuario, data, historial = [], hoyISO, breve = false, planificar = jsonConIA, redactar = redactarConIA }) {
  if (!usuario) return null;
  const vistas = construirVistas(usuario, data);
  const orgNombre = data.organizations.find((o) => o.id === Number(usuario.organizationId))?.name || '';
  const contextoPrevio = (historial || []).slice(-2).map((h) => `Usuario: ${corto(h.user, 200)}\nDeseret: ${corto(h.bot, 300)}`).join('\n');
  const sistema = `Eres el planificador de consultas de Deseret (app OrganizaSion de un barrio de La Iglesia de Jesucristo de los Santos de los Últimos Días). Hoy es ${hoyISO}. Quien pregunta: rol ${usuario.role}${orgNombre ? `, organización ${orgNombre}` : ''}.
Estas son las ÚNICAS colecciones de datos que esta persona puede consultar (otras no existen para ella):

${esquemaTexto(vistas)}

Devuelve SOLO un JSON con esta forma:
{"aplica": true|false, "consultas": [ {"coleccion": "...", "filtros": [{"campo": "...", "op": "= | != | contiene | no_contiene | > | >= | < | <= | entre | en | vacio | no_vacio", "valor": ...}], "operacion": "listar | contar | sumar | promedio | minimo | maximo", "campo": "campo numérico para sumar/promedio/minimo/maximo", "agrupar": "campo" o ["campo1","campo2"], "ordenar": {"campo": "...", "dir": "asc|desc"}, "limite": número, "campos": ["campos a mostrar al listar"] } ], "sin_acceso": "si la pregunta es sobre datos que NO están en las colecciones de arriba, di brevemente cuáles"}
Reglas:
- "aplica": false si la pregunta no es sobre datos de la app (saludos, cómo usar la app, doctrina, agendar/crear/modificar algo).
- Usa hasta 4 consultas (por ejemplo, una por período o por grupo para comparar).
- Para personas usa op "contiene" con el apellido o nombre (ej. {"campo":"persona","op":"contiene","valor":"Soto"}).
- Fechas en formato YYYY-MM-DD; "este año" = ${hoyISO.slice(0, 4)}-01-01 a ${hoyISO.slice(0, 4)}-12-31; "este mes", "el trimestre pasado", etc. calcúlalos desde hoy. Para trimestres también puedes filtrar por el campo "trimestre" (ej. "T3 ${hoyISO.slice(0, 4)}").
- Al listar, elige en "campos" solo los 3 a 6 campos más útiles para responder y ordena de forma lógica (fechas recientes primero).
- "¿cuántas veces se ha ayudado a X?" → bienestar_historial filtrado por persona (y bienestar_casos para el detalle).
- "vigentes" en bienestar = campo vigente "sí". "Atrasados" en compromisos = atrasado "sí".
- No inventes colecciones ni campos.`;
  const plan = await planificar(sistema, `${contextoPrevio ? `Conversación reciente:\n${contextoPrevio}\n\n` : ''}Pregunta: ${mensaje}`);
  if (!plan || plan.aplica === false || !Array.isArray(plan.consultas) || !plan.consultas.length) {
    if (plan?.sin_acceso) return resp(`🔒 ${plan.sin_acceso}`);
    return null;
  }

  const resultados = plan.consultas.slice(0, 4).map((c) => ({ consulta: c, resultado: ejecutarConsulta(c, vistas) }));
  if (resultados.every((r) => r.resultado.error)) {
    return plan.sin_acceso ? resp(`🔒 ${plan.sin_acceso}`) : null;
  }

  // Cuadro: el primer resultado con varias filas o grupos.
  let tabla = null;
  for (const { consulta, resultado } of resultados) {
    if (resultado.tipo === 'grupos' && resultado.grupos.length > 1) {
      const etiqueta = { contar: 'Cantidad', sumar: `Total${resultado.campo ? ` ${resultado.campo}` : ''}`, promedio: `Promedio${resultado.campo ? ` ${resultado.campo}` : ''}`, minimo: 'Mínimo', maximo: 'Máximo' }[resultado.operacion] || 'Valor';
      tabla = { columnas: [titular(resultado.agrupadoPor), titular(etiqueta)], filas: resultado.grupos.slice(0, MAX_FILAS_TABLA).map((g) => [String(g.grupo), formatoNumero(g.valor, consulta.campo)]), voz: 'filas' };
      break;
    }
    if (resultado.tipo === 'filas' && resultado.filas.length > 1) {
      const cols = Object.keys(resultado.filas[0]).slice(0, 6);
      tabla = { columnas: cols.map(titular), filas: resultado.filas.slice(0, MAX_FILAS_TABLA).map((f) => cols.map((k) => formatoCelda(f[k], k))), voz: 'filas' };
      break;
    }
  }

  const resumenJSON = JSON.stringify(resultados.map(({ consulta, resultado }) => ({
    consulta: { coleccion: consulta.coleccion, filtros: consulta.filtros, operacion: consulta.operacion, agrupar: consulta.agrupar, campo: consulta.campo },
    resultado: resultado.tipo === 'filas' ? { ...resultado, filas: resultado.filas.slice(0, 30) } : resultado,
  }))).slice(0, 14000);
  const sistemaRespuesta = `Eres Deseret, la asistente de OrganizaSion. Hoy es ${fechaLegible(hoyISO)}.
El usuario preguntó algo y el sistema ya consultó la base de datos (respetando sus permisos). Estos son los resultados EXACTOS:
${resumenJSON}

Reglas:
- Responde SOLO con estos resultados. Los números ya están calculados: úsalos tal cual, no los recalcules ni inventes otros.
- Si total_filas es 0, dilo con naturalidad (ej. "No encontré casos de bienestar vigentes").
- ${tabla ? 'Debajo de tu respuesta se muestra un cuadro con el detalle: NO lo repitas completo; da la conclusión y lo más relevante en 1 a 3 frases (o hasta 4 viñetas si es una comparación).' : 'Sé breve y directo; usa viñetas solo si hay varios elementos.'}
${breve ? '- MODO CONDUCCIÓN: máximo 2 frases cortas, sin listas.\n' : ''}- Si la lista se cortó (total_filas mayor que las filas mostradas), menciona el total.
- Pon en **negrita** nombres, números clave y fechas. Fechas en formato legible (ej. "15 de agosto").
- Tono cercano y respetuoso, nunca de juicio. Vocabulario SUD: nunca uses la palabra "pastoral".
- No digas que "consultaste la base de datos" ni menciones colecciones, campos o JSON.`;
  const redactado = await redactar(sistemaRespuesta, [], mensaje);
  const texto = redactado ? filtrarAlucinacion(redactado) : respaldo(resultados);
  return resp(texto, tabla ? { tabla } : {});
}

const titular = (k) => { const s = String(k).replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };
const formatoNumero = (v, campo) => (v === null || v === undefined ? '—' : /monto/.test(String(campo || '')) ? `$${Number(v).toLocaleString('es-CL')}` : String(v));
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const formatoCelda = (v, k) => {
  if (v === null || v === undefined || v === '') return '—';
  if (k === 'monto') return `$${Number(v).toLocaleString('es-CL')}`;
  const f = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (f) return `${Number(f[3])} ${MESES_CORTOS[Number(f[2]) - 1]} ${f[1]}`;
  return String(v).replace(/_/g, ' ');
};

// Sin IA para redactar: una frase simple con el primer resultado.
function respaldo(resultados) {
  const r = resultados.find((x) => !x.resultado.error)?.resultado;
  if (!r) return 'No encontré datos para esa pregunta.';
  if (r.tipo === 'valor') return `El resultado es **${r.valor ?? 0}** (${r.total_filas} registro${r.total_filas === 1 ? '' : 's'}).`;
  if (r.tipo === 'grupos') return r.grupos.length ? `Esto es lo que encontré (${r.total_filas} registros en total):` : 'No encontré registros para esa pregunta.';
  return r.total_filas ? `Encontré **${r.total_filas}** registro${r.total_filas === 1 ? '' : 's'}:` : 'No encontré registros para esa pregunta.';
}
