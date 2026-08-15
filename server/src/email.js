// Envío de correo vía Resend (https://resend.com), usando únicamente el
// módulo `https` incorporado de Node — no se necesita instalar nada.
//
// Configuración (variables de entorno):
//   RESEND_API_KEY      -> API key de tu cuenta de Resend
//   REMINDER_FROM_EMAIL -> remitente verificado, ej: "Calendario Barrio <recordatorios@tudominio.com>"
//
// Si cualquiera de las dos falta, los recordatorios quedan desactivados
// automáticamente (no rompe el resto de la app).

import https from 'https';

function apiKey() {
  return process.env.RESEND_API_KEY || '';
}

function fromEmail() {
  return process.env.REMINDER_FROM_EMAIL || '';
}

export function isEmailConfigured() {
  return !!(apiKey() && fromEmail());
}

export function sendEmail({ to, subject, html }) {
  return new Promise((resolve, reject) => {
    if (!isEmailConfigured()) {
      reject(new Error('Recordatorios por email no configurados (falta RESEND_API_KEY o REMINDER_FROM_EMAIL)'));
      return;
    }
    const payload = JSON.stringify({
      from: fromEmail(),
      to: [to],
      subject,
      html,
    });
    const req = https.request(
      {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data ? JSON.parse(data) : {});
          } else {
            reject(new Error(`Resend respondió ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
