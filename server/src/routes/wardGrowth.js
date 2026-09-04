import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireRole } from '../guard.js';
import {
  INDICATOR_DEFS, WARD_GROWTH_CATEGORIES, sortedQuarters,
  computeConvertTracking, validateQuarterPayload,
} from '../wardGrowth.js';
import { extractFromPdfBuffer } from '../pdfExtract.js';

// Módulo "Crecimiento del Barrio" (Estadísticas del Barrio, Punto ~102):
// indicadores trimestrales de crecimiento que el Obispado ya venía
// calculando fuera de la app a partir de los reportes oficiales
// trimestrales. Decisión explícita del usuario: VER es para cualquier
// admin/leader (de cualquier organización)/ward_clerk, SIN acotar por
// organización — todos los líderes ven todo, incluidos los nombres y
// edades de la tabla de seguimiento de conversos. EDITAR (cargar/editar un
// trimestre o la instantánea) es solo admin/ward_clerk (el secretario de
// barrio, en la vida real, es quien arma este reporte) — un "leader"
// cualquiera puede ver pero no editar. Eliminar un trimestre (por si se
// cargó por error) es solo admin.
const VIEW_ROLES = ['admin', 'leader', 'ward_clerk'];
const EDIT_ROLES = ['admin', 'ward_clerk'];

export function registerWardGrowthRoutes(router) {
  router.get('/api/ward-growth/quarters', requireRole(VIEW_ROLES, async (req, res) => {
    const data = load();
    const quarters = sortedQuarters(data.quarterlyStats);
    sendJson(res, 200, {
      quarters,
      indicatorDefs: INDICATOR_DEFS,
      categories: WARD_GROWTH_CATEGORIES,
      convertTracking: computeConvertTracking(data.quarterlyStats),
    });
  }));

  router.post('/api/ward-growth/quarters', requireRole(EDIT_ROLES, async (req, res, params, body) => {
    const data0 = load();
    const error = validateQuarterPayload(body, data0.quarterlyStats, null);
    if (error) return sendJson(res, 400, { error });
    const now = new Date().toISOString();
    const saved = await withDb((data) => {
      const q = {
        id: nextId(data, 'quarterlyStats'),
        label: String(body.label).trim(),
        year: Number(body.year),
        quarter: Number(body.quarter),
        indicators: body.indicators,
        converts: body.converts,
        createdAt: now,
        createdBy: req.user.id,
        updatedAt: now,
        updatedBy: req.user.id,
      };
      data.quarterlyStats.push(q);
      return q;
    });
    sendJson(res, 201, saved);
  }));

  router.put('/api/ward-growth/quarters/:id', requireRole(EDIT_ROLES, async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    const existing = data0.quarterlyStats.find((q) => q.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Trimestre no encontrado' });
    const error = validateQuarterPayload(body, data0.quarterlyStats, id);
    if (error) return sendJson(res, 400, { error });
    const now = new Date().toISOString();
    const updated = await withDb((data) => {
      const q = data.quarterlyStats.find((x) => x.id === id);
      if (!q) return null;
      Object.assign(q, {
        label: String(body.label).trim(),
        year: Number(body.year),
        quarter: Number(body.quarter),
        indicators: body.indicators,
        converts: body.converts,
        updatedAt: now,
        updatedBy: req.user.id,
      });
      return q;
    });
    if (!updated) return sendJson(res, 404, { error: 'Trimestre no encontrado' });
    sendJson(res, 200, updated);
  }));

  router.delete('/api/ward-growth/quarters/:id', requireRole(['admin'], async (req, res, params) => {
    const id = Number(params.id);
    const removed = await withDb((data) => {
      const before = data.quarterlyStats.length;
      data.quarterlyStats = data.quarterlyStats.filter((q) => q.id !== id);
      return data.quarterlyStats.length < before;
    });
    if (!removed) return sendJson(res, 404, { error: 'Trimestre no encontrado' });
    sendJson(res, 200, { ok: true });
  }));

  router.get('/api/ward-growth/snapshot', requireRole(VIEW_ROLES, async (req, res) => {
    const data = load();
    sendJson(res, 200, data.wardSnapshot || null);
  }));

  router.put('/api/ward-growth/snapshot', requireRole(EDIT_ROLES, async (req, res, params, body) => {
    if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'Datos inválidos' });
    const now = new Date().toISOString();
    const saved = await withDb((data) => {
      data.wardSnapshot = { ...body, updatedAt: now, updatedBy: req.user.id };
      return data.wardSnapshot;
    });
    sendJson(res, 200, saved);
  }));

  // Extracción asistida desde PDF — SOLO devuelve un borrador para
  // pre-llenar el formulario correspondiente; en ningún momento escribe en
  // quarterlyStats/wardSnapshot. El guardado real sigue siendo,
  // exclusivamente, POST/PUT de arriba, disparados por el humano al tocar
  // "Guardar" después de revisar el formulario ya prellenado. Mismos roles
  // que editar (EDIT_ROLES): quien puede cargar un trimestre a mano es
  // quien puede usar el atajo de PDF.
  router.post('/api/ward-growth/parse-pdf', requireRole(EDIT_ROLES, async (req, res, params, body) => {
    const file = (body?.files || []).find((f) => f.field === 'pdf') || (body?.files || [])[0];
    if (!file || !file.data || !file.data.length) {
      return sendJson(res, 400, { error: 'Subí un archivo PDF' });
    }
    let result;
    try {
      result = extractFromPdfBuffer(file.data);
    } catch (err) {
      console.error('Error al procesar PDF de Crecimiento del Barrio:', err);
      return sendJson(res, 200, {
        type: null,
        data: null,
        warnings: ['No se pudo procesar el PDF automáticamente. Completá el formulario manualmente.'],
      });
    }
    sendJson(res, 200, result);
  }));
}
