// ----------------------------------------------------------------------
// AGENDA PERSONAL Y AYUDA MEMORIA
// ----------------------------------------------------------------------
//   Pendientes sin fecha ("preguntarle al obispo por el campamento"):
//     GET    /api/pendientes
//     POST   /api/pendientes            { texto }
//     PUT    /api/pendientes/:id        { texto?, hecho? }
//     DELETE /api/pendientes/:id
//   Recordatorios desde el botón "+" (los de Deseret usan el mismo lugar):
//     POST   /api/recordatorios         { texto, fecha, hora }
//   "Hecho" desde la notificación (token firmado, sin sesión):
//     POST   /api/push-accion           { t }
//   ¿Cambió algo? (para refrescar la pantalla sin recargar):
//     GET    /api/version
// Avisos automáticos:
//   - Lunes 9:00: "Tienes N pendientes sin fecha".
//   - Todos los días 19:00: "Mañana: <actividad>. Lleva: …" (qué llevar).
// ----------------------------------------------------------------------
import crypto from 'crypto';
import fs from 'fs';
import { sendJson } from '../router.js';
import { requireAuth } from '../guard.js';
import { load, withDb, nextId, DB_PATH } from '../db.js';
import { sendUserPush } from '../webpush.js';
import { pushEnabledFor } from '../notifications.js';

const ZONA = process.env.TZ_APP || 'America/Santiago';
function ahora() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour), hm: `${p.hour}:${p.minute}`, dia: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
function sumarDias(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n, 12));
  return x.toISOString().slice(0, 10);
}

// ---------------- Token para las acciones de la notificación ----------------
function secreto() {
  if (process.env.ACCIONES_SECRET) return process.env.ACCIONES_SECRET;
  const d = load();
  return d.secretoAcciones || 'organizasion';
}
export async function asegurarSecreto() {
  const d = load();
  if (!d.secretoAcciones) await withDb((db) => { if (!db.secretoAcciones) db.secretoAcciones = crypto.randomBytes(24).toString('hex'); });
}
export function tokenAccion(tipo, datos, userId, dias = 10) {
  const cuerpo = Buffer.from(JSON.stringify({ tipo, ...datos, u: userId, exp: Date.now() + dias * 86400000 })).toString('base64url');
  const firma = crypto.createHmac('sha256', secreto()).update(cuerpo).digest('base64url');
  return `${cuerpo}.${firma}`;
}
function leerToken(t) {
  const [cuerpo, firma] = String(t || '').split('.');
  if (!cuerpo || !firma) return null;
  const esperada = crypto.createHmac('sha256', secreto()).update(cuerpo).digest('base64url');
  if (esperada.length !== firma.length || !crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(firma))) return null;
  try { const o = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8')); return o.exp > Date.now() ? o : null; } catch { return null; }
}
// Botón "Hecho" para el aviso de un compromiso.
export function accionHechoCompromiso(meetingId, commitmentId, userId) {
  return [{ action: 'hecho', title: 'Hecho', t: tokenAccion('compromiso', { m: meetingId, c: commitmentId }, userId) }];
}

const limpiar = (t, n = 200) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);

export function registerAgendaRoutes(router) {
  router.get('/api/pendientes', requireAuth(async (req, res) => {
    const l = (load().pendientes || []).filter((p) => Number(p.userId) === Number(req.user.id))
      .sort((a, b) => (a.hecho === b.hecho ? String(b.creadoEn).localeCompare(String(a.creadoEn)) : a.hecho ? 1 : -1));
    sendJson(res, 200, l.slice(0, 60));
  }));
  router.post('/api/pendientes', requireAuth(async (req, res, params, body) => {
    const texto = limpiar(body?.texto);
    if (!texto) return sendJson(res, 400, { error: 'Escribe el pendiente' });
    const p = await withDb((db) => {
      db.pendientes = db.pendientes || [];
      const x = { id: nextId(db, 'pendientes'), userId: req.user.id, texto: texto.charAt(0).toUpperCase() + texto.slice(1), hecho: false, creadoEn: new Date().toISOString() };
      db.pendientes.push(x);
      return x;
    });
    sendJson(res, 201, p);
  }));
  router.put('/api/pendientes/:id', requireAuth(async (req, res, params, body) => {
    const id = Number(params.id);
    const p = await withDb((db) => {
      const x = (db.pendientes || []).find((y) => y.id === id && Number(y.userId) === Number(req.user.id));
      if (!x) return null;
      if (body?.texto !== undefined) x.texto = limpiar(body.texto) || x.texto;
      if (body?.hecho !== undefined) { x.hecho = !!body.hecho; x.hechoEn = x.hecho ? new Date().toISOString() : null; }
      return x;
    });
    if (!p) return sendJson(res, 404, { error: 'Pendiente no encontrado' });
    sendJson(res, 200, p);
  }));
  router.delete('/api/pendientes/:id', requireAuth(async (req, res, params) => {
    const id = Number(params.id);
    await withDb((db) => { db.pendientes = (db.pendientes || []).filter((y) => !(y.id === id && Number(y.userId) === Number(req.user.id))); });
    sendJson(res, 200, { ok: true });
  }));

  router.post('/api/recordatorios', requireAuth(async (req, res, params, body) => {
    const texto = limpiar(body?.texto);
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.fecha || '')) ? body.fecha : null;
    const hora = /^\d{2}:\d{2}$/.test(String(body?.hora || '')) ? body.hora : null;
    if (!texto || !fecha || !hora) return sendJson(res, 400, { error: 'Falta qué recordar, el día o la hora' });
    const a = ahora();
    if (`${fecha} ${hora}` <= `${a.fecha} ${a.hm}`) return sendJson(res, 400, { error: 'Esa hora ya pasó' });
    const r = await withDb((db) => {
      db.recordatorios = db.recordatorios || [];
      const x = { id: nextId(db, 'recordatorios'), userId: req.user.id, texto: texto.charAt(0).toUpperCase() + texto.slice(1), fecha, hora, enviado: false, createdAt: new Date().toISOString() };
      db.recordatorios.push(x);
      return x;
    });
    sendJson(res, 201, r);
  }));

  // Botón de la notificación (el service worker no tiene la sesión: usa el token firmado).
  router.post('/api/push-accion', async (req, res, params, body) => {
    const o = leerToken(body?.t);
    if (!o) return sendJson(res, 400, { error: 'El aviso venció' });
    let ok = false;
    await withDb((db) => {
      if (o.tipo === 'compromiso') {
        const m = (db.meetings || []).find((x) => x.id === Number(o.m));
        const c = m && (m.commitments || []).find((x) => x.id === Number(o.c));
        if (c && Number(c.assignedToUserId) === Number(o.u) && c.status === 'pending') {
          Object.assign(c, { status: 'completed', completedAt: new Date().toISOString(), completionComment: c.completionComment || 'Marcado desde la notificación' });
          ok = true;
        }
      } else if (o.tipo === 'preparativo') {
        const e = (db.events || []).find((x) => x.id === Number(o.e));
        const t = e && (e.preparativos || []).find((x) => x.id === Number(o.p));
        if (t && Number(t.responsableId) === Number(o.u)) { t.hecho = true; t.hechoPor = Number(o.u); t.hechoEn = new Date().toISOString(); ok = true; }
      } else if (o.tipo === 'pendiente') {
        const p = (db.pendientes || []).find((x) => x.id === Number(o.p) && Number(x.userId) === Number(o.u));
        if (p) { p.hecho = true; p.hechoEn = new Date().toISOString(); ok = true; }
      }
    });
    sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Ya estaba hecho o no se encontró' });
  });

  router.get('/api/version', requireAuth(async (req, res) => {
    let v = 0;
    try { v = Math.round(fs.statSync(DB_PATH).mtimeMs); } catch { v = 0; }
    sendJson(res, 200, { v });
  }));
}

// ---------------- Avisos automáticos ----------------
async function avisoPendientesLunes() {
  const a = ahora();
  if (a.dia !== 1 || a.hora < 9) return;
  const data = load();
  if (data.pendientesAvisados === a.fecha) return;
  await withDb((db) => { db.pendientesAvisados = a.fecha; });
  const porUsuario = new Map();
  for (const p of data.pendientes || []) if (!p.hecho) porUsuario.set(Number(p.userId), [...(porUsuario.get(Number(p.userId)) || []), p]);
  for (const [uid, lista] of porUsuario) {
    const u = data.users.find((x) => x.id === uid);
    if (!u || !pushEnabledFor(u, 'commitments')) continue;
    try {
      await sendUserPush(u, { title: `Tienes ${lista.length} pendiente${lista.length === 1 ? '' : 's'} sin fecha`, body: lista.slice(0, 3).map((p) => `• ${p.texto}`).join('\n'), url: '/?vista=home' });
    } catch { /* sin push */ }
  }
}

async function avisoQueLlevar() {
  const a = ahora();
  if (a.hora < 19) return;
  const data = load();
  if (data.queLlevarAvisado === a.fecha) return;
  const manana = sumarDias(a.fecha, 1);
  const eventos = (data.events || []).filter((e) => e.date === manana && String(e.queLlevar || '').trim());
  await withDb((db) => { db.queLlevarAvisado = a.fecha; });
  for (const e of eventos) {
    const ids = new Set([Number(e.createdBy)]);
    (e.preparativos || []).forEach((t) => { if (t.responsableId) ids.add(Number(t.responsableId)); });
    (e.rsvps || []).forEach((r) => { if (r.response === 'yes') ids.add(Number(r.userId)); });
    const lista = String(e.queLlevar).split(/\n+/).map((x) => x.trim()).filter(Boolean).join(', ');
    for (const uid of ids) {
      const u = data.users.find((x) => x.id === uid);
      if (!u || !pushEnabledFor(u, 'events')) continue;
      try { await sendUserPush(u, { title: `Mañana: ${e.title}${e.startTime ? ` a las ${e.startTime}` : ''}`, body: `No olvides llevar: ${lista}`, url: '/?vista=home' }); } catch { /* sin push */ }
    }
  }
}

let iniciado = false;
export function iniciarAvisosAgenda() {
  if (iniciado) return;
  iniciado = true;
  asegurarSecreto().catch(() => {});
  const tick = () => { avisoPendientesLunes().catch((e) => console.warn('[agenda]', e.message)); avisoQueLlevar().catch((e) => console.warn('[agenda]', e.message)); };
  setTimeout(tick, 25_000);
  setInterval(tick, 10 * 60 * 1000);
}
