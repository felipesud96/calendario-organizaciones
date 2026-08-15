import { sendJson } from './router.js';

export function requireAuth(handler) {
  return async (req, res, params, body) => {
    if (!req.user) {
      return sendJson(res, 401, { error: 'No autenticado' });
    }
    return handler(req, res, params, body);
  };
}

export function requireRole(roles, handler) {
  return async (req, res, params, body) => {
    if (!req.user) {
      return sendJson(res, 401, { error: 'No autenticado' });
    }
    if (!roles.includes(req.user.role)) {
      return sendJson(res, 403, { error: 'No tienes permiso para esta acción' });
    }
    return handler(req, res, params, body);
  };
}
