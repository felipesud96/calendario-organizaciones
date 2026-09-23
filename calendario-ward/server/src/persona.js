// ----------------------------------------------------------------------
// FICHA 360° DE UNA PERSONA (App 1) — y la "ficha de persona" de Deseret
// ----------------------------------------------------------------------
// Junta en un solo lugar lo que la app sabe de alguien, repartido en varios
// módulos: Directorio, cuenta registrada, entrevistas, Enfoque Ministración,
// discursos, solicitudes y Bienestar. Cada sección se incluye SOLO si quien
// consulta tiene permiso para verla en su propio módulo — la ficha nunca
// muestra más de lo que la persona ya podría ver entrando módulo por módulo.
//
// Una persona se identifica por su fila del Directorio (d) y/o su cuenta (u).
// Cuando existen ambas se unen por nombre inequívoco (mismas palabras, en
// cualquier orden — igual que la vinculación automática de db.js).
// ----------------------------------------------------------------------
import { normNombre, callingLabel } from './db.js';
import { isObispadoLeader } from './routes/stake.js';
import { orgSeesAllInterviews } from './routes/interviews.js';
import { isMinisteringFocusLeaderHombres, isMinisteringFocusLeaderMujeres } from './routes/directory.js';
import { isWelfareCommitteeMember } from './routes/welfare.js';
import { computeCuadrante, ageFromBirthDate, categoryFor } from './pastoralFocus.js';
import { buscarMiembros } from './chat.js';

export const ROLES_FICHA = ['admin', 'leader', 'executive_secretary', 'ward_clerk'];
const clave = (s) => normNombre(s).split(' ').filter(Boolean).sort().join(' ');

export function puedeVerFichas(user) {
  return !!user && ROLES_FICHA.includes(user.role);
}

// Resuelve { d, u } (fila del Directorio y cuenta) a partir de uno de los dos.
export function resolverPersona(data, { directoryId = null, userId = null }) {
  let d = directoryId ? (data.directoryMembers || []).find((m) => m.id === Number(directoryId)) : null;
  let u = userId ? data.users.find((x) => x.id === Number(userId)) : null;
  if (d && !u) {
    const k = clave(d.name);
    const us = data.users.filter((x) => x.role !== 'admin' && clave(x.name) === k);
    if (us.length === 1) [u] = us;
  }
  if (u && !d) {
    const k = clave(u.name);
    const ds = (data.directoryMembers || []).filter((m) => clave(m.name) === k);
    if (ds.length === 1) [d] = ds;
  }
  if (!d && !u) return null;
  return { d, u, nombre: d?.name || u?.name };
}

// Buscador de personas para la ficha (mismo motor que Deseret).
export function buscarPersonas(q, data) {
  return buscarMiembros(q, data).slice(0, 12).map((r) => {
    const p = resolverPersona(data, { directoryId: r.directoryId, userId: r.userId });
    return { nombre: r.name, directoryId: p?.d?.id || null, userId: p?.u?.id || null, tieneCuenta: !!p?.u };
  });
}

const esDeLaPersona = (p) => (x, campoDir, campoUser, campoNombre) =>
  (p.d && Number(x[campoDir]) === p.d.id)
  || (p.u && campoUser && Number(x[campoUser]) === p.u.id)
  || (!x[campoDir] && !(campoUser && x[campoUser]) && campoNombre && clave(x[campoNombre]) === clave(p.nombre));

export function fichaPersona(viewer, data, ref) {
  const p = resolverPersona(data, ref);
  if (!p) return null;
  const mia = esDeLaPersona(p);
  const obispado = isObispadoLeader(viewer, data);
  const hoy = new Date().toISOString().slice(0, 10);
  const ficha = { nombre: p.nombre, directoryId: p.d?.id || null, userId: p.u?.id || null, secciones: [] };

  // --- Datos básicos (el Directorio es exclusivo de Obispado/Administrador) ---
  const basicos = [];
  if (p.d && obispado) {
    const edad = ageFromBirthDate(p.d.birthDate);
    if (edad !== null) basicos.push(['Edad', `${edad} años`]);
    basicos.push(['Sexo', p.d.sex === 'V' ? 'Hombre' : 'Mujer']);
    const cat = categoryFor(p.d);
    if (cat) basicos.push(['Organización probable', cat]);
  }
  if (p.u) {
    const org = data.organizations.find((o) => o.id === Number(p.u.organizationId));
    const rol = { admin: 'Administrador', leader: 'Líder', member: 'Miembro', executive_secretary: 'Secretario Ejecutivo', ward_clerk: 'Secretario de Barrio', financial_clerk: 'Secretario de Finanzas' }[p.u.role] || p.u.role;
    basicos.push(['Cuenta en la app', `Sí · ${rol}${org ? ` · ${org.name}` : ''}`]);
    const cargo = org ? callingLabel(org.name, p.u.calling) : null;
    if (cargo) basicos.push(['Llamamiento', cargo]);
    if (p.u.phone) basicos.push(['Teléfono', p.u.phone]);
  } else {
    basicos.push(['Cuenta en la app', 'No']);
  }
  ficha.secciones.push({ clave: 'basicos', titulo: 'Datos', filas: basicos });

  // --- Entrevistas (misma privacidad que GET /api/interviews) ---
  const veTodas = orgSeesAllInterviews(viewer, data);
  const entrevistas = (data.interviews || [])
    .filter((iv) => mia(iv, 'memberDirectoryId', 'memberUserId', 'memberName'))
    .filter((iv) => viewer.role === 'admin' || veTodas || Number(iv.organizationId) === Number(viewer.organizationId))
    .sort((a, b) => (b.date + (b.startTime || '')).localeCompare(a.date + (a.startTime || '')));
  if (entrevistas.length || viewer.role !== 'ward_clerk') {
    const org = (id) => data.organizations.find((o) => o.id === Number(id));
    const hechas = entrevistas.filter((iv) => iv.status === 'done');
    ficha.secciones.push({
      clave: 'entrevistas',
      titulo: 'Entrevistas',
      resumen: entrevistas.length
        ? `${hechas.length} realizada${hechas.length === 1 ? '' : 's'}${hechas[0] ? ` · última: ${hechas[0].date}` : ''}${entrevistas.some((iv) => iv.status === 'scheduled' && iv.date >= hoy) ? ' · tiene una agendada' : ''}`
        : 'Sin entrevistas registradas (que puedas ver).',
      items: entrevistas.slice(0, 8).map((iv) => ({
        fecha: iv.date, hora: iv.startTime || '', titulo: `${org(iv.organizationId)?.name || ''}${iv.interviewerName ? ` · con ${iv.interviewerName}` : ''}`,
        estado: iv.status === 'done' ? '✅ Se hizo' : iv.status === 'not_done' ? '❌ No se hizo' : iv.date >= hoy ? '🗓️ Agendada' : '⏳ Sin marcar',
        detalle: iv.comment || '', color: org(iv.organizationId)?.color || null,
      })),
    });
  }

  // --- Solicitudes pendientes de esta persona ---
  const solicitudes = (data.interviewRequests || []).filter((r) => r.status === 'pending' && mia(r, 'memberDirectoryId', 'memberUserId', 'memberName')
    && (obispado || Number(r.organizationId) === Number(viewer.organizationId)));
  if (solicitudes.length) {
    ficha.secciones.push({
      clave: 'solicitudes', titulo: 'Solicitudes pendientes',
      items: solicitudes.map((r) => ({ fecha: r.date, hora: r.startTime, titulo: `Pidió entrevista${r.targetLeaderName ? ` con ${r.targetLeaderName}` : ''}`, estado: '⏳ Pendiente', detalle: r.note || '' })),
    });
  }

  // --- Enfoque Ministración (mismos permisos que el módulo) ---
  if (p.d) {
    const esHombre = p.d.sex === 'V';
    const puede = esHombre ? isMinisteringFocusLeaderHombres(viewer, data) : isMinisteringFocusLeaderMujeres(viewer, data);
    const f = (data.pastoralFocus || []).find((x) => x.memberId === p.d.id);
    if (puede && f && f.asistencia) {
      const faltas = [!f.tieneLlamamiento && 'llamamiento', !f.recomendacionVigente && 'recomendación del templo', f.faltaConvenio && 'algún convenio'].filter(Boolean);
      const hist = (f.history || []).slice(-3).reverse();
      ficha.secciones.push({
        clave: 'enfoque', titulo: 'Enfoque Ministración',
        filas: [
          ['Cuadrante', computeCuadrante(f)],
          ['Asistencia', f.asistencia],
          ['Le falta', faltas.length ? faltas.join(', ') : 'nada — cumple todo'],
          ['Actualizado', `${String(f.updatedAt || '').slice(0, 10)}${f.updatedByName ? ` por ${f.updatedByName}` : ''}`],
          ...hist.map((h) => ['Antes', `${h.cuadrante} (hasta ${String(h.changedAt).slice(0, 10)})`]),
        ],
      });
    }
  }

  // --- Discursos (módulo de líderes) ---
  if (['admin', 'leader'].includes(viewer.role)) {
    const talks = (data.talks || []).filter((t) => mia(t, 'speakerDirectoryId', 'speakerUserId', 'speakerName'))
      .sort((a, b) => b.date.localeCompare(a.date));
    ficha.secciones.push({
      clave: 'discursos', titulo: 'Discursos',
      resumen: talks.length ? `${talks.length} discurso${talks.length === 1 ? '' : 's'} · último: ${talks[0].date}` : 'Sin discursos registrados.',
      items: talks.slice(0, 5).map((t) => ({ fecha: t.date, hora: '', titulo: t.topic || '(sin tema)', estado: '🎤' })),
    });
  }

  // --- Bienestar: solo el comité, y solo el estado (nunca el detalle) ---
  if (isWelfareCommitteeMember(viewer, data)) {
    const casos = (data.welfareCases || []).filter((c) => mia(c, 'memberDirectoryId', 'memberUserId', 'memberName'));
    if (casos.length) {
      const abiertos = casos.filter((c) => c.status !== 'cerrado');
      ficha.secciones.push({
        clave: 'bienestar', titulo: 'Bienestar',
        resumen: abiertos.length ? `${abiertos.length} caso${abiertos.length === 1 ? '' : 's'} activo${abiertos.length === 1 ? '' : 's'} — ver detalle en el módulo Bienestar.` : `${casos.length} caso${casos.length === 1 ? '' : 's'} cerrado${casos.length === 1 ? '' : 's'}.`,
      });
    }
  }
  return ficha;
}

// Texto plano de la ficha (para Deseret y su respaldo sin IA).
export function fichaComoTexto(f) {
  const out = [`FICHA DE ${f.nombre}`];
  for (const s of f.secciones) {
    out.push(`\n[${s.titulo}]${s.resumen ? ` ${s.resumen}` : ''}`);
    for (const [k, v] of s.filas || []) out.push(`${k}: ${v}`);
    for (const it of (s.items || []).slice(0, 5)) out.push(`${it.fecha} ${it.hora} · ${it.titulo} · ${it.estado}${it.detalle ? ` · ${it.detalle}` : ''}`);
  }
  return out.join('\n');
}
