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
  // Corrección (revisión de código): dos peticiones casi simultáneas a este
  // endpoint (dos pestañas abriendo "Mi Perfil" a la vez, por ejemplo)
  // podían ver ambas `existing` vacío y generar CADA UNA un token distinto
  // — el que se guardara al final ganaba, dejando a la otra petición con un
  // enlace de calendario que ya no coincide con lo guardado (dejaría de
  // funcionar en silencio). Se vuelve a revisar adentro de withDb (que sí
  // serializa) antes de generar uno nuevo, así la segunda petición
  // simplemente reutiliza el que la primera ya guardó.
  return withDb((d) => {
    const u = d.users.find((x) => x.id === userId);
    if (!u) return null;
    if (u.calendarToken) return u.calendarToken;
    const token = crypto.randomBytes(24).toString('hex');
    u.calendarToken = token;
    return token;
  });
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
  // Corrección (revisión de código): el Secretario Ejecutivo también puede
  // agendar/conducir entrevistas de su propia organización (Obispado) — ver
  // canScheduleOrg en interviews.js y canDecideFor en
  // interview-requests.js — pero acá solo se incluía `role === 'leader'`,
  // así que a ese rol le faltaban sus propias entrevistas conducidas tanto
  // en "Mis Actividades" como en el feed .ics exportado.
  const myOrgId = (user.role === 'leader' || user.role === 'executive_secretary') ? Number(user.organizationId) : null;
  const followedIds = (user.followedOrganizationIds || []).map(Number);
  events = events.filter(
    (ev) => ev.isWardActivity
      || (myOrgId !== null && Number(ev.organizationId) === myOrgId)
      || followedIds.includes(Number(ev.organizationId))
      || (ev.involvedOrganizationIds || []).map(Number).some((id) => id === myOrgId || followedIds.includes(id)),
  );
  // Además de las entrevistas en las que a la propia persona la entrevistan
  // (en cualquier organización), un Líder también ve acá las que agenda su
  // PROPIA organización — las que él mismo (o algún consejero de su
  // presidencia) conduce como entrevistador — mismo criterio que ya aplica
  // GET /api/interviews para la pestaña Entrevistas, así su agenda queda
  // completa en un solo lugar/enlace.
  const myInterviews = data.interviews.filter(
    (iv) => Number(iv.memberUserId) === Number(user.id) || (myOrgId !== null && Number(iv.organizationId) === myOrgId),
  );

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
  const interviewItems = myInterviews.map((iv) => {
    // Si la entrevista es de tu propia organización y tú no eres el
    // entrevistado, la estás conduciendo tú (o algún consejero de tu
    // presidencia) — el resumen debe decir a QUIÉN se entrevista, no "te
    // entrevista", que sería confuso/incorrecto en ese caso.
    const conducting = myOrgId !== null && Number(iv.organizationId) === myOrgId && Number(iv.memberUserId) !== Number(user.id);
    return {
      id: iv.id,
      kind: 'interview',
      date: iv.date,
      startTime: iv.startTime,
      endTime: iv.endTime,
      summary: conducting
        ? `👤 Entrevista a ${iv.memberName}${iv.description ? ': ' + iv.description : ''}`
        : `👤 Entrevista${iv.description ? ': ' + iv.description : ''}`,
      location: iv.location || '',
      description: [
        conducting
          ? (iv.interviewerName ? `Entrevistador: ${iv.interviewerName}` : '')
          : (iv.interviewerName ? `Te entrevista: ${iv.interviewerName}` : ''),
        !conducting && orgName(iv.organizationId) ? `Organización: ${orgName(iv.organizationId)}` : '',
        othersInGroup(iv).length ? `Junto con: ${joinNames(othersInGroup(iv))}` : '',
      ].filter(Boolean).join('\n'),
      organizationName: orgName(iv.organizationId),
    };
  });

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
