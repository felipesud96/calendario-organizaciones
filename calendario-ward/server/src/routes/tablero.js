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
import { textoRapido } from '../iaRapida.js';

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

function calcularTablero(user, data) {
    const req = { user };
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
    return {
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
      // Para la lectura de Deseret: cuándo fue la última actividad de cada organización y si tiene alguna próxima.
      organizaciones: data.organizations
        .filter((o) => (todoBarrio ? !/obispado/i.test(o.name) : Number(o.id) === Number(user.organizationId)))
        .map((o) => {
          const suyas = (data.events || []).filter((e) => !e.isMeeting && (Number(e.organizationId) === o.id || (e.involvedOrganizationIds || []).map(Number).includes(o.id)));
          const pasadas = suyas.filter((e) => e.date <= hoy).map((e) => e.date).sort();
          const proximas = suyas.filter((e) => e.date > hoy).map((e) => e.date).sort();
          const ultima = pasadas[pasadas.length - 1] || null;
          return { nombre: o.name, ultimaActividad: ultima, diasDesdeUltima: ultima ? Math.round((Date.parse(hoy) - Date.parse(ultima)) / 86400000) : null, proximaActividad: proximas[0] || null };
        }),
    };
}

// Lectura en palabras simples (Deseret): se guarda unas horas por persona para no gastar IA en cada visita.
const cacheLectura = new Map();
const HORAS_LECTURA = 6;

export function registerTableroRoutes(router) {
  router.get('/api/tablero', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res) => {
    const { organizaciones, ...d } = calcularTablero(req.user, load());
    sendJson(res, 200, d);
  }));

  router.get('/api/tablero/lectura', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res) => {
    const d = calcularTablero(req.user, load());
    const clave = `${req.user.id}|${JSON.stringify(d.series.map((s) => s.valores))}|${new Date().toISOString().slice(0, 10)}`;
    const guardada = cacheLectura.get(clave);
    if (guardada && Date.now() - guardada.t < HORAS_LECTURA * 3600_000 && req.query.nueva !== '1') return sendJson(res, 200, { texto: guardada.texto });
    const datos = {
      alcance: d.alcance,
      trimestres: d.trimestres,
      indicadores: d.series.map((s) => ({ indicador: s.titulo, unidad: s.unidad || 'cantidad', valores: s.valores })),
      organizaciones: d.organizaciones,
      hoy: new Date().toISOString().slice(0, 10),
    };
    const sistema = `Eres Deseret, asistente de OrganizaSion (app de un barrio de La Iglesia de Jesucristo de los Santos de los Últimos Días en Chile). Lees el tablero de indicadores y lo explicas a un líder en palabras simples.
Escribe en español de Chile, en 2 a 4 frases cortas (máximo 70 palabras en total):
1) Lo más importante que muestran los números (una mejora o una baja clara, con el dato exacto: por ejemplo "la asistencia sacramental bajó de 48% a 41% respecto al trimestre anterior").
2) Si alguna organización lleva mucho tiempo sin actividades (más de 45 días) y no tiene ninguna próxima, menciónala.
3) Termina con UNA sugerencia concreta y amable (empieza con "Sugerencia:").
Reglas: usa solo los datos entregados, no inventes números; si faltan datos (null) no los interpretes; no uses emojis ni viñetas; usa **negrita** solo para 1 o 2 cifras clave; tono cercano, nunca de juicio; nunca uses la palabra "pastoral".`;
    const texto = await textoRapido(sistema, [], `Datos del tablero (JSON):\n${JSON.stringify(datos)}`, 0.3);
    if (!texto) return sendJson(res, 503, { error: 'Deseret no pudo leer el tablero ahora' });
    const limpio = texto.replace(/\p{Extended_Pictographic}/gu, '').trim().slice(0, 700);
    cacheLectura.set(clave, { texto: limpio, t: Date.now() });
    if (cacheLectura.size > 300) cacheLectura.delete(cacheLectura.keys().next().value);
    sendJson(res, 200, { texto: limpio });
  }));
}
