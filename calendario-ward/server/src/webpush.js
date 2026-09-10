// Notificaciones push del navegador (Web Push — RFC 8030/8291/8292),
// Punto 39. PRIMERA dependencia externa del servidor (ver
// server/package.json) — a propósito: implementar a mano el cifrado
// AES-128-GCM y la firma VAPID que exige el estándar habría sido un riesgo
// de seguridad innecesario para algo que la librería oficial `web-push` ya
// resuelve, prueba y mantiene. El resto de la app sigue sin ninguna otra
// dependencia.
//
// Las claves VAPID (el par de llaves que identifica a ESTA app ante los
// servicios de push de cada navegador — Chrome/FCM, Firefox, etc. — sin
// necesidad de ninguna cuenta en esos servicios) se generan UNA sola vez y
// quedan guardadas en la propia base de datos (data.webPush.vapidKeys), no
// en una variable de entorno: así no hace falta ningún paso manual de
// configuración para que las notificaciones push funcionen en un despliegue
// nuevo.
import webpush from 'web-push';
import { load, withDb } from './db.js';

// Contacto que va en la cabecera VAPID (obligatorio por el estándar, es lo
// que un servicio de push usaría para contactar al operador de la app si
// hiciera falta) — no se expone en ningún lado de la UI.
const VAPID_SUBJECT = 'mailto:soporte@organizasion.app';

export async function getOrCreateVapidKeys() {
  const data = load();
  if (data.webPush?.vapidKeys?.publicKey && data.webPush?.vapidKeys?.privateKey) {
    return data.webPush.vapidKeys;
  }
  const keys = webpush.generateVAPIDKeys();
  await withDb((d) => {
    d.webPush = { ...(d.webPush || { subscriptions: [] }), vapidKeys: keys };
  });
  return keys;
}

// `webpush.setVapidDetails` es una llamada de configuración global de la
// librería (no por request) — alcanza con hacerla una vez por proceso.
let configured = false;
async function ensureConfigured() {
  const keys = await getOrCreateVapidKeys();
  if (!configured) {
    webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
    configured = true;
  }
  return keys;
}

// Manda una notificación push a TODAS las suscripciones activas de un
// usuario (puede tener más de una — distintos navegadores/dispositivos, ej.
// el celular y el computador). Si una suscripción quedó vencida o inválida
// (código 404/410 de vuelta del servicio de push — típico si borró el
// navegador, desinstaló la PWA, o revocó el permiso desde el sistema), se
// borra sola de la base de datos, para no seguir intentando en vano en cada
// aviso futuro. Nunca lanza hacia arriba (mismo criterio que
// sendUserWhatsApp/sendEmail): si falla, queda en el log del servidor, sin
// romper el flujo que disparó la notificación.
export async function sendUserPush(user, { title, body, url }) {
  if (!user) return;
  const data0 = load();
  const subs = (data0.webPush?.subscriptions || []).filter((s) => Number(s.userId) === Number(user.id));
  if (!subs.length) return;
  await ensureConfigured();
  const payload = JSON.stringify({ title, body: body || '', url: url || '/' });
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub.subscription, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await withDb((d) => {
          d.webPush.subscriptions = (d.webPush.subscriptions || []).filter((s) => s.subscription.endpoint !== sub.subscription.endpoint);
        });
        console.log(`[push] suscripción vencida de ${user.name} eliminada`);
      } else {
        console.error(`[push] error enviando a ${user.name}:`, err.message);
      }
    }
  }
}
