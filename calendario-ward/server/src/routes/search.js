import { sendJson } from '../router.js';
import { load } from '../db.js';
import { requireAuth } from '../guard.js';
import { canSeeMeeting as canSeeCalendarMeeting } from './events.js';
import { orgSeesAllInterviews } from './interviews.js';
import { canSeeMeetingRecord } from './meetings.js';
import { isObispadoLeader } from './stake.js';

// Módulo "Búsqueda global": una sola caja de texto en la barra superior que
// busca a la vez en actividades/reuniones del calendario, entrevistas, actas
// y compromisos, y discursos — para no tener que adivinar en qué pestaña
// está algo. Cada categoría reutiliza EXACTAMENTE la misma regla de
// privacidad que ya aplica su propia pestaña (importada, no duplicada) para
// no arriesgar mostrar en la búsqueda algo que esa persona no debería ver.

function normalizeSearchText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

const MAX_PER_CATEGORY = 8;

export function registerSearchRoutes(router) {
  router.get('/api/search', requireAuth(async (req, res) => {
    const raw = String(req.query.q || '').trim();
    if (raw.length < 2) return sendJson(res, 200, { query: raw, results: [] });
    const q = normalizeSearchText(raw);
    const data = load();
    const user = req.user;
    const results = [];

    // Actividades y reuniones privadas del calendario — misma regla que
    // GET /api/events (canSeeMeeting: una "reunión" del calendario, si el
    // ítem es privado, solo la ve quien corresponde).
    let eventMatches = data.events.filter((e) => canSeeCalendarMeeting(user, e) && (
      normalizeSearchText(e.title).includes(q) || normalizeSearchText(e.description).includes(q)
    ));
    eventMatches = eventMatches.sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_PER_CATEGORY);
    for (const e of eventMatches) {
      const org = data.organizations.find((o) => o.id === Number(e.organizationId));
      results.push({
        category: 'events', categoryLabel: e.isMeeting ? 'Reuniones' : 'Actividades', icon: e.isMeeting ? '🔒' : '📅',
        id: e.id, title: e.title, subtitle: `${org?.name || ''} · ${e.date}`, date: e.date,
      });
    }

    // Entrevistas — un Miembro solo ve la suya propia; un líder ve las de su
    // organización (o todas si es líder de Obispado); el Administrador ve
    // todas. Igual regla que GET /api/interviews.
    {
      let ivPool = data.interviews;
      if (user.role === 'member') {
        ivPool = ivPool.filter((iv) => Number(iv.memberUserId) === Number(user.id));
      } else if (!orgSeesAllInterviews(user, data)) {
        ivPool = ivPool.filter((iv) => Number(iv.organizationId) === Number(user.organizationId) || Number(iv.memberUserId) === Number(user.id));
      }
      let ivMatches = ivPool.filter((iv) => normalizeSearchText(iv.memberName).includes(q) || normalizeSearchText(iv.description).includes(q));
      ivMatches = ivMatches.sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_PER_CATEGORY);
      for (const iv of ivMatches) {
        const org = data.organizations.find((o) => o.id === Number(iv.organizationId));
        results.push({
          category: 'interviews', categoryLabel: 'Entrevistas', icon: '👤',
          id: iv.id, title: iv.memberName, subtitle: `${org?.name || ''} · ${iv.date}`, date: iv.date,
        });
      }
    }

    // Actas y compromisos — solo Admin/Líder, misma regla que GET
    // /api/meetings (canSeeMeetingRecord: propia organización, o todas si es
    // líder de Obispado).
    if (user.role === 'admin' || user.role === 'leader') {
      const meetingPool = data.meetings.filter((m) => canSeeMeetingRecord(user, m, data));
      let meetingMatches = meetingPool.filter((m) => normalizeSearchText(m.title).includes(q));
      meetingMatches = meetingMatches.sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_PER_CATEGORY);
      for (const m of meetingMatches) {
        const org = data.organizations.find((o) => o.id === Number(m.organizationId));
        results.push({
          category: 'meetings', categoryLabel: 'Actas', icon: '📋',
          id: m.id, title: m.title, subtitle: `${org?.name || 'Administración'} · ${m.date}`, date: m.date,
        });
      }
      // Compromisos: se buscan por su propia descripción, pero el resultado
      // apunta al acta que lo contiene (no hay pantalla propia de detalle
      // de un compromiso suelto).
      const commitmentMatches = [];
      for (const m of meetingPool) {
        if (!canSeeMeetingRecord(user, m, data)) continue;
        for (const c of (m.commitments || [])) {
          if (normalizeSearchText(c.description).includes(q)) commitmentMatches.push({ meeting: m, commitment: c });
        }
      }
      commitmentMatches.sort((a, b) => b.commitment.dueDate.localeCompare(a.commitment.dueDate));
      for (const { meeting: m, commitment: c } of commitmentMatches.slice(0, MAX_PER_CATEGORY)) {
        const assignee = data.users.find((u) => u.id === Number(c.assignedToUserId));
        results.push({
          category: 'meetings', categoryLabel: 'Compromisos', icon: '🎯',
          id: m.id, title: c.description, subtitle: `${assignee?.name || ''} · acta "${m.title}" · vence ${c.dueDate}`, date: c.dueDate,
        });
      }
    }

    // Discursos — solo Administrador o líder de Obispado, misma regla que
    // GET /api/talks.
    if (isObispadoLeader(user, data)) {
      let talkMatches = data.talks.filter((t) => normalizeSearchText(t.speakerName).includes(q) || normalizeSearchText(t.topic).includes(q));
      talkMatches = talkMatches.sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_PER_CATEGORY);
      for (const t of talkMatches) {
        results.push({
          category: 'talks', categoryLabel: 'Discursos', icon: '🎤',
          id: t.id, title: t.speakerName, subtitle: `${t.topic || 'Sin tema'} · ${t.date}`, date: t.date,
        });
      }
    }

    sendJson(res, 200, { query: raw, results });
  }));
}
