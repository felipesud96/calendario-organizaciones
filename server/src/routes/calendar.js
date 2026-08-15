import crypto from 'crypto';
import { load, withDb } from '../db.js';
import { requireAuth } from '../guard.js';
import { sendJson } from '../router.js';
import { canSeeMeeting } from './events.js';
import { buildIcsCalendar } from '../ics.js';

async function getOrCreateCalendarToken(userId) {
  const data = load();
  const existing = data.users.find((u) => u.id === userId)?.calendarToken;
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString('hex');
  await withDb((d) => {
    const u = d.users.find((x) => x.id === userId);
    if (u) u.calendarToken = token;
  });
  return token;
}

async function regenerateCalendarToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await withDb((d) => {
    const u = d.users.find((x) => x.id === userId);
    if (u) u.calendarToken = token;
  });
  return token;
}

// Misma lógica que "Mis Actividades" en el cliente (renderMyActivitiesLeaderView
// / renderMyActivitiesMemberView): para Líder, las actividades de su propia
// organización más las de todo el Barrio y las que la incluyen como
// "involucrada"; para Miembro (y Administrador, que usa la misma vista),
// las de las organizaciones que sigue más las de todo el Barrio. En ambos
// casos, además, las entrevistas en las que a la propia persona la
// entrevistan. Se respeta el filtro de privacidad de Reuniones.
function myActivitiesItems(user, data) {
  let events = data.events.filter((e) => canSeeMeeting(user, e));
  if (user.role === 'leader') {
    const myOrgId = Number(user.organizationId);
    events = events.filter(
      (ev) => Number(ev.organizationId) === myOrgId || ev.isWardActivity
        || (ev.involvedOrganizationIds || []).map(Number).includes(myOrgId),
    );
  } else {
    const followedIds = (user.followedOrganizationIds || []).map(Number);
    events = events.filter(
      (ev) => ev.isWardActivity || followedIds.includes(Number(ev.organizationId))
        || (ev.involvedOrganizationIds || []).map(Number).some((id) => followedIds.includes(id)),
    );
  }
  const myInterviews = data.interviews.filter((iv) => Number(iv.memberUserId) === Number(user.id));

  const orgName = (id) => data.organizations.find((o) => o.id === Number(id))?.name || '';

  const eventItems = events.map((ev) => ({
    id: ev.id,
    kind: 'event',
    date: ev.date,
    startTime: ev.startTime,
    endTime: ev.endTime,
    summary: `${ev.isMeeting ? '🔒 ' : ev.isWardActivity ? '🏘️ ' : ''}${ev.title}`,
    location: ev.location || '',
    description: ev.description || '',
    organizationName: orgName(ev.organizationId),
  }));
  const interviewItems = myInterviews.map((iv) => ({
    id: iv.id,
    kind: 'interview',
    date: iv.date,
    startTime: iv.startTime,
    endTime: iv.endTime,
    summary: `👤 Entrevista${iv.description ? ': ' + iv.description : ''}`,
    location: iv.location || '',
    description: [
      iv.interviewerName ? `Te entrevista: ${iv.interviewerName}` : '',
      orgName(iv.organizationId) ? `Organización: ${orgName(iv.organizationId)}` : '',
    ].filter(Boolean).join('\n'),
    organizationName: orgName(iv.organizationId),
  }));

  return [...eventItems, ...interviewItems].sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
}

export function registerCalendarRoutes(router) {
  // Da (o crea si aún no existe) el token personal de solo-lectura que
  // identifica el feed .ics del usuario — es distinto del token de sesión:
  // no expira, porque las apps de calendario lo van a usar para revisar
  // este enlace periódicamente sin volver a iniciar sesión.
  router.get('/api/auth/me/calendar-token', requireAuth(async (req, res) => {
    const token = await getOrCreateCalendarToken(req.user.id);
    sendJson(res, 200, { token });
  }));

  router.post('/api/auth/me/calendar-token/regenerate', requireAuth(async (req, res) => {
    const token = await regenerateCalendarToken(req.user.id);
    sendJson(res, 200, { token });
  }));

  // Feed público (sin sesión — se autentica solo con el token en la URL,
  // como cualquier suscripción de calendario) con las mismas actividades y
  // entrevistas que "Mis Actividades" le muestra a ese usuario.
  router.get('/api/calendar/feed.ics', async (req, res) => {
    const token = req.query.token;
    if (!token) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Falta el token de calendario');
    }
    const data = load();
    const user = data.users.find((u) => u.calendarToken === token);
    if (!user) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Enlace de calendario inválido');
    }
    const items = myActivitiesItems(user, data);
    const ics = buildIcsCalendar(items, `Mis Actividades — ${user.name}`);
    res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="mis-actividades.ics"',
      'Cache-Control': 'no-cache, no-store',
    });
    res.end(ics);
  });
}
