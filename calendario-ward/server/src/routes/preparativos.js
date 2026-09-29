// ----------------------------------------------------------------------
// PREPARATIVOS DE CADA ACTIVIDAD + FICHA DE ORGANIZACIÓN
// ----------------------------------------------------------------------
// Preparativos: una lista de tareas por actividad ("reservar sala",
// "comprar comida"...), cada una con responsable (cualquier persona con
// cuenta, o un nombre escrito a mano) y fecha. La actividad muestra su
// "preparación" en % y, al 100 %, "¡Todo listo!".
//   - La lista la arma quien administra la actividad (canEditOrg).
//   - Todos los que ven la actividad ven el avance.
//   - Cada responsable con cuenta ve sus tareas en "Mi semana" y puede
//     marcarlas hechas; recibe un aviso (push) cuando se la asignan.
//
// Ficha de organización: un resumen de una organización (próximas
// actividades con su preparación, compromisos abiertos, presupuesto del
// trimestre, últimas actas y su presidencia) en una sola ventana — no es un
// módulo nuevo: se abre desde Inicio.
//
// Rutas:
//   GET  /api/events/:id/preparativos
//   PUT  /api/events/:id/preparativos            { items: [...] }
//   POST /api/events/:id/preparativos/:pid/marcar { hecho }
//   GET  /api/events/:id/preparativos/sugerir     (?deseret=1 para ideas con IA)
//   GET  /api/organizaciones/:id/resumen
// ----------------------------------------------------------------------
import { sendJson } from '../router.js';
import { requireAuth } from '../guard.js';
import { load, withDb } from '../db.js';
import { canEditOrg, canSeeMeeting } from './events.js';
import { canSeeMeetingFullContent } from './meetings.js';
import { isObispadoLeader } from './stake.js';
import { summaryFor } from './budget.js';
import { currentQuarter } from '../quarter.js';
import { sendUserPush } from '../webpush.js';
import { pushEnabledFor } from '../notifications.js';
import { jsonRapido } from '../iaRapida.js';

const hoyISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ_APP || 'America/Santiago' }).format(new Date());
const txt = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// Listas sugeridas según el tipo de actividad (sin IA: instantáneas y gratis).
const PLANTILLAS = [
  { re: /noche de hogar|hogar/, t: ['Reservar la sala', 'Preparar el mensaje o tema', 'Organizar la comida / once', 'Preparar juegos o dinámica', 'Invitar a las familias', 'Coordinar el aseo al terminar'] },
  { re: /servicio|limpieza|minga|ayuda/, t: ['Confirmar el lugar y la necesidad con la familia o institución', 'Conseguir herramientas y materiales', 'Organizar el transporte', 'Invitar a los voluntarios', 'Preparar agua y colación', 'Tomar fotos (con permiso)'] },
  { re: /deport|futbol|fútbol|baby|basquet|básquet|voleibol|partido|campeonato|olimpiada/, t: ['Reservar la cancha', 'Conseguir balones e implementos', 'Armar los equipos', 'Conseguir botiquín de primeros auxilios', 'Confirmar adultos supervisores', 'Organizar agua y colación'] },
  { re: /campamento|excursi|paseo/, t: ['Reservar el lugar', 'Enviar autorizaciones a los padres', 'Organizar el transporte', 'Armar el menú y comprar alimentos', 'Revisar carpas y equipo', 'Confirmar adultos supervisores', 'Preparar botiquín'] },
  { re: /bautism/, t: ['Coordinar la pila bautismal', 'Llenar la pila a tiempo', 'Preparar ropa blanca y toallas', 'Asignar discursos y oraciones', 'Preparar el programa', 'Organizar un pequeño refrigerio'] },
  { re: /navidad|fiesta|aniversario|celebra|convivencia|cena|almuerzo|asado|fonda|kermesse/, t: ['Reservar el salón', 'Definir el menú y quién trae qué', 'Decorar', 'Preparar el programa o números', 'Música y amplificación', 'Invitar a todo el barrio', 'Coordinar el aseo al terminar'] },
  { re: /taller|charla|clase|capacitaci|devocional|conferencia|historia familiar/, t: ['Reservar la sala', 'Confirmar al presentador', 'Preparar el material o la presentación', 'Probar proyector y sonido', 'Invitar a los participantes'] },
];
const BASICA = ['Reservar el lugar', 'Definir el programa', 'Conseguir los materiales', 'Invitar a los participantes', 'Confirmar responsables el día anterior'];

function avance(items) {
  const total = items.length;
  const hechos = items.filter((x) => x.hecho).length;
  return { total, hechos, pct: total ? Math.round((hechos / total) * 100) : 0 };
}
function conNombres(items, data) {
  return items.map((x) => ({
    ...x,
    responsableNombre: x.responsableId ? (data.users.find((u) => u.id === Number(x.responsableId))?.name || x.responsableNombre || '') : (x.responsableNombre || ''),
  }));
}
function personasAsignables(data) {
  const org = (id) => data.organizations.find((o) => o.id === Number(id))?.name || '';
  return data.users
    .filter((u) => u.active !== false)
    .map((u) => ({ id: u.id, nombre: u.name, org: org(u.organizationId) }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

async function avisar(userIds, ev, data) {
  for (const id of userIds) {
    const u = data.users.find((x) => x.id === Number(id));
    if (!u || !pushEnabledFor(u, 'commitments')) continue;
    try { await sendUserPush(u, { title: 'Te asignaron un preparativo', body: `${ev.title} (${ev.date}): revisa tu tarea en Mi semana.`, url: '/?vista=home' }); } catch (e) { /* sin suscripción */ }
  }
}

// Para "Mi semana": las tareas pendientes asignadas a esta persona.
export function preparativosDe(user, data, fin) {
  const hoy = hoyISO();
  const out = [];
  for (const ev of data.events || []) {
    if (!Array.isArray(ev.preparativos) || ev.date < hoy) continue;
    for (const x of ev.preparativos) {
      if (x.hecho || Number(x.responsableId) !== Number(user.id)) continue;
      const fecha = x.fecha || ev.date;
      if (fin && fecha > fin) continue;
      out.push({ tipo: 'preparativo', fecha, hora: '', titulo: x.texto, org: `Para: ${ev.title}`, color: data.organizations.find((o) => o.id === Number(ev.organizationId))?.color || null, atrasado: fecha < hoy, vista: 'calendar', eventId: ev.id, prepId: x.id });
    }
  }
  return out.sort((a, b) => a.fecha.localeCompare(b.fecha));
}

export function registerPreparativosRoutes(router) {
  router.get('/api/events/:id/preparativos', requireAuth(async (req, res, params) => {
    const data = load();
    const ev = data.events.find((e) => e.id === Number(params.id));
    if (!ev || !canSeeMeeting(req.user, ev)) return sendJson(res, 404, { error: 'Actividad no encontrada' });
    const items = conNombres(ev.preparativos || [], data);
    const puedeEditar = canEditOrg(req.user, ev.organizationId);
    sendJson(res, 200, { items, ...avance(items), puedeEditar, personas: puedeEditar ? personasAsignables(data) : [] });
  }));

  router.put('/api/events/:id/preparativos', requireAuth(async (req, res, params, body) => {
    const data0 = load();
    const ev0 = data0.events.find((e) => e.id === Number(params.id));
    if (!ev0) return sendJson(res, 404, { error: 'Actividad no encontrada' });
    if (!canEditOrg(req.user, ev0.organizationId)) return sendJson(res, 403, { error: 'Solo quien administra la actividad puede editar los preparativos' });
    const entrada = Array.isArray(body?.items) ? body.items.slice(0, 40) : [];
    const nuevos = new Set();
    const ev = await withDb((db) => {
      const e = db.events.find((x) => x.id === ev0.id);
      const antes = new Map((e.preparativos || []).map((x) => [x.id, x]));
      let sig = Math.max(0, ...[...antes.keys()].map(Number)) + 1;
      e.preparativos = entrada
        .map((x) => {
          const texto = txt(x.texto, 120);
          if (!texto) return null;
          const previo = antes.get(Number(x.id));
          const responsableId = Number(x.responsableId) && db.users.some((u) => u.id === Number(x.responsableId)) ? Number(x.responsableId) : null;
          if (responsableId && (!previo || Number(previo.responsableId) !== responsableId) && responsableId !== req.user.id) nuevos.add(responsableId);
          const hecho = !!x.hecho;
          return {
            id: previo ? previo.id : sig++,
            texto,
            responsableId,
            responsableNombre: responsableId ? '' : txt(x.responsableNombre, 60),
            fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(x.fecha || '')) ? x.fecha : null,
            hecho,
            hechoPor: hecho ? (previo?.hecho ? previo.hechoPor : req.user.id) : null,
            hechoEn: hecho ? (previo?.hecho ? previo.hechoEn : new Date().toISOString()) : null,
          };
        })
        .filter(Boolean);
      return e;
    });
    const data = load();
    avisar([...nuevos], ev, data).catch(() => {});
    const items = conNombres(ev.preparativos, data);
    sendJson(res, 200, { items, ...avance(items), puedeEditar: true });
  }));

  router.post('/api/events/:id/preparativos/:pid/marcar', requireAuth(async (req, res, params, body) => {
    const data0 = load();
    const ev0 = data0.events.find((e) => e.id === Number(params.id));
    const t0 = ev0 && (ev0.preparativos || []).find((x) => x.id === Number(params.pid));
    if (!ev0 || !t0 || !canSeeMeeting(req.user, ev0)) return sendJson(res, 404, { error: 'Tarea no encontrada' });
    if (!canEditOrg(req.user, ev0.organizationId) && Number(t0.responsableId) !== req.user.id) return sendJson(res, 403, { error: 'Solo el responsable o quien administra la actividad puede marcarla' });
    const hecho = body?.hecho !== false;
    const ev = await withDb((db) => {
      const e = db.events.find((x) => x.id === ev0.id);
      const t = (e.preparativos || []).find((x) => x.id === t0.id);
      if (t) { t.hecho = hecho; t.hechoPor = hecho ? req.user.id : null; t.hechoEn = hecho ? new Date().toISOString() : null; }
      return e;
    });
    const items = conNombres(ev.preparativos || [], load());
    sendJson(res, 200, { items, ...avance(items), puedeEditar: canEditOrg(req.user, ev.organizationId) });
  }));

  router.get('/api/events/:id/preparativos/sugerir', requireAuth(async (req, res, params) => {
    const data = load();
    const ev = data.events.find((e) => e.id === Number(params.id));
    if (!ev || !canEditOrg(req.user, ev.organizationId)) return sendJson(res, 404, { error: 'Actividad no encontrada' });
    const base = `${ev.title} ${ev.description || ''} ${ev.purpose || ''}`.toLowerCase();
    let tareas = (PLANTILLAS.find((p) => p.re.test(base)) || { t: BASICA }).t;
    if (req.query.deseret === '1') {
      const j = await jsonRapido(
        'Eres Deseret, asistente de un barrio de La Iglesia de Jesucristo de los Santos de los Últimos Días en Chile. Propón la lista de preparativos para una actividad: tareas concretas y cortas (3 a 8 palabras cada una), en orden, en español de Chile. Devuelve SOLO JSON: {"tareas": ["...", "..."]} con 5 a 8 tareas.',
        `Actividad: ${ev.title}\nFecha: ${ev.date} ${ev.startTime || ''}\nLugar: ${ev.location || ''}\nDetalle: ${ev.description || ev.purpose || ''}`,
      );
      if (j && Array.isArray(j.tareas) && j.tareas.length) tareas = j.tareas.map((x) => txt(x, 120)).filter(Boolean).slice(0, 10);
    }
    sendJson(res, 200, { tareas });
  }));

  // ---------------- Ficha de organización ----------------
  router.get('/api/organizaciones/:id/resumen', requireAuth(async (req, res, params) => {
    const data = load();
    const u = req.user;
    const org = data.organizations.find((o) => o.id === Number(params.id));
    if (!org) return sendJson(res, 404, { error: 'Organización no encontrada' });
    const obispado = u.role === 'admin' || isObispadoLeader(u, data);
    const propia = Number(u.organizationId) === org.id && ['leader', 'executive_secretary'].includes(u.role);
    if (!obispado && !propia && u.role !== 'ward_clerk') return sendJson(res, 403, { error: 'No tienes acceso a esta organización' });
    const hoy = hoyISO();
    const de = (e) => Number(e.organizationId) === org.id || (e.involvedOrganizationIds || []).map(Number).includes(org.id);

    const actividades = (data.events || [])
      .filter((e) => !e.isMeeting && e.date >= hoy && de(e) && canSeeMeeting(u, e))
      .sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')))
      .slice(0, 6)
      .map((e) => ({ id: e.id, titulo: e.title, fecha: e.date, hora: e.startTime || '', lugar: e.location || '', preparacion: Array.isArray(e.preparativos) && e.preparativos.length ? avance(e.preparativos) : null }));
    const ultima = (data.events || []).filter((e) => !e.isMeeting && e.date < hoy && de(e)).map((e) => e.date).sort().pop() || null;

    let confidenciales = 0;
    const compromisos = [];
    for (const m of data.meetings || []) {
      if (m.status !== 'active' || Number(m.organizationId) !== org.id) continue;
      for (const c of m.commitments || []) {
        if (c.status !== 'pending') continue;
        if (c.confidential || !canSeeMeetingFullContent(u, m, data)) { confidenciales += 1; continue; }
        compromisos.push({ descripcion: c.description, responsable: data.users.find((x) => x.id === Number(c.assignedToUserId))?.name || '', fecha: c.dueDate || null, atrasado: !!c.dueDate && c.dueDate < hoy, acta: m.title });
      }
    }
    compromisos.sort((a, b) => (a.fecha || '9999').localeCompare(b.fecha || '9999'));

    const actas = (data.meetings || []).filter((m) => Number(m.organizationId) === org.id && !m.sueltos)
      .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 3)
      .map((m) => ({ id: m.id, titulo: m.title, fecha: m.date }));

    const verPresupuesto = obispado || u.role === 'financial_clerk' || (u.role === 'leader' && propia);
    let presupuesto = null;
    if (verPresupuesto) {
      const s = summaryFor(data, currentQuarter(), { categoryType: 'organization', organizationId: org.id, budgetCategoryId: null });
      presupuesto = { asignado: s.assigned, gastado: s.spent, saldo: s.balance, tieneAsignacion: s.hasAllocation, trimestre: currentQuarter() };
    }

    const presidencia = data.users.filter((x) => x.role === 'leader' && Number(x.organizationId) === org.id && x.active !== false)
      .map((x) => x.name).sort((a, b) => a.localeCompare(b, 'es'));

    sendJson(res, 200, {
      organizacion: { id: org.id, nombre: org.name, color: org.color },
      presidencia, actividades, ultimaActividad: ultima,
      compromisos: compromisos.slice(0, 8), totalCompromisos: compromisos.length, atrasados: compromisos.filter((c) => c.atrasado).length, confidenciales,
      presupuesto, actas,
      otras: obispado || u.role === 'ward_clerk' ? data.organizations.map((o) => ({ id: o.id, nombre: o.name })) : [],
    });
  }));
}
