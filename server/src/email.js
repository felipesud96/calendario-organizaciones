// Envío de correo usando tu propia cuenta de Gmail (SMTP), sin depender de
// ningún servicio externo ni de tener un dominio propio: usa el módulo
// `tls` incorporado de Node para hablar el protocolo SMTP directo con
// smtp.gmail.com (puerto 465), autenticado con una "contraseña de
// aplicación" de tu cuenta de Google.
//
// Configuración (variables de entorno):
//   GMAIL_USER          -> tu cuenta de Gmail completa, ej: calendariobarrio@gmail.com
//   GMAIL_APP_PASSWORD  -> la "contraseña de aplicación" de 16 caracteres (no tu contraseña normal)
//
// Si cualquiera de las dos falta, los recordatorios quedan desactivados
// automáticamente (no rompe el resto de la app).

import tls from 'tls';

const SMTP_HOST = process.env.SMTP_TEST_HOST || 'smtp.gmail.com';
const SMTP_PORT = process.env.SMTP_TEST_PORT ? Number(process.env.SMTP_TEST_PORT) : 465;
const SMTP_INSECURE = !!process.env.SMTP_TEST_INSECURE; // solo para pruebas locales con certificado autofirmado

function creds() {
  return {
    user: process.env.GMAIL_USER || '',
    pass: process.env.GMAIL_APP_PASSWORD || '',
  };
}

export function isEmailConfigured() {
  const { user, pass } = creds();
  return !!(user && pass);
}

function b64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

// "Dot-stuffing" requerido por SMTP: cualquier línea que empiece con "."
// dentro del cuerpo del mensaje debe duplicarse, si no el servidor la
// interpreta como el fin del mensaje.
function dotStuff(text) {
  return text.replace(/(^|\r\n)\./g, '$1..');
}

function buildMessage({ from, to, subject, html }) {
  const headers =
    `From: ${from}\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${subject}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/html; charset=UTF-8\r\n` +
    `Content-Transfer-Encoding: 8bit\r\n`;
  const body = dotStuff(html);
  return `${headers}\r\n${body}\r\n`;
}

// Cliente SMTP mínimo hecho a mano (sin librerías externas). Alcanza
// perfectamente para el volumen de un barrio (una entrevista cada tanto);
// habla el protocolo lo justo y necesario para autenticar y enviar un
// correo vía Gmail.
export function sendEmail({ to, subject, html }) {
  const { user, pass } = creds();
  return new Promise((resolve, reject) => {
    if (!user || !pass) {
      reject(new Error('Recordatorios por email no configurados (falta GMAIL_USER o GMAIL_APP_PASSWORD)'));
      return;
    }

    const message = buildMessage({ from: user, to, subject, html });
    const steps = [
      { cmd: 'EHLO calendario-ward.local', expect: 250 },
      { cmd: 'AUTH LOGIN', expect: 334 },
      { cmd: b64(user), expect: 334 },
      { cmd: b64(pass), expect: 235 },
      { cmd: `MAIL FROM:<${user}>`, expect: 250 },
      { cmd: `RCPT TO:<${to}>`, expect: 250 },
      { cmd: 'DATA', expect: 354 },
      { cmd: `${message}.`, expect: 250 },
      { cmd: 'QUIT', expect: 221 },
    ];

    let step = -1; // -1 = esperando el saludo inicial (220) del servidor
    let buffer = '';
    let settled = false;

    const socket = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, rejectUnauthorized: !SMTP_INSECURE });
    socket.setEncoding('utf8');
    socket.setTimeout(15000);

    function done(err) {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err); else resolve();
    }

    function sendNext() {
      step++;
      if (step >= steps.length) { done(); return; }
      socket.write(steps[step].cmd + '\r\n');
    }

    socket.on('data', (chunk) => {
      buffer += chunk;
      // una respuesta SMTP puede venir en varias líneas ("250-..." intermedias,
      // "250 ..." la última); solo actuamos cuando ya llegó la línea final.
      const lines = buffer.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || /^\d{3}-/.test(last)) return; // todavía faltan líneas de esta respuesta
      buffer = '';
      const code = Number(last.slice(0, 3));
      if (step === -1) {
        if (code !== 220) return done(new Error(`Gmail no respondió con saludo válido: ${last}`));
        sendNext();
        return;
      }
      const expected = steps[step].expect;
      if (code !== expected) {
        return done(new Error(`Gmail SMTP respondió ${code} (se esperaba ${expected}): ${last}`));
      }
      sendNext();
    });

    socket.on('error', (err) => done(err));
    socket.on('timeout', () => done(new Error('Tiempo de espera agotado conectando a Gmail SMTP')));
  });
}
