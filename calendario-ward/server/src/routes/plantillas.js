// ----------------------------------------------------------------------
// A6 — "MIS PLANTILLAS" DE REUNIÓN
// ----------------------------------------------------------------------
// Además de las plantillas del Manual General (en app.js), cada líder puede
// guardar los temas de una reunión como plantilla propia y reutilizarla.
// Si la marca "compartida", la ven también los demás líderes de su misma
// organización (ej. toda la presidencia de la Primaria).
// ----------------------------------------------------------------------
import { sendJson } from '../router.js';
import { requireRole } from '../guard.js';
import { load, withDb, nextId } from '../db.js';

const ROLES = ['admin', 'leader', 'ward_clerk'];
const visible = (t, u) => Number(t.userId) === Number(u.id) || (t.compartida && Number(t.organizationId) === Number(u.organizationId));

export function registerPlantillasRoutes(router) {
  router.get('/api/meeting-templates', requireRole(ROLES, async (req, res) => {
    const data = load();
    const lista = (data.meetingTemplates || []).filter((t) => visible(t, req.user))
      .map((t) => ({ ...t, propia: Number(t.userId) === Number(req.user.id), autor: data.users.find((u) => u.id === t.userId)?.name || '' }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
    sendJson(res, 200, lista);
  }));

  router.post('/api/meeting-templates', requireRole(ROLES, async (req, res, params, body) => {
    const nombre = String(body?.nombre || '').trim().slice(0, 80);
    const temas = (Array.isArray(body?.temas) ? body.temas : []).map((t) => String(t || '').trim().slice(0, 200)).filter(Boolean).slice(0, 40);
    if (!nombre) return sendJson(res, 400, { error: 'Ponle un nombre a la plantilla' });
    if (!temas.length) return sendJson(res, 400, { error: 'La plantilla necesita al menos un tema' });
    const t = await withDb((d) => {
      d.meetingTemplates = d.meetingTemplates || [];
      const nueva = { id: nextId(d, 'meetingTemplates'), userId: req.user.id, organizationId: req.user.organizationId || null, nombre, temas, compartida: !!body?.compartida, createdAt: new Date().toISOString() };
      d.meetingTemplates.push(nueva);
      return nueva;
    });
    sendJson(res, 201, t);
  }));

  router.delete('/api/meeting-templates/:id', requireRole(ROLES, async (req, res, params) => {
    const id = Number(params.id);
    const t = (load().meetingTemplates || []).find((x) => x.id === id);
    if (!t) return sendJson(res, 404, { error: 'Plantilla no encontrada' });
    if (Number(t.userId) !== Number(req.user.id) && req.user.role !== 'admin') return sendJson(res, 403, { error: 'Solo quien creó la plantilla puede borrarla' });
    await withDb((d) => { d.meetingTemplates = (d.meetingTemplates || []).filter((x) => x.id !== id); });
    sendJson(res, 200, { ok: true });
  }));
}
