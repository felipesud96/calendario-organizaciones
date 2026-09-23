import { sendJson } from '../router.js';
import { load } from '../db.js';
import { requireAuth } from '../guard.js';
import { puedeVerFichas, buscarPersonas, fichaPersona } from '../persona.js';
import { resumenSemana } from '../semana.js';
import { registrarFeedback } from '../deseretExtra.js';

// Ficha 360° (App 1), "Mi semana" (App 3) y valoraciones de Deseret (punto 10).
export function registerPersonasSemanaRoutes(router) {
  router.get('/api/personas/buscar', requireAuth(async (req, res) => {
    if (!puedeVerFichas(req.user)) return sendJson(res, 403, { error: 'Sin permiso' });
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return sendJson(res, 200, []);
    sendJson(res, 200, buscarPersonas(q, load()));
  }));

  router.get('/api/personas/ficha', requireAuth(async (req, res) => {
    if (!puedeVerFichas(req.user)) return sendJson(res, 403, { error: 'Las fichas son para líderes, secretarios y el Administrador' });
    const data = load();
    let ref = { directoryId: req.query.d ? Number(req.query.d) : null, userId: req.query.u ? Number(req.query.u) : null };
    // Por nombre (ej. desde el historial de entrevistas): solo si hay UNA coincidencia.
    if (!ref.directoryId && !ref.userId && req.query.n) {
      const encontrados = buscarPersonas(String(req.query.n), data);
      if (encontrados.length !== 1) {
        return sendJson(res, encontrados.length ? 409 : 404, { error: encontrados.length ? 'Hay varias personas con ese nombre — búscala en "🔎 Buscar persona"' : 'No encontré a esa persona en el Directorio' });
      }
      ref = { directoryId: encontrados[0].directoryId, userId: encontrados[0].userId };
    }
    const f = fichaPersona(req.user, data, ref);
    if (!f) return sendJson(res, 404, { error: 'Persona no encontrada' });
    sendJson(res, 200, f);
  }));

  router.get('/api/mi-semana', requireAuth(async (req, res) => {
    const dias = Math.min(Math.max(Number(req.query.dias) || 7, 1), 14);
    const data = load();
    const r = resumenSemana(req.user, data, { dias });
    // A17: "Primeros pasos" para líderes y secretarios (se calcula solo; la
    // tarjeta desaparece cuando está todo hecho o la persona la oculta).
    if (['admin', 'leader', 'executive_secretary', 'ward_clerk'].includes(req.user.role)) {
      const u = req.user;
      r.primerosPasos = {
        perfil: !!(u.phone && u.email),
        llamamiento: !!(u.calling || u.isPresident || u.role !== 'leader'),
        push: (data.webPush?.subscriptions || []).some((x) => Number(x.userId) === Number(u.id)),
        agendo: (data.interviews || []).some((iv) => Number(iv.scheduledBy) === Number(u.id))
          || (data.events || []).some((e) => Number(e.createdBy) === Number(u.id))
          || (data.meetings || []).some((m) => Number(m.createdBy) === Number(u.id)),
      };
    }
    sendJson(res, 200, r);
  }));

  router.post('/api/chat/feedback', requireAuth(async (req, res, params, body) => {
    await registrarFeedback({ mensaje: body?.mensaje, respuesta: body?.respuesta, valor: body?.valor });
    sendJson(res, 200, { ok: true });
  }));
}
