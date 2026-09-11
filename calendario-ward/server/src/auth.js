import crypto from 'crypto';
import { load, save, withDb } from './db.js';

const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(attempt, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  await withDb((data) => {
    data.sessions.push({ token, userId, expiresAt });
    // limpieza de sesiones expiradas
    data.sessions = data.sessions.filter((s) => s.expiresAt > Date.now());
  });
  return token;
}

// Corrección (revisión de código): buscar la sesión con `===` compara la
// cadena caracter por caracter y corta apenas encuentra una diferencia — en
// teoría (aunque explotarlo por red es difícil, no imposible con muchas
// mediciones) eso filtra por cuánto tarda la comparación cuántos caracteres
// iniciales de un token adivinado coinciden con uno real. Ya se usa
// `crypto.timingSafeEqual` para la contraseña (ver verifyPassword arriba) —
// se aplica el mismo criterio acá, por consistencia y como buena práctica,
// aunque el token de sesión (32 bytes al azar) ya es difícil de adivinar de
// entrada.
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export async function getUserFromToken(token) {
  if (!token) return null;
  const data = load();
  const session = data.sessions.find((s) => timingSafeStringEqual(s.token, token));
  if (!session) return null;
  if (session.expiresAt < Date.now()) return null;
  const user = data.users.find((u) => u.id === session.userId);
  return user || null;
}

export async function destroySession(token) {
  await withDb((data) => {
    data.sessions = data.sessions.filter((s) => s.token !== token);
  });
}

export function publicUser(user) {
  if (!user) return null;
  // Corrección (revisión de código): `passwordReset` guarda, mientras está
  // activo, el código de 6 dígitos de recuperación de contraseña en texto
  // plano (ver auth-routes.js) — antes se filtraba tal cual en cualquier
  // respuesta que incluyera a este usuario (GET /api/users, /api/auth/me,
  // etc.), visible para cualquier Administrador mientras alguien tuviera
  // una recuperación en curso. Se quita del objeto público igual que ya se
  // hace con `passwordHash`.
  const { passwordHash, passwordReset, ...rest } = user;
  return rest;
}
