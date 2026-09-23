import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireRole } from '../guard.js';
import { isObispadoLeader } from './stake.js';
import { ageFromBirthDate } from '../pastoralFocus.js';

// Módulo "Discursos" — vive dentro de la pestaña "Asignaciones" (junto a
// Aseo del Edificio), estrictamente oculto para Miembros y Líderes comunes:
// solo el Administrador o el líder de Obispado lo pueden ver o tocar (misma
// regla que ya usa Aseo del Edificio → isObispadoLeader). Registra quién
// discursó en la reunión sacramental, qué domingo y de qué tema (opcional),
// para saber cuántas veces ha discursado cada persona y cuándo fue la
// última vez — mismo espíritu que la estadística histórica de las familias
// de Aseo, pero por persona.

function normalizeSearchText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// Igual que con las familias de Aseo, dos discursos son "de la misma
// persona" si están vinculados al mismo usuario registrado (speakerUserId),
// o si no lo están, si el nombre escrito coincide (sin importar mayúsculas
// ni tildes) — así el historial no se fragmenta por variaciones menores de
// cómo se escribió el nombre cada vez.
function speakerKey(talk) {
  return talk.speakerUserId ? `u:${talk.speakerUserId}` : `n:${normalizeSearchText(talk.speakerName)}`;
}

function speakerStats(data, talk) {
  const key = speakerKey(talk);
  const mine = data.talks.filter((t) => speakerKey(t) === key);
  const timesSpoken = mine.length;
  const lastSpokenDate = mine.length ? mine.map((t) => t.date).sort().slice(-1)[0] : null;
  return { timesSpoken, lastSpokenDate };
}

function withTalkInfo(talk, data) {
  return { ...talk, ...speakerStats(data, talk) };
}

// Reutilizado por routes/stats.js ("Todo el tiempo") y por achievements.js
// (Rachas y Logros por período) para el ranking "Quién ha discursado más" —
// un renglón por persona distinta (agrupada por speakerKey), no uno por
// discurso. `range` es opcional: si viene ({start, end} ISO, ambas
// inclusive), solo cuentan los discursos dentro de ese período.
export function allSpeakersWithStats(data, range) {
  const inRange = (date) => !range || (date >= range.start && date <= range.end);
  const talksInRange = data.talks.filter((t) => inRange(t.date));
  const seen = new Map();
  for (const t of talksInRange) {
    const key = speakerKey(t);
    if (!seen.has(key)) {
      const mine = talksInRange.filter((x) => speakerKey(x) === key);
      seen.set(key, {
        speakerName: t.speakerName,
        speakerUserId: t.speakerUserId,
        timesSpoken: mine.length,
        lastSpokenDate: mine.map((x) => x.date).sort().slice(-1)[0],
      });
    }
  }
  return [...seen.values()].sort((a, b) => b.timesSpoken - a.timesSpoken);
}

export function registerTalkRoutes(router) {
  // A12: sugerir oradores — personas del Directorio (12 años o más) que
  // nunca han discursado o que llevan más tiempo sin hacerlo, sin contar a
  // quienes ya tienen un discurso asignado de hoy en adelante.
  router.get('/api/talks/suggestions', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    if (!isObispadoLeader(req.user, data)) return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado' });
    const hoy = new Date().toISOString().slice(0, 10);
    const clave = (n) => normalizeSearchText(String(n || '').replace(',', ' ')).split(/\s+/).filter(Boolean).sort().join(' ');
    // Coincidencia por nombre: todas las palabras escritas en el discurso están en el nombre del Directorio.
    const esDe = (t, m) => Number(t.speakerDirectoryId) === m.id || (!t.speakerDirectoryId && (() => {
      const w = clave(t.speakerName).split(' ').filter((x) => x.length > 1);
      const n = clave(m.name).split(' ');
      return w.length >= 2 && w.every((x) => n.includes(x));
    })());
    const soloSexo = ['V', 'M'].includes(req.query.sexo) ? req.query.sexo : null;
    const lista = [];
    for (const m of data.directoryMembers || []) {
      const edad = ageFromBirthDate(m.birthDate);
      if (edad === null || edad < 12) continue;
      if (soloSexo && m.sex !== soloSexo) continue;
      const suyos = (data.talks || []).filter((t) => esDe(t, m));
      if (suyos.some((t) => t.date >= hoy)) continue;
      const ultima = suyos.map((t) => t.date).sort().slice(-1)[0] || null;
      lista.push({ name: m.name, directoryId: m.id, edad, sexo: m.sex, veces: suyos.length, ultima });
    }
    lista.sort((a, b) => (a.ultima || '0000').localeCompare(b.ultima || '0000') || a.veces - b.veces || a.name.localeCompare(b.name));
    // Entre los que nunca han discursado, se rota para no sugerir siempre a los mismos (orden alfabético).
    const nunca = lista.filter((x) => !x.ultima);
    const semana = Math.floor(Date.now() / (7 * 86400000));
    const rotados = nunca.length ? [...nunca.slice(semana % nunca.length), ...nunca.slice(0, semana % nunca.length)] : [];
    sendJson(res, 200, [...rotados, ...lista.filter((x) => x.ultima)].slice(0, 12));
  }));

  router.get('/api/talks', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    if (!isObispadoLeader(req.user, data)) return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado pueden ver el registro de discursos' });
    const { from, to } = req.query;
    let items = data.talks;
    if (from) items = items.filter((t) => t.date >= from);
    if (to) items = items.filter((t) => t.date <= to);
    items = items.map((t) => withTalkInfo(t, data)).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    sendJson(res, 200, items);
  }));

  // Un domingo suele tener más de un discursante — igual que un turno de
  // Aseo puede tener más de una familia, este endpoint recibe un arreglo
  // "speakers" en vez de uno solo: crea un registro por cada discursante,
  // todos compartiendo la misma fecha. Llamarlo de nuevo con la misma
  // fecha agrega más discursantes a ese domingo (no hace falta un endpoint
  // aparte para "agregar a un domingo que ya tenía registro").
  router.post('/api/talks', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const data0 = load();
    if (!isObispadoLeader(req.user, data0)) return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado pueden registrar discursos' });
    const date = String(body?.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Falta la fecha del discurso (el domingo)' });
    const rawSpeakers = Array.isArray(body?.speakers)
      ? body.speakers
      : (body?.speakerName ? [{ speakerName: body.speakerName, speakerUserId: body.speakerUserId, topic: body.topic }] : []);
    const cleaned = rawSpeakers
      .map((s) => ({
        speakerName: String(s?.speakerName || '').trim(),
        speakerUserId: s?.speakerUserId,
        topic: String(s?.topic || '').trim(),
      }))
      .filter((s) => s.speakerName);
    if (!cleaned.length) return sendJson(res, 400, { error: 'Agrega al menos un discursante' });
    const now = new Date().toISOString();
    await withDb((data) => {
      for (const s of cleaned) {
        const rawUserId = s.speakerUserId;
        // Si viene un speakerUserId, se valida que exista de verdad — igual
        // que memberUserId en Entrevistas — si no, se ignora y queda como
        // si el nombre se hubiera escrito a mano.
        const speakerUserId = (rawUserId !== undefined && rawUserId !== null && rawUserId !== '')
          ? (data.users.some((u) => u.id === Number(rawUserId)) ? Number(rawUserId) : null)
          : null;
        const key = speakerUserId ? `u:${speakerUserId}` : `n:${normalizeSearchText(s.speakerName)}`;
        // Evita duplicar a la misma persona dos veces el mismo domingo (por
        // ejemplo, si ya estaba y la vuelven a agregar sin querer).
        const already = data.talks.some((t) => t.date === date && (t.speakerUserId ? `u:${t.speakerUserId}` : `n:${normalizeSearchText(t.speakerName)}`) === key);
        if (already) continue;
        data.talks.push({
          id: nextId(data, 'talks'),
          date,
          speakerName: s.speakerName,
          speakerUserId,
          topic: s.topic,
          createdBy: req.user.id,
          createdAt: now,
        });
      }
    });
    const data = load();
    const talksForDate = data.talks.filter((t) => t.date === date).map((t) => withTalkInfo(t, data));
    sendJson(res, 201, talksForDate);
  }));

  router.put('/api/talks/:id', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    if (!isObispadoLeader(req.user, data0)) return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado pueden editar el registro de discursos' });
    const existing = data0.talks.find((t) => t.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Discurso no encontrado' });
    const date = body?.date !== undefined ? String(body.date).trim() : existing.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Fecha inválida' });
    const speakerName = body?.speakerName !== undefined ? String(body.speakerName).trim() : existing.speakerName;
    if (!speakerName) return sendJson(res, 400, { error: 'Falta el nombre de quien discursó' });
    let speakerUserId = existing.speakerUserId;
    if (body?.speakerUserId !== undefined) {
      const raw = body.speakerUserId;
      speakerUserId = (raw !== null && raw !== '') ? (data0.users.some((u) => u.id === Number(raw)) ? Number(raw) : null) : null;
    }
    const topic = body?.topic !== undefined ? String(body.topic).trim() : existing.topic;
    const updated = await withDb((data) => {
      const t = data.talks.find((x) => x.id === id);
      Object.assign(t, { date, speakerName, speakerUserId, topic });
      return t;
    });
    const data = load();
    sendJson(res, 200, withTalkInfo(data.talks.find((t) => t.id === updated.id), data));
  }));

  router.delete('/api/talks/:id', requireRole(['admin', 'leader'], async (req, res, params) => {
    const id = Number(params.id);
    const data0 = load();
    if (!isObispadoLeader(req.user, data0)) return sendJson(res, 403, { error: 'Solo el Administrador o el líder de Obispado pueden eliminar del registro de discursos' });
    if (!data0.talks.some((t) => t.id === id)) return sendJson(res, 404, { error: 'Discurso no encontrado' });
    await withDb((data) => { data.talks = data.talks.filter((t) => t.id !== id); });
    sendJson(res, 200, { ok: true });
  }));
}
