import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireRole } from '../guard.js';
import { isObispadoLeader } from './stake.js';

// ==================================================================
// Módulo "Acuerdos entre organizaciones" (Fase 7, idea de Felipe): a
// diferencia de un acta (que vive DENTRO de una organización) o de una
// actividad conjunta puntual (ver involvedOrganizationIds en events.js),
// un acuerdo es un compromiso EXPLÍCITO y de más largo plazo entre dos o
// más presidencias — ej. "el presidente del Cuórum de Élderes y la
// presidenta de la Sociedad de Socorro acordaron que el 4to domingo de
// cada mes hacen la misma clase combinada" — para que quede registrado y
// ambas partes se mantengan alineadas, en vez de depender de la memoria de
// cada presidente (y de que ninguno de los dos se cambie sin avisar al
// otro).
// ==================================================================

export const AGREEMENT_RECURRENCE_TYPES = ['structured', 'freeform', 'once'];
const WEEKDAY_LABELS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const NTH_LABELS = { 1: '1er', 2: '2do', 3: '3er', 4: '4to', 5: '5to', last: 'último' };

function isValidWeekday(w) { return Number.isInteger(w) && w >= 0 && w <= 6; }
function isValidNth(n) { return n === 'last' || (Number.isInteger(n) && n >= 1 && n <= 5); }

function isoOfUTC(year, month, day) {
  // `month` puede venir fuera de 0-11 (para sumar meses al buscar la
  // próxima ocurrencia) — Date.UTC lo normaliza solo (ej. mes 13 = febrero
  // del año siguiente).
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

// El n-ésimo (o último) día de la semana de un mes dado, como fecha ISO —
// o null si ese mes no llega a tener, por ejemplo, un 5to domingo.
function nthWeekdayOfMonthISO(year, month, weekday, nth) {
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  if (nth === 'last') {
    const lastWeekday = new Date(Date.UTC(year, month, daysInMonth)).getUTCDay();
    const diff = (lastWeekday - weekday + 7) % 7;
    return isoOfUTC(year, month, daysInMonth - diff);
  }
  const day = 1 + ((weekday - firstWeekday + 7) % 7) + (nth - 1) * 7;
  if (day > daysInMonth) return null;
  return isoOfUTC(year, month, day);
}

// Próxima fecha (ISO, desde `fromDateISO` inclusive) en que cae el patrón
// "n-ésimo día de la semana del mes" — busca hasta 24 meses adelante (de
// sobra: un patrón mensual normal cae todos los meses, esto solo protege
// contra el caso raro de un "5to domingo" que algunos meses no existe).
export function nextStructuredOccurrence(nth, weekday, fromDateISO) {
  const from = fromDateISO && /^\d{4}-\d{2}-\d{2}$/.test(fromDateISO) ? fromDateISO : todayISO();
  const [fy, fm] = from.split('-').map(Number);
  for (let i = 0; i < 24; i++) {
    const totalMonth = (fm - 1) + i;
    const year = fy + Math.floor(totalMonth / 12);
    const month = ((totalMonth % 12) + 12) % 12;
    const iso = nthWeekdayOfMonthISO(year, month, weekday, nth);
    if (iso && iso >= from) return iso;
  }
  return null;
}

function recurrenceLabel(a) {
  if (a.recurrenceType === 'structured' && a.structured) {
    return `${NTH_LABELS[a.structured.nth] || a.structured.nth} ${WEEKDAY_LABELS[a.structured.weekday] || ''} de cada mes`;
  }
  if (a.recurrenceType === 'once') return 'Fecha única';
  return 'Sin patrón fijo';
}

const todayISO = () => new Date().toISOString().slice(0, 10);

// Quién puede VER un acuerdo: el Obispado/Administrador ve todos (igual
// que con las actas — panorama completo); un líder común solo ve los
// acuerdos donde su propia organización es una de las involucradas.
function canSeeAgreement(user, agreement, data) {
  if (isObispadoLeader(user, data)) return true;
  return agreement.organizationIds.map(Number).includes(Number(user.organizationId));
}

// Quién puede EDITAR/archivar un acuerdo: a diferencia de un acta (donde
// solo quien la creó puede editarla), un acuerdo es un compromiso
// COMPARTIDO entre dos presidencias — cualquiera de las organizaciones
// involucradas debe poder ajustarlo o archivarlo, no solo quien lo escribió
// primero (si no, un cambio de líder en la otra organización dejaría el
// acuerdo "huérfano" y sin poder editarlo).
function canEditAgreement(user, agreement, data) {
  if (isObispadoLeader(user, data)) return true;
  return user.role === 'leader' && agreement.organizationIds.map(Number).includes(Number(user.organizationId));
}

function withAgreementInfo(a, data) {
  const orgs = a.organizationIds.map((id) => data.organizations.find((o) => o.id === Number(id))).filter(Boolean);
  const creator = data.users.find((u) => u.id === Number(a.createdBy));
  let nextOccurrence = null;
  let isPast = false;
  if (a.recurrenceType === 'structured' && a.structured) {
    nextOccurrence = nextStructuredOccurrence(a.structured.nth, a.structured.weekday, todayISO());
  } else if (a.recurrenceType === 'once') {
    nextOccurrence = a.onceDate;
    isPast = !!a.onceDate && a.onceDate < todayISO();
  }
  return {
    ...a,
    organizationNames: orgs.map((o) => o.name),
    organizationColors: orgs.map((o) => o.color),
    createdByName: creator?.name || '(usuario eliminado)',
    recurrenceLabel: recurrenceLabel(a),
    nextOccurrence,
    isPast,
  };
}

function validAgreementInput(body, data) {
  const title = String(body?.title || '').trim();
  if (!title) return { error: 'Falta el título del acuerdo' };
  const description = String(body?.description || '').trim();
  if (!description) return { error: 'Falta describir en qué consiste el acuerdo' };
  const organizationIds = Array.isArray(body?.organizationIds) ? [...new Set(body.organizationIds.map(Number))].filter(Number.isFinite) : [];
  if (organizationIds.length < 2) return { error: 'Un acuerdo necesita al menos dos organizaciones' };
  const validIds = new Set(data.organizations.map((o) => o.id));
  if (!organizationIds.every((id) => validIds.has(id))) return { error: 'Una de las organizaciones elegidas no existe' };

  const recurrenceType = body?.recurrenceType;
  if (!AGREEMENT_RECURRENCE_TYPES.includes(recurrenceType)) return { error: 'Falta indicar cómo se repite el acuerdo' };
  let structured = null;
  let onceDate = null;
  let freeformText = '';
  if (recurrenceType === 'structured') {
    const nthRaw = body?.structured?.nth;
    const nth = nthRaw === 'last' ? 'last' : Number(nthRaw);
    const weekday = Number(body?.structured?.weekday);
    if (!isValidNth(nth) || !isValidWeekday(weekday)) return { error: 'Falta elegir el patrón de repetición (ej. "4to domingo")' };
    structured = { nth, weekday };
  } else if (recurrenceType === 'once') {
    onceDate = String(body?.onceDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(onceDate)) return { error: 'Falta la fecha del acuerdo puntual' };
  } else if (recurrenceType === 'freeform') {
    freeformText = String(body?.freeformText || '').trim();
    if (!freeformText) return { error: 'Falta describir la repetición en texto libre' };
  }
  return { value: { title, description, organizationIds, recurrenceType, structured, onceDate, freeformText } };
}

export function registerAgreementRoutes(router) {
  router.get('/api/agreements', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res) => {
    const data = load();
    const visible = isObispadoLeader(req.user, data)
      ? data.interOrgAgreements
      : data.interOrgAgreements.filter((a) => a.organizationIds.map(Number).includes(Number(req.user.organizationId)));
    const items = visible
      .map((a) => withAgreementInfo(a, data))
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
        return (a.nextOccurrence || '9999-99-99').localeCompare(b.nextOccurrence || '9999-99-99');
      });
    sendJson(res, 200, items);
  }));

  router.get('/api/agreements/:id', requireRole(['admin', 'leader', 'ward_clerk'], async (req, res, params) => {
    const data = load();
    const agreement = data.interOrgAgreements.find((a) => a.id === Number(params.id));
    if (!agreement) return sendJson(res, 404, { error: 'Acuerdo no encontrado' });
    if (!canSeeAgreement(req.user, agreement, data)) return sendJson(res, 403, { error: 'No puedes ver este acuerdo' });
    sendJson(res, 200, withAgreementInfo(agreement, data));
  }));

  router.post('/api/agreements', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const data0 = load();
    const check = validAgreementInput(body, data0);
    if (check.error) return sendJson(res, 400, { error: check.error });
    // Un líder común solo puede crear acuerdos donde SU PROPIA organización
    // sea una de las involucradas (si no, cualquiera podría inventar un
    // acuerdo entre dos organizaciones ajenas). El Obispado/Administrador sí
    // puede armar uno entre cualquier par de organizaciones (ej. para dejar
    // por escrito algo que se acordó en un Consejo de Barrio).
    if (!isObispadoLeader(req.user, data0) && !check.value.organizationIds.includes(Number(req.user.organizationId))) {
      return sendJson(res, 403, { error: 'Solo puedes crear acuerdos donde participe tu propia organización' });
    }
    const now = new Date().toISOString();
    const agreement = await withDb((data) => {
      const a = {
        id: nextId(data, 'interOrgAgreements'),
        ...check.value,
        status: 'active',
        createdBy: req.user.id,
        createdAt: now,
        archivedAt: null,
      };
      data.interOrgAgreements.push(a);
      return a;
    });
    const data = load();
    sendJson(res, 201, withAgreementInfo(data.interOrgAgreements.find((a) => a.id === agreement.id), data));
  }));

  router.put('/api/agreements/:id', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    const agreement = data0.interOrgAgreements.find((a) => a.id === id);
    if (!agreement) return sendJson(res, 404, { error: 'Acuerdo no encontrado' });
    if (!canEditAgreement(req.user, agreement, data0)) return sendJson(res, 403, { error: 'Solo una de las organizaciones involucradas (o el Obispado) puede editar este acuerdo' });
    const check = validAgreementInput(body, data0);
    if (check.error) return sendJson(res, 400, { error: check.error });
    if (!isObispadoLeader(req.user, data0) && !check.value.organizationIds.includes(Number(req.user.organizationId))) {
      return sendJson(res, 403, { error: 'Tu propia organización debe seguir participando del acuerdo' });
    }
    await withDb((data) => {
      const a = data.interOrgAgreements.find((x) => x.id === id);
      Object.assign(a, check.value);
    });
    const data = load();
    sendJson(res, 200, withAgreementInfo(data.interOrgAgreements.find((a) => a.id === id), data));
  }));

  // Archivar / reactivar — igual patrón que las actas: nunca se borra de
  // verdad, para que quede el historial de qué se acordó y cuándo se dejó
  // de aplicar.
  router.put('/api/agreements/:id/archive', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    const agreement = data0.interOrgAgreements.find((a) => a.id === id);
    if (!agreement) return sendJson(res, 404, { error: 'Acuerdo no encontrado' });
    if (!canEditAgreement(req.user, agreement, data0)) return sendJson(res, 403, { error: 'Solo una de las organizaciones involucradas (o el Obispado) puede archivar este acuerdo' });
    const archive = body?.archive !== false;
    await withDb((data) => {
      const a = data.interOrgAgreements.find((x) => x.id === id);
      a.status = archive ? 'archived' : 'active';
      a.archivedAt = archive ? new Date().toISOString() : null;
    });
    const data = load();
    sendJson(res, 200, withAgreementInfo(data.interOrgAgreements.find((a) => a.id === id), data));
  }));
}
