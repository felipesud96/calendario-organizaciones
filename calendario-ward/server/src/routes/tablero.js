// ----------------------------------------------------------------------
// A19 — TABLERO DEL BARRIO: tendencias trimestrales en una sola pantalla
// ----------------------------------------------------------------------
// Los últimos 6 trimestres de: asistencia sacramental y recomendaciones
// (Crecimiento del Barrio), entrevistas realizadas, compromisos cumplidos a
// tiempo y actividades realizadas. El Obispado, el secretario de barrio y el
// Administrador ven todo el barrio; los demás líderes, lo de su organización
// (los indicadores trimestrales los ven todos los líderes, igual que en
// Crecimiento del Barrio).
// ----------------------------------------------------------------------
import { sendJson } from '../router.js';
import { requireRole } from '../guard.js';
import { load } from '../db.js';
import { isObispadoLeader } from './stake.js';
import { sortedQuarters, pctForIndicator } from '../wardGrowth.js';
import { quarterOf } from '../quarter.js';

function ultimosTrimestres(n) {
  const hoy = new Date();
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i * 3, 15);
    const q = quarterOf(d);
    if (!out.includes(q)) out.push(q);
  }
  return out;
}
const etiqueta = (q) => { const [y, t] = q.split('-Q'); return `T${t} ${y.slice(2)}`; };

export function registerTableroRoutes(router) {
  router.get('/api/tablero', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res) => {
    const data = load();
    const todoBarrio = req.user.role === 'admin' || req.user.role === 'ward_clerk' || isObispadoLeader(req.user, data);
    const deMiOrg = (orgId) => todoBarrio || Number(orgId) === Number(req.user.organizationId);
    const qs = ultimosTrimestres(6);
    const hoy = new Date().toISOString().slice(0, 10);
    const stats = sortedQuarters(data.quarterlyStats);
    const indicador = (n) => qs.map((q) => {
      const [y, t] = q.split('-Q').map(Number);
      return pctForIndicator(stats.find((s) => Number(s.year) === y && Number(s.quarter) === t), n);
    });
    // Entrevistas realizadas (una por grupo).
    const grupos = new Set();
    const entrevistas = qs.map(() => 0);
    for (const iv of data.interviews || []) {
      if (iv.status !== 'done' || !deMiOrg(iv.organizationId)) continue;
      const k = iv.groupId ?? iv.id;
      if (grupos.has(k)) continue;
      grupos.add(k);
      const i = qs.indexOf(quarterOf(iv.date));
      if (i >= 0) entrevistas[i] += 1;
    }
    // Compromisos cumplidos: de los que vencían en el trimestre (y ya vencieron), % cumplidos.
    const tot = qs.map(() => 0); const ok = qs.map(() => 0);
    for (const m of data.meetings || []) {
      if (!deMiOrg(m.organizationId)) continue;
      for (const c of m.commitments || []) {
        if (!c.dueDate || c.dueDate >= hoy) continue;
        const i = qs.indexOf(quarterOf(c.dueDate));
        if (i < 0) continue;
        tot[i] += 1;
        if (c.status === 'completed') ok[i] += 1;
      }
    }
    const compromisos = tot.map((t, i) => (t ? Math.round((ok[i] / t) * 100) : null));
    // Actividades realizadas (sin contar reuniones privadas).
    const actividades = qs.map(() => 0);
    for (const e of data.events || []) {
      if (e.isMeeting || e.date > hoy) continue;
      if (!todoBarrio && !(Number(e.organizationId) === Number(req.user.organizationId) || (e.involvedOrganizationIds || []).map(Number).includes(Number(req.user.organizationId)))) continue;
      const i = qs.indexOf(quarterOf(e.date));
      if (i >= 0) actividades[i] += 1;
    }
    sendJson(res, 200, {
      alcance: todoBarrio ? 'Todo el barrio' : (data.organizations.find((o) => o.id === Number(req.user.organizationId))?.name || ''),
      trimestres: qs.map(etiqueta),
      series: [
        { clave: 'asistencia', titulo: 'Asistencia sacramental', unidad: '%', valores: indicador(7), fuente: 'Crecimiento del Barrio (indicador 7)' },
        { clave: 'recomendacion', titulo: 'Adultos con recomendación', unidad: '%', valores: indicador(9), fuente: 'Crecimiento del Barrio (indicador 9)' },
        { clave: 'entrevistas', titulo: 'Entrevistas realizadas', unidad: '', valores: entrevistas, fuente: 'Entrevistas marcadas como realizadas' },
        { clave: 'compromisos', titulo: 'Compromisos cumplidos', unidad: '%', valores: compromisos, fuente: 'De los compromisos que vencían en el trimestre' },
        { clave: 'actividades', titulo: 'Actividades realizadas', unidad: '', valores: actividades, fuente: 'Actividades del calendario (sin reuniones)' },
        { clave: 'ministracion', titulo: 'Entrevistas de ministración', unidad: '%', valores: qs.map((_, i) => { const a = indicador(12)[i]; const b = indicador(13)[i]; return a == null && b == null ? null : Math.round(((a ?? b) + (b ?? a)) / 2); }), fuente: 'Promedio Cuórum de Élderes y Sociedad de Socorro (indicadores 12 y 13)' },
      ],
    });
  }));
}
