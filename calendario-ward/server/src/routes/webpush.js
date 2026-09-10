import { sendJson } from '../router.js';
import { withDb, nextId } from '../db.js';
import { requireAuth } from '../guard.js';
import { getOrCreateVapidKeys } from '../webpush.js';

// Punto 39 — Notificaciones push del navegador. El flujo, del lado
// cliente: pide la clave pública VAPID acá abajo, la usa para
// PushManager.subscribe() (ver wireWebPush en app.js), y manda el resultado
// (un objeto PushSubscription: endpoint + claves de cifrado) a
// /api/push/subscribe para guardarlo. No hace falta ninguna cuenta ni clave
// de un tercero (a diferencia de WhatsApp/CallMeBot) — el navegador mismo
// habla con el servicio de push de Google/Mozilla/etc. usando esta clave.
export function registerWebPushRoutes(router) {
  // La clave pública VAPID no es secreta — viaja tal cual en cualquier
  // subscribe() de cualquier sitio con notificaciones push; alcanza con que
  // quien la pide esté autenticado, como el resto de la API.
  router.get('/api/push/vapid-public-key', requireAuth(async (req, res) => {
    const keys = await getOrCreateVapidKeys();
    sendJson(res, 200, { publicKey: keys.publicKey });
  }));

  router.post('/api/push/subscribe', requireAuth(async (req, res, params, body) => {
    const subscription = body?.subscription;
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return sendJson(res, 400, { error: 'Suscripción push inválida' });
    }
    await withDb((data) => {
      data.webPush = data.webPush || { vapidKeys: null, subscriptions: [] };
      data.webPush.subscriptions = data.webPush.subscriptions || [];
      // Si el mismo endpoint ya estaba guardado (re-suscripción del mismo
      // navegador, por ejemplo tras aceptar el permiso de nuevo), se
      // reemplaza en vez de dejarlo duplicado.
      data.webPush.subscriptions = data.webPush.subscriptions.filter((s) => s.subscription.endpoint !== subscription.endpoint);
      data.webPush.subscriptions.push({
        id: nextId(data, 'webPushSubscriptions'),
        userId: req.user.id,
        subscription,
        createdAt: new Date().toISOString(),
      });
    });
    sendJson(res, 200, { ok: true });
  }));

  // Se llama al desactivar el interruptor de "Notificaciones push" en "Mi
  // Perfil", o cuando el propio navegador informa que la suscripción se
  // volvió inválida. `endpoint` es opcional: sin él, se borran TODAS las
  // suscripciones de la cuenta (por ejemplo, si el navegador ya no puede
  // decir cuál era la suya).
  router.post('/api/push/unsubscribe', requireAuth(async (req, res, params, body) => {
    const endpoint = body?.endpoint || null;
    await withDb((data) => {
      if (!data.webPush?.subscriptions) return;
      data.webPush.subscriptions = data.webPush.subscriptions.filter((s) => !(
        Number(s.userId) === Number(req.user.id) && (!endpoint || s.subscription.endpoint === endpoint)
      ));
    });
    sendJson(res, 200, { ok: true });
  }));
}
