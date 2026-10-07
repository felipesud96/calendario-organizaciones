// ----------------------------------------------------------------------
// INFORME MENSUAL (para el Obispo y los líderes)
// ----------------------------------------------------------------------
// Resumen de un mes: actividades realizadas, entrevistas, compromisos,
// gastos y lo que viene el mes siguiente. El Obispado, el secretario y el
// Administrador ven todo el barrio; los demás líderes, su organización.
// El cliente lo muestra como una hoja lista para imprimir/guardar en PDF y
// para enviar por WhatsApp.
//
// Además, el día 1 de cada mes (desde las 9:00) se avisa por notificación al
// Obispado que el informe del mes anterior está listo.
//
//   GET /api/informe-mensual?mes=AAAA-MM   (por defecto, el mes anterior)
// ----------------------------------------------------------------------
import { sendJson } from '../router.js';
import { requireRole } from '../guard.js';
import { load, withDb } from '../db.js';
import { isObispadoLeader } from './stake.js';
import { sendUserPush } from '../webpush.js';
import { textoRapido, conTope } from '../iaRapida.js';

const ZONA = process.env.TZ_APP || 'America/Santiago';
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function ahora() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) };
}
function mesAnterior(fecha) {
  const [y, m] = fecha.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
function mesSiguiente(mes) {
  const [y, m] = mes.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
export const nombreMes = (mes) => { const [y, m] = mes.split('-').map(Number); return `${MESES[m - 1]} ${y}`; };

export function calcularInforme(user, data, mes) {
  const todoBarrio = user.role === 'admin' || user.role === 'ward_clerk' || isObispadoLeader(user, data);
  const miOrg = Number(user.organizationId);
  const deMiOrg = (orgId, extra = []) => todoBarrio || Number(orgId) === miOrg || extra.map(Number).includes(miOrg);
  const org = (id) => data.organizations.find((o) => o.id === Number(id));
  const enMes = (f) => typeof f === 'string' && f.slice(0, 7) === mes;
  const hoy = ahora().fecha;

  // Actividades realizadas (sin reuniones privadas)
  const actividades = (data.events || [])
    .filter((e) => !e.isMeeting && enMes(e.date) && e.date <= hoy && deMiOrg(e.organizationId, e.involvedOrganizationIds || []))
    .sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')))
    .map((e) => ({
      fecha: e.date, titulo: e.title, org: e.isWardActivity ? 'Todo el barrio' : (org(e.organizationId)?.name || ''),
      color: org(e.organizationId)?.color || null,
      confirmados: (e.rsvps || []).filter((r) => r.response === 'yes').length,
    }));
  const porOrg = {};
  actividades.forEach((a) => { porOrg[a.org] = (porOrg[a.org] || 0) + 1; });

  // Entrevistas realizadas (una por grupo) y las que quedaron sin marcar
  const grupos = new Set(); let entrevistas = 0; let sinMarcar = 0;
  for (const iv of data.interviews || []) {
    if (!enMes(iv.date) || !deMiOrg(iv.organizationId)) continue;
    const k = iv.groupId ?? `i${iv.id}`;
    if (grupos.has(k)) continue;
    grupos.add(k);
    if (iv.status === 'done') entrevistas += 1;
    else if ((iv.status || 'scheduled') === 'scheduled' && iv.date < hoy) sinMarcar += 1;
  }

  // Compromisos que vencían en el mes
  let compTotal = 0; let compOk = 0; const atrasados = [];
  for (const m of data.meetings || []) {
    if (!deMiOrg(m.organizationId)) continue;
    for (const c of m.commitments || []) {
      if (!enMes(c.dueDate)) continue;
      compTotal += 1;
      if (c.status === 'completed') compOk += 1;
      else if (c.dueDate < hoy) {
        const quien = data.users.find((u) => u.id === Number(c.assignedToUserId))?.name || c.assignedToName || '';
        atrasados.push({ texto: (m.confidential || c.confidential) ? 'Compromiso confidencial' : String(c.description || '').slice(0, 120), quien, vence: c.dueDate });
      }
    }
  }

  // Gastos del mes
  const gastosPorCat = {};
  let gastosTotal = 0;
  for (const g of data.budgetExpenses || []) {
    if (!enMes(g.date)) continue;
    const esOrg = g.categoryType === 'organization';
    if (!todoBarrio && !(esOrg && Number(g.organizationId) === miOrg)) continue;
    const nombre = esOrg ? (org(g.organizationId)?.name || 'Organización') : ((data.budgetCategories || []).find((c) => c.id === Number(g.budgetCategoryId))?.name || 'Otros');
    gastosPorCat[nombre] = (gastosPorCat[nombre] || 0) + Number(g.amount || 0);
    gastosTotal += Number(g.amount || 0);
  }

  // Lo que viene el mes siguiente
  const sig = mesSiguiente(mes);
  const proximas = (data.events || [])
    .filter((e) => !e.isMeeting && enMes2(e.date, sig) && deMiOrg(e.organizationId, e.involvedOrganizationIds || []))
    .sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')))
    .slice(0, 12)
    .map((e) => ({ fecha: e.date, hora: e.startTime || '', titulo: e.title, org: e.isWardActivity ? 'Todo el barrio' : (org(e.organizationId)?.name || ''), color: org(e.organizationId)?.color || null }));

  const bienestarAbiertos = todoBarrio && isObispadoLeader(user, data)
    ? (data.welfareCases || []).filter((c) => c.status !== 'cerrado').length : null;

  return {
    mes, nombreMes: nombreMes(mes), mesSiguiente: nombreMes(sig),
    alcance: todoBarrio ? 'Todo el barrio' : (org(miOrg)?.name || ''),
    actividades, actividadesPorOrg: Object.entries(porOrg).map(([nombre, n]) => ({ nombre, n })).sort((a, b) => b.n - a.n),
    entrevistas, entrevistasSinMarcar: sinMarcar,
    compromisos: { total: compTotal, cumplidos: compOk, pct: compTotal ? Math.round((compOk / compTotal) * 100) : null, atrasados: atrasados.slice(0, 8), nAtrasados: atrasados.length },
    gastos: { total: gastosTotal, porCategoria: Object.entries(gastosPorCat).map(([nombre, monto]) => ({ nombre, monto })).sort((a, b) => b.monto - a.monto) },
    proximas, bienestarAbiertos,
  };
}
function enMes2(f, mes) { return typeof f === 'string' && f.slice(0, 7) === mes; }

const cacheResumen = new Map();
async function resumenIA(inf) {
  const clave = JSON.stringify([inf.mes, inf.alcance, inf.actividades.length, inf.entrevistas, inf.compromisos, inf.gastos.total]);
  if (cacheResumen.has(clave)) return cacheResumen.get(clave);
  const sistema = `Eres Deseret, asistente de OrganizaSion (barrio de La Iglesia de Jesucristo de los Santos de los Últimos Días en Chile). Escribe el párrafo de apertura de un informe mensual para el Obispo: 2 o 3 frases (máximo 60 palabras), en español de Chile, tono cálido y concreto. Destaca lo más relevante con datos exactos y termina con una sugerencia breve para el mes siguiente. No inventes datos, sin emojis, sin viñetas, sin la palabra "pastoral".`;
  const datos = { ...inf, actividades: inf.actividades.map((a) => `${a.fecha} ${a.titulo} (${a.org})`), proximas: inf.proximas.map((a) => `${a.fecha} ${a.titulo}`) };
  let texto = null;
  try { texto = await conTope(textoRapido(sistema, [], `Datos del mes (JSON):\n${JSON.stringify(datos)}`, 0.3), 9000); } catch (e) { texto = null; }
  const limpio = texto ? String(texto).replace(/\p{Extended_Pictographic}/gu, '').trim().slice(0, 600) : null;
  if (limpio) { cacheResumen.set(clave, limpio); if (cacheResumen.size > 100) cacheResumen.delete(cacheResumen.keys().next().value); }
  return limpio;
}

export function registerInformeRoutes(router) {
  router.get('/api/informe-mensual', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res) => {
    const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || '')) ? req.query.mes : mesAnterior(ahora().fecha);
    const inf = calcularInforme(req.user, load(), mes);
    inf.resumen = req.query.sinIA === '1' ? null : await resumenIA(inf);
    sendJson(res, 200, inf);
  }));
}

// Aviso del día 1: "Tu informe de septiembre está listo".
async function avisarInforme() {
  const a = ahora();
  if (a.fecha.slice(8) !== '01' || a.hora < 9) return;
  const mes = mesAnterior(a.fecha);
  const data = load();
  if (data.informeAvisado === mes) return;
  await withDb((db) => { db.informeAvisado = mes; });
  const obispado = data.users.filter((u) => u.role === 'leader' && isObispadoLeader(u, data));
  for (const u of obispado) {
    try { await sendUserPush(u, { title: `Informe de ${nombreMes(mes)} listo`, body: 'Actividades, entrevistas, compromisos y gastos del mes en una hoja.', url: `/?informe=${mes}` }); } catch (e) { /* sin push */ }
  }
  console.log(`[informe] aviso de ${mes} enviado a ${obispado.length} persona(s) del Obispado`);
}
let iniciado = false;
export function iniciarAvisoInforme() {
  if (iniciado) return;
  iniciado = true;
  setInterval(() => avisarInforme().catch((e) => console.warn('[informe]', e.message)), 15 * 60 * 1000);
  setTimeout(() => avisarInforme().catch(() => {}), 20_000);
}
