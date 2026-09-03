// Envío de notificaciones por WhatsApp usando CallMeBot — un servicio
// gratuito de terceros que no requiere verificar un número de WhatsApp
// Business ni pagar nada, a cambio de que CADA PERSONA active su propia
// clave una sola vez (no hay una cuenta global del barrio, como sí existe
// para el correo con GMAIL_USER/GMAIL_APP_PASSWORD):
//
//   1. La persona agrega el número +34 644 59 71 30 a sus contactos de
//      WhatsApp.
//   2. Le manda al bot el mensaje exacto: "I allow callmebot to send me
//      messages" (en inglés, tal cual).
//   3. El bot le responde con su clave (apikey) personal, un número.
//   4. Esa persona guarda su teléfono y esa clave en OrganizaSion → "Mi
//      Perfil" → Notificaciones por WhatsApp.
//
// A partir de ahí, cualquier notificación de esta app que le corresponda
// (su propia entrevista, su propio compromiso) le llega también por
// WhatsApp además de por correo (si tiene su email cargado). No depende de
// GMAIL_USER/GMAIL_APP_PASSWORD en absoluto — funciona aunque el correo no
// esté configurado, y viceversa.
//
// Límite conocido del plan gratuito de CallMeBot: como máximo unos pocos
// mensajes por día por número (documentado por CallMeBot, no controlado
// por esta app) — más que suficiente para el volumen de un barrio.

import https from 'https';

const CALLMEBOT_HOST = 'api.callmebot.com';

// Normaliza un teléfono a solo dígitos, anteponiendo el código de país de
// Chile (56) si quedó en formato local de 9 dígitos empezando con 9 — igual
// criterio que ya usa el cliente para armar enlaces de WhatsApp (Punto 100,
// ver waLink() en app.js), para que baste con escribir "9 1234 5678".
export function normalizeWhatsAppPhone(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) return '';
  return (digits.length === 9 && digits.startsWith('9')) ? `56${digits}` : digits;
}

// Un usuario "tiene WhatsApp configurado" cuando declaró tanto su teléfono
// como su clave de CallMeBot — los dos datos son indispensables, si falta
// cualquiera de los dos simplemente no se le puede escribir.
export function canSendWhatsApp(user) {
  return !!(user && user.whatsappPhone && user.whatsappApiKey);
}

// Petición GET mínima a la API de CallMeBot (sin ninguna librería externa,
// igual que email.js habla SMTP a mano) — no hace falta más que un GET con
// tres parámetros de query.
export function sendWhatsApp({ phone, apikey, text }) {
  return new Promise((resolve, reject) => {
    const path = `/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(apikey)}`;
    const req = https.request({ host: CALLMEBOT_HOST, path, method: 'GET', timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        // CallMeBot responde 200 incluso para algunos errores propios (ej.
        // clave inválida) con un texto explicando el problema en el cuerpo
        // — por eso además de el código HTTP se revisa que el cuerpo no
        // declare un error explícito.
        if (res.statusCode >= 200 && res.statusCode < 300 && !/error/i.test(body)) {
          resolve(body);
        } else {
          reject(new Error(`CallMeBot respondió ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('CallMeBot no respondió a tiempo')));
    req.on('error', reject);
    req.end();
  });
}

// Envía un mensaje de WhatsApp a un USUARIO de la app (no a un teléfono
// suelto) — solo si esa cuenta ya activó su clave de CallMeBot. Nunca lanza
// hacia arriba: como con el correo, si falla, queda solo en el log del
// servidor, sin romper el flujo que disparó la notificación.
export async function sendUserWhatsApp(user, text, label) {
  if (!canSendWhatsApp(user)) return;
  try {
    await sendWhatsApp({ phone: normalizeWhatsAppPhone(user.whatsappPhone), apikey: user.whatsappApiKey, text });
    console.log(`[whatsapp] "${label}" enviado a ${user.name}`);
  } catch (err) {
    console.error(`[whatsapp] error enviando "${label}" a ${user.name}:`, err.message);
  }
}
