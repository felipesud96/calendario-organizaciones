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

export async function getUserFromToken(token) {
  if (!token) return null;
  const data = load();
  const session = data.sessions.find((s) => s.token === token);
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
  const { passwordHash, ...rest } = user;
  return rest;
}
