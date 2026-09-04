import crypto from 'crypto';
import { load, withDb } from '../db.js';
import { requireAuth } from '../guard.js';
import { sendJson } from '../router.js';
import { canSeeMeeting } from './events.js';
import { buildIcsCalendar } from '../ics.js';
import { joinNames } from './interviews.js';

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
// / renderMyActivitiesMemberView): las actividades de todo el Barrio siempre
// aparecen; un Líder además ve SIEMPRE las de su propia organización (no es
// opcional, es la que administra); y cualquiera (Líder o Miembro) puede
// además "seguir" otras organizaciones — por ejemplo, un líder de Cuórum de
// Élderes con hijos en Primaria puede sumar Primaria a su listado, igual que
// puede hacerlo un Miembro. En ambos casos, además, las entrevistas en las
// que a la propia persona la entrevistan. Se respeta el filtro de
// privacidad de Reuniones.
function myActivitiesItems(user, data) {
  let events = data.events.filter((e) => canSeeMeeting(user, e));
  const myOrgId = user.role === 'leader' ? Number(user.organizationId) : null;
  const followedIds = (user.followedOrganizationIds || []).map(Number);
  events = events.filter(
    (ev) => ev.isWardActivity
      || (myOrgId !== null && Number(ev.organizationId) === myOrgId)
      || followedIds.includes(Number(ev.organizationId))
      || (ev.involvedOrganizationIds || []).map(Number).some((id) => id === myOrgId || followedIds.includes(id)),
  );
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
  // Si se le citó junto con alguien más (matrimonio, compañerismo de
  // ministración — ver groupId en interviews.js), se le avisa con quién,
  // sin exponer el teléfono/email de esa otra persona (que sigue siendo
  // dato privado de la entrevista, no de "Mis Actividades").
  const othersInGroup = (iv) => data.interviews
    .filter((o) => o.groupId === iv.groupId && o.id !== iv.id)
    .map((o) => o.memberName);
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
      othersInGroup(iv).length ? `Junto con: ${joinNames(othersInGroup(iv))}` : '',
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
