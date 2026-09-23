import crypto from 'crypto';
import { sendJson } from '../router.js';
import { load, withDb, nextId, timesOverlap, callingLabel } from '../db.js';
import { requireRole } from '../guard.js';

// ----------------------------------------------------------------------
// ENLACE PÚBLICO PARA PEDIR ENTREVISTA (link / QR)
// ----------------------------------------------------------------------
// No todos los miembros van a instalar la app ni tener cuenta. Cada líder
// puede generar SU enlace personal (/agendar/<token>) y compartirlo por
// WhatsApp o imprimirlo como QR. Quien lo abre, SIN iniciar sesión:
//   1. ve los horarios libres de ese líder (sus días/horas declarados en
//      "Mi disponibilidad", en bloques de 30 minutos, descontando las
//      entrevistas ya agendadas y las solicitudes pendientes),
//   2. elige uno, escribe su nombre y teléfono,
//   3. y queda como SOLICITUD PENDIENTE en la misma bandeja de siempre
//      (Entrevistas → Solicitudes). Nada se agenda solo: el líder confirma
//      o rechaza, igual que con las solicitudes hechas dentro de la app.
// Quien pidió recibe un enlace de seguimiento (/agendar/estado/<token>) para
// ver si su solicitud fue confirmada, sin necesidad de cuenta.
//
// Privacidad: la página pública nunca muestra quién más tiene entrevista —
// solo qué bloques están libres — ni ningún otro dato de la app.

const DIAS_ADELANTE = 21;
const MINUTOS_BLOQUE = 30;
const ANTICIPACION_MIN_HORAS = 2;
const ZONA = process.env.TZ_APP || 'America/Santiago';
const MAX_PENDIENTES_POR_TELEFONO = 2;

const token = (bytes) => crypto.randomBytes(bytes).toString('hex');

// Fecha y hora actuales en Chile (el servidor en Render corre en UTC).
function ahoraEnChile() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, minutos: Number(p.hour) * 60 + Number(p.minute) };
}
function sumarDiasISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const f = new Date(Date.UTC(y, m - 1, d + n));
  return f.toISOString().slice(0, 10);
}
function diaSemana(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
const aMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const aHora = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// Límite simple por IP (en memoria) para que el formulario público no se
// pueda usar para llenar la bandeja de solicitudes falsas.
const intentos = new Map();
function limitado(clave, max, ventanaMs) {
  const ahora = Date.now();
  const lista = (intentos.get(clave) || []).filter((t) => ahora - t < ventanaMs);
  if (lista.length >= max) { intentos.set(clave, lista); return true; }
  lista.push(ahora);
  intentos.set(clave, lista);
  return false;
}
function ipDe(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'desconocida';
}

function liderPorToken(data, t) {
  if (!t || !/^[a-f0-9]{16,64}$/.test(t)) return null;
  const u = data.users.find((x) => x.publicBookingToken === t && x.role === 'leader');
  if (!u) return null;
  const org = data.organizations.find((o) => o.id === Number(u.organizationId));
  if (!org || !org.allowsInterviews) return null;
  return { u, org };
}

// Bloques libres del líder en los próximos DIAS_ADELANTE días.
function bloquesLibres(data, u, org) {
  const ventanas = u.interviewAvailability || [];
  if (!ventanas.length) return [];
  const { fecha: hoy, minutos: ahora } = ahoraEnChile();
  const hasta = sumarDiasISO(hoy, DIAS_ADELANTE);
  const ocupados = [
    ...data.interviews
      .filter((iv) => iv.status === 'scheduled' && Number(iv.organizationId) === Number(org.id)
        && iv.interviewerName === u.name && iv.date >= hoy && iv.date <= hasta)
      .map((iv) => ({ date: iv.date, startTime: iv.startTime, endTime: iv.endTime || null })),
    ...(data.interviewRequests || [])
      .filter((r) => r.status === 'pending' && Number(r.targetLeaderUserId) === Number(u.id) && r.date >= hoy && r.date <= hasta)
      .map((r) => ({ date: r.date, startTime: r.startTime, endTime: r.endTime || null })),
  ];
  const dias = [];
  for (let i = 0; i <= DIAS_ADELANTE; i += 1) {
    const fecha = sumarDiasISO(hoy, i);
    const wd = diaSemana(fecha);
    const horas = [];
    for (const w of ventanas.filter((x) => Number(x.weekday) === wd)) {
      for (let m = aMin(w.startTime); m + MINUTOS_BLOQUE <= aMin(w.endTime); m += MINUTOS_BLOQUE) {
        if (i === 0 && m < ahora + ANTICIPACION_MIN_HORAS * 60) continue;
        const ini = aHora(m); const fin = aHora(m + MINUTOS_BLOQUE);
        if (ocupados.some((b) => b.date === fecha && timesOverlap(ini, fin, b.startTime, b.endTime))) continue;
        if (!horas.includes(ini)) horas.push(ini);
      }
    }
    if (horas.length) dias.push({ fecha, horas: horas.sort() });
  }
  return dias;
}

function publicoLider(u, org) {
  return {
    nombre: u.name,
    cargo: callingLabel(org.name, u.calling) || null,
    organizacion: org.name,
    color: org.color || '#0ea5e9',
  };
}

export function registerPublicBookingRoutes(router) {
  // ---------------- Para el líder (con sesión) ----------------
  // Devuelve (y crea la primera vez) el enlace personal del líder.
  router.get('/api/public-booking/my-link', requireRole(['leader'], async (req, res) => {
    let t = load().users.find((x) => x.id === req.user.id)?.publicBookingToken;
    if (!t) {
      t = token(12);
      await withDb((d) => { const u = d.users.find((x) => x.id === req.user.id); if (u) u.publicBookingToken = t; });
    }
    const data = load();
    const u = data.users.find((x) => x.id === req.user.id);
    sendJson(res, 200, { token: t, path: `/agendar/${t}`, tieneDisponibilidad: (u?.interviewAvailability || []).length > 0 });
  }));

  // Genera un enlace nuevo: el anterior deja de funcionar (por si se
  // compartió donde no correspondía).
  router.post('/api/public-booking/my-link/regenerate', requireRole(['leader'], async (req, res) => {
    const t = token(12);
    await withDb((d) => { const u = d.users.find((x) => x.id === req.user.id); if (u) u.publicBookingToken = t; });
    sendJson(res, 200, { token: t, path: `/agendar/${t}` });
  }));

  // ---------------- Públicas (sin sesión) ----------------
  router.get('/api/public/agendar/:token', async (req, res, params) => {
    if (limitado(`g:${ipDe(req)}`, 60, 10 * 60 * 1000)) return sendJson(res, 429, { error: 'Demasiadas consultas. Intenta en unos minutos.' });
    const data = load();
    const l = liderPorToken(data, params.token);
    if (!l) return sendJson(res, 404, { error: 'Este enlace no es válido o ya no está activo. Pide uno nuevo a tu líder.' });
    sendJson(res, 200, { lider: publicoLider(l.u, l.org), dias: bloquesLibres(data, l.u, l.org), minutosBloque: MINUTOS_BLOQUE });
  });

  router.post('/api/public/agendar/:token', async (req, res, params, body) => {
    // Campo trampa invisible: los humanos lo dejan vacío, los bots no.
    if (body?.website) return sendJson(res, 200, { ok: true, estado: null });
    if (limitado(`p:${ipDe(req)}`, 5, 60 * 60 * 1000)) return sendJson(res, 429, { error: 'Ya enviaste varias solicitudes. Intenta más tarde.' });
    const data0 = load();
    const l = liderPorToken(data0, params.token);
    if (!l) return sendJson(res, 404, { error: 'Este enlace no es válido o ya no está activo.' });

    const nombre = String(body?.nombre || '').replace(/\s+/g, ' ').trim();
    const telefono = String(body?.telefono || '').replace(/[^\d+]/g, '');
    const nota = String(body?.nota || '').trim().slice(0, 300);
    const { fecha, hora } = body || {};
    if (nombre.length < 3 || nombre.length > 80) return sendJson(res, 400, { error: 'Escribe tu nombre y apellido.' });
    if (telefono.replace(/\D/g, '').length < 8 || telefono.length > 16) return sendJson(res, 400, { error: 'Escribe un teléfono válido (ej. +56 9 1234 5678).' });
    const libre = bloquesLibres(data0, l.u, l.org).some((d) => d.fecha === fecha && d.horas.includes(hora));
    if (!libre) return sendJson(res, 409, { error: 'Ese horario ya no está disponible. Elige otro.' });
    const telNorm = telefono.replace(/\D/g, '').slice(-8);
    const pendientes = (data0.interviewRequests || []).filter((r) => r.status === 'pending' && r.memberPhone && r.memberPhone.replace(/\D/g, '').slice(-8) === telNorm);
    if (pendientes.length >= MAX_PENDIENTES_POR_TELEFONO) return sendJson(res, 400, { error: 'Ya tienes solicitudes pendientes. Espera a que te respondan antes de pedir otra.' });

    const estado = token(16);
    const now = new Date().toISOString();
    const r = await withDb((d) => {
      // Se revalida adentro: otra persona pudo tomar el mismo bloque recién.
      const aunLibre = bloquesLibres(d, l.u, l.org).some((x) => x.fecha === fecha && x.horas.includes(hora));
      if (!aunLibre) return null;
      const item = {
        id: nextId(d, 'interviewRequests'),
        memberUserId: null,
        memberName: nombre,
        memberPhone: telefono,
        organizationId: l.org.id,
        targetLeaderUserId: l.u.id,
        targetLeaderName: l.u.name,
        date: fecha,
        startTime: hora,
        endTime: aHora(aMin(hora) + MINUTOS_BLOQUE),
        note: nota,
        status: 'pending',
        source: 'enlace',
        publicStatusToken: estado,
        createdAt: now,
        decidedBy: null,
        decidedAt: null,
        decisionComment: '',
        resultingInterviewId: null,
      };
      d.interviewRequests.push(item);
      return item;
    });
    if (!r) return sendJson(res, 409, { error: 'Ese horario se acaba de ocupar. Elige otro.' });
    sendJson(res, 201, { ok: true, estado, path: `/agendar/estado/${estado}` });
  });

  router.get('/api/public/solicitud/:token', async (req, res, params) => {
    if (limitado(`g:${ipDe(req)}`, 60, 10 * 60 * 1000)) return sendJson(res, 429, { error: 'Demasiadas consultas. Intenta en unos minutos.' });
    const t = params.token;
    if (!/^[a-f0-9]{32}$/.test(t)) return sendJson(res, 404, { error: 'Solicitud no encontrada.' });
    const data = load();
    const r = (data.interviewRequests || []).find((x) => x.publicStatusToken === t);
    if (!r) return sendJson(res, 404, { error: 'Solicitud no encontrada. Puede que el líder la haya eliminado.' });
    const org = data.organizations.find((o) => o.id === Number(r.organizationId));
    const iv = r.resultingInterviewId ? data.interviews.find((x) => x.id === Number(r.resultingInterviewId)) : null;
    sendJson(res, 200, {
      estado: r.status,
      nombre: r.memberName,
      lider: r.targetLeaderName,
      organizacion: org?.name || '',
      color: org?.color || '#0ea5e9',
      fecha: iv ? iv.date : r.date,
      hora: iv ? iv.startTime : r.startTime,
      lugar: iv ? [iv.location, iv.sala].filter(Boolean).join(' · ') : '',
      // 'eliminada' = el líder confirmó y después borró la entrevista.
      entrevistaEstado: iv ? iv.status : (r.resultingInterviewId ? 'eliminada' : null),
      comentario: r.status === 'rejected' ? (r.decisionComment || '') : '',
    });
  });
}
