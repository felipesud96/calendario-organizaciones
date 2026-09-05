import { sendJson } from '../router.js';
import { load, withDb, nextId } from '../db.js';
import { requireRole } from '../guard.js';
import { isObispadoLeader } from './stake.js';
import { findMeetingWithCommitment } from './meetings.js';

// Módulo "Bienestar" (Punto 51): registro de casos de ayuda temporal
// (alimento, vivienda, empleo, u otro) con un log de seguimiento — quién
// pidió/recibió ayuda, qué se acordó, y qué se hizo después, con fecha.
//
// Visibilidad: el usuario mismo pidió, en sus propias palabras, que esto
// quede MÁS restringido que cualquier otro módulo de la app — "Solo puede
// ver, el Obispado, El presidente del Cuorum y Presidenta de la Soc Soc".
// Esto es más angosto que "cualquier líder de esas organizaciones": debe
// ser específicamente quien preside cada una. Por eso NO se reutiliza
// ninguna noción de "pertenece a Obispado" (los tres llamamientos de apoyo
// — Secretario Ejecutivo, Secretario de Barrio, Secretario de Finanzas —
// tienen organizationId = Obispado pero role !== 'leader', así que ya
// quedan afuera de isObispadoLeader; y de los líderes de Obispado que no
// sean el Obispo igual se los deja entrar porque el Obispado siempre actúa
// como cuerpo colegiado en la app — ver isObispadoLeader en stake.js).
export const WELFARE_COMMITTEE_ORGS = ['Cuórum de Élderes', 'Sociedad de Socorro'];

export function isWelfareCommitteeMember(user, data) {
  if (isObispadoLeader(user, data)) return true;
  if (user.role !== 'leader' || !user.isPresident) return false;
  const org = data.organizations.find((o) => o.id === Number(user.organizationId));
  return !!org && WELFARE_COMMITTEE_ORGS.includes(org.name);
}

export const WELFARE_CATEGORIES = ['alimento', 'vivienda', 'empleo', 'otro'];
export const WELFARE_STATUSES = ['abierto', 'en_seguimiento', 'cerrado'];

function withCaseInfo(c, data) {
  return { ...c, actions: [...(c.actions || [])].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id) };
}

// ---------------- Otorgar ayuda + evaluación mensual (Punto pedido) ----------------
// Flujo descrito por el usuario: se habla con la persona (informal o
// entrevista), llena el formulario oficial de autosuficiencia de la
// Iglesia (se adjunta como foto/PDF — ver self-reliance-form más abajo), se
// analiza en conjunto y se extiende la ayuda (única vez o por un período de
// varios meses). Después, según el plazo, se hace una verificación mensual:
// "la persona que extiende la ayuda tiene el compromiso de evaluar cómo
// sigue esa persona, y si se debe extender la ayuda o se da por
// solucionado". Se implementa igual que el compromiso trimestral automático
// de Enfoque Ministración (ver checkQuarterEndMinisteringFocusCommitments
// en reminders.js): un acta ad-hoc de un solo compromiso, creada por el
// propio responsable, que aparece en "Mis Asignaciones" y en Reuniones y
// Consejos — pero SIN mencionar a la persona ayudada en la descripción (ni
// el acta ni el compromiso identifican al miembro), para no exponer un dato
// confidencial de Bienestar fuera de este módulo. Se marca `confidential`
// para que, aunque alguien más de la misma organización vea que el acta
// existe, no pueda leer su contenido — solo el propio responsable o el
// Obispado.
export const WELFARE_AID_TYPES = ['unica_vez', 'periodo'];
// Cadencia de evaluación pedida explícitamente: "si se ayudó una vez, que
// se evalúe en 1 mes... y si son más meses, cada mes se debe evaluar" — es
// decir, siempre 1 mes entre evaluaciones, sin importar el tipo de ayuda.
const WELFARE_REVIEW_INTERVAL_MONTHS = 1;

const todayISO = () => new Date().toISOString().slice(0, 10);
function addMonthsISO(fromDateStr, months) {
  const d = new Date(`${fromDateStr}T00:00:00`);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

// Crea el acta ad-hoc + su único compromiso (dentro de una transacción
// withDb ya abierta, recibiendo `data` mutable) y devuelve el compromiso ya
// creado, para que el caller le guarde el id en `reviewCommitmentId`.
function createWelfareReviewCommitment(data, welfareCase, assignee, dueDate) {
  const commitment = {
    id: nextId(data, 'commitments'),
    description: `Evaluar seguimiento de un caso de Bienestar (categoría: ${WELFARE_CATEGORY_LABEL_ES(welfareCase.category)}) — ¿se extiende la ayuda o se da por solucionado? Ver el caso en el módulo de Bienestar.`,
    dueDate,
    assignedToUserId: assignee.id,
    confidential: true,
    status: 'pending',
    completedAt: null,
    completionComment: '',
    whatsappDueTodaySent: false,
  };
  data.meetings.push({
    id: nextId(data, 'meetings'),
    title: 'Seguimiento de Bienestar',
    date: todayISO(),
    type: 'general',
    confidential: true,
    organizationId: assignee.organizationId || null,
    status: 'active',
    createdBy: assignee.id,
    createdAt: new Date().toISOString(),
    archivedAt: null,
    agendaItems: [],
    commitments: [commitment],
    councilPrepReminderSent: false,
  });
  return commitment;
}
function WELFARE_CATEGORY_LABEL_ES(cat) {
  return { alimento: 'alimento', vivienda: 'vivienda', empleo: 'empleo', otro: 'otro' }[cat] || cat;
}

export function registerWelfareRoutes(router) {
  // La capa exterior solo exige estar autenticado como admin/leader (igual
  // que el resto de los módulos "solo Obispado"); el filtro fino de
  // isWelfareCommitteeMember es el que de verdad decide quién entra —
  // cualquier otro líder o el Administrador reciben 403, no un listado
  // vacío, para que quede claro que el módulo existe pero no es para ellos.
  router.get('/api/welfare-cases', requireRole(['admin', 'leader'], async (req, res) => {
    const data = load();
    if (!isWelfareCommitteeMember(req.user, data)) {
      return sendJson(res, 403, { error: 'El módulo de Bienestar es solo para el Obispado, el presidente de Cuórum de Élderes y la presidenta de Sociedad de Socorro' });
    }
    const { status } = req.query;
    let items = data.welfareCases;
    if (status) items = items.filter((c) => c.status === status);
    items = items.map((c) => withCaseInfo(c, data)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    sendJson(res, 200, items);
  }));

  router.get('/api/welfare-cases/:id', requireRole(['admin', 'leader'], async (req, res, params) => {
    const data = load();
    if (!isWelfareCommitteeMember(req.user, data)) {
      return sendJson(res, 403, { error: 'El módulo de Bienestar es solo para el Obispado, el presidente de Cuórum de Élderes y la presidenta de Sociedad de Socorro' });
    }
    const c = data.welfareCases.find((x) => x.id === Number(params.id));
    if (!c) return sendJson(res, 404, { error: 'Caso no encontrado' });
    sendJson(res, 200, withCaseInfo(c, data));
  }));

  router.post('/api/welfare-cases', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const data0 = load();
    if (!isWelfareCommitteeMember(req.user, data0)) {
      return sendJson(res, 403, { error: 'El módulo de Bienestar es solo para el Obispado, el presidente de Cuórum de Élderes y la presidenta de Sociedad de Socorro' });
    }
    const memberName = String(body?.memberName || '').trim();
    if (!memberName) return sendJson(res, 400, { error: 'Falta el nombre de la persona o familia' });
    const category = WELFARE_CATEGORIES.includes(body?.category) ? body.category : 'otro';
    const description = String(body?.description || '').trim();
    const rawMemberUserId = body?.memberUserId;
    const now = new Date().toISOString();
    const created = await withDb((data) => {
      const memberUserId = (rawMemberUserId !== undefined && rawMemberUserId !== null && rawMemberUserId !== '')
        ? (data.users.some((u) => u.id === Number(rawMemberUserId)) ? Number(rawMemberUserId) : null)
        : null;
      const c = {
        id: nextId(data, 'welfareCases'),
        memberName,
        memberUserId,
        category,
        description,
        status: 'abierto',
        actions: [],
        createdBy: req.user.id,
        createdAt: now,
        updatedAt: now,
        // Flujo de ayuda y evaluación (ver más abajo, grant-aid/review):
        // vacío hasta que se otorgue una ayuda formal a este caso.
        aidType: null,
        aidMonths: null,
        aidGrantedAt: null,
        selfRelianceForm: null,
        reviewCommitmentId: null,
        nextReviewDate: null,
        reviews: [],
        closedAt: null,
      };
      data.welfareCases.push(c);
      return c;
    });
    const data = load();
    sendJson(res, 201, withCaseInfo(data.welfareCases.find((c) => c.id === created.id), data));
  }));

  router.put('/api/welfare-cases/:id', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    if (!isWelfareCommitteeMember(req.user, data0)) {
      return sendJson(res, 403, { error: 'El módulo de Bienestar es solo para el Obispado, el presidente de Cuórum de Élderes y la presidenta de Sociedad de Socorro' });
    }
    const existing = data0.welfareCases.find((c) => c.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Caso no encontrado' });
    const memberName = body?.memberName !== undefined ? String(body.memberName).trim() : existing.memberName;
    if (!memberName) return sendJson(res, 400, { error: 'Falta el nombre de la persona o familia' });
    const category = body?.category !== undefined
      ? (WELFARE_CATEGORIES.includes(body.category) ? body.category : existing.category)
      : existing.category;
    const description = body?.description !== undefined ? String(body.description).trim() : existing.description;
    const status = body?.status !== undefined
      ? (WELFARE_STATUSES.includes(body.status) ? body.status : existing.status)
      : existing.status;
    const updated = await withDb((data) => {
      const c = data.welfareCases.find((x) => x.id === id);
      Object.assign(c, { memberName, category, description, status, updatedAt: new Date().toISOString() });
      return c;
    });
    const data = load();
    sendJson(res, 200, withCaseInfo(data.welfareCases.find((c) => c.id === updated.id), data));
  }));

  // Agrega una entrada al log de seguimiento del caso (Manual General 22:
  // el comité de bienestar revisa y da seguimiento a cada caso a lo largo
  // del tiempo, no solo lo abre y lo olvida).
  router.post('/api/welfare-cases/:id/actions', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    if (!isWelfareCommitteeMember(req.user, data0)) {
      return sendJson(res, 403, { error: 'El módulo de Bienestar es solo para el Obispado, el presidente de Cuórum de Élderes y la presidenta de Sociedad de Socorro' });
    }
    if (!data0.welfareCases.some((c) => c.id === id)) return sendJson(res, 404, { error: 'Caso no encontrado' });
    const note = String(body?.note || '').trim();
    if (!note) return sendJson(res, 400, { error: 'Falta la descripción de la acción de seguimiento' });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body?.date) ? body.date : new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    await withDb((data) => {
      const c = data.welfareCases.find((x) => x.id === id);
      c.actions.push({
        id: nextId(data, 'welfareActions'),
        date,
        note,
        createdBy: req.user.id,
        createdAt: now,
      });
      c.updatedAt = now;
    });
    const data = load();
    sendJson(res, 200, withCaseInfo(data.welfareCases.find((c) => c.id === id), data));
  }));

  router.delete('/api/welfare-cases/:id', requireRole(['admin', 'leader'], async (req, res, params) => {
    const id = Number(params.id);
    const data0 = load();
    if (!isWelfareCommitteeMember(req.user, data0)) {
      return sendJson(res, 403, { error: 'El módulo de Bienestar es solo para el Obispado, el presidente de Cuórum de Élderes y la presidenta de Sociedad de Socorro' });
    }
    if (!data0.welfareCases.some((c) => c.id === id)) return sendJson(res, 404, { error: 'Caso no encontrado' });
    await withDb((data) => { data.welfareCases = data.welfareCases.filter((c) => c.id !== id); });
    sendJson(res, 200, { ok: true });
  }));

  // Adjunta (o reemplaza) la foto/PDF del formulario oficial de
  // autosuficiencia ya llenado por la persona — pedido explícito: "un
  // formulario oficial de la iglesia, pero ellos deben llenarlo, deja la
  // opción para adjuntarlo como foto o pdf". No se modela ningún campo del
  // formulario en la app: solo se guarda el archivo, igual que la foto de
  // perfil se guarda como data URI embebida en la propia base de datos (sin
  // depender de ningún almacenamiento externo). Multipart, igual patrón que
  // ya usa /api/ward-growth/parse-pdf (ver server.js).
  const SELF_RELIANCE_FORM_MAX_BYTES = 8 * 1024 * 1024; // 8MB: de sobra para una foto o un PDF de una hoja
  router.post('/api/welfare-cases/:id/self-reliance-form', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    if (!isWelfareCommitteeMember(req.user, data0)) {
      return sendJson(res, 403, { error: 'El módulo de Bienestar es solo para el Obispado, el presidente de Cuórum de Élderes y la presidenta de Sociedad de Socorro' });
    }
    if (!data0.welfareCases.some((c) => c.id === id)) return sendJson(res, 404, { error: 'Caso no encontrado' });
    const file = (body?.files || []).find((f) => f.field === 'form') || (body?.files || [])[0];
    if (!file || !file.data || !file.data.length) {
      return sendJson(res, 400, { error: 'Adjunta una foto o un PDF del formulario' });
    }
    if (file.data.length > SELF_RELIANCE_FORM_MAX_BYTES) {
      return sendJson(res, 400, { error: 'El archivo es demasiado grande (máximo 8MB)' });
    }
    const mime = file.contentType || 'application/octet-stream';
    if (!mime.startsWith('image/') && mime !== 'application/pdf') {
      return sendJson(res, 400, { error: 'Solo se acepta una imagen (foto) o un PDF' });
    }
    const now = new Date().toISOString();
    await withDb((data) => {
      const c = data.welfareCases.find((x) => x.id === id);
      c.selfRelianceForm = {
        dataUri: `data:${mime};base64,${file.data.toString('base64')}`,
        filename: file.filename || 'formulario',
        mime,
        uploadedAt: now,
        uploadedByName: req.user.name,
      };
      c.updatedAt = now;
    });
    const data = load();
    sendJson(res, 200, withCaseInfo(data.welfareCases.find((c) => c.id === id), data));
  }));

  router.delete('/api/welfare-cases/:id/self-reliance-form', requireRole(['admin', 'leader'], async (req, res, params) => {
    const id = Number(params.id);
    const data0 = load();
    if (!isWelfareCommitteeMember(req.user, data0)) {
      return sendJson(res, 403, { error: 'El módulo de Bienestar es solo para el Obispado, el presidente de Cuórum de Élderes y la presidenta de Sociedad de Socorro' });
    }
    if (!data0.welfareCases.some((c) => c.id === id)) return sendJson(res, 404, { error: 'Caso no encontrado' });
    await withDb((data) => {
      const c = data.welfareCases.find((x) => x.id === id);
      c.selfRelianceForm = null;
      c.updatedAt = new Date().toISOString();
    });
    const data = load();
    sendJson(res, 200, withCaseInfo(data.welfareCases.find((c) => c.id === id), data));
  }));

  // Otorga la ayuda (única vez o por un período) y crea automáticamente el
  // primer compromiso de evaluación mensual — asignado a quien registró el
  // caso (decisión confirmada: "quien registra el caso en la app" es el
  // responsable de la evaluación recurrente, sin un campo nuevo de
  // "asignar revisor").
  router.post('/api/welfare-cases/:id/grant-aid', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    if (!isWelfareCommitteeMember(req.user, data0)) {
      return sendJson(res, 403, { error: 'El módulo de Bienestar es solo para el Obispado, el presidente de Cuórum de Élderes y la presidenta de Sociedad de Socorro' });
    }
    const existing = data0.welfareCases.find((c) => c.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Caso no encontrado' });
    if (existing.reviewCommitmentId && existing.status !== 'cerrado') {
      return sendJson(res, 400, { error: 'Este caso ya tiene una ayuda en seguimiento — registra la evaluación pendiente antes de otorgar una nueva' });
    }
    const aidType = WELFARE_AID_TYPES.includes(body?.aidType) ? body.aidType : null;
    if (!aidType) return sendJson(res, 400, { error: 'Indica si la ayuda es por única vez o por un período' });
    let aidMonths = null;
    if (aidType === 'periodo') {
      aidMonths = Number(body?.aidMonths);
      if (!Number.isInteger(aidMonths) || aidMonths < 1) {
        return sendJson(res, 400, { error: 'Indica por cuántos meses se extiende la ayuda' });
      }
    }
    const responsible = data0.users.find((u) => u.id === Number(existing.createdBy));
    if (!responsible) {
      return sendJson(res, 400, { error: 'Quien registró este caso ya no existe como usuario — no se puede crear el compromiso de evaluación automático' });
    }
    const nextReviewDate = addMonthsISO(todayISO(), WELFARE_REVIEW_INTERVAL_MONTHS);
    const now = new Date().toISOString();
    const updated = await withDb((data) => {
      const c = data.welfareCases.find((x) => x.id === id);
      const assignee = data.users.find((u) => u.id === responsible.id);
      const commitment = createWelfareReviewCommitment(data, c, assignee, nextReviewDate);
      Object.assign(c, {
        aidType,
        aidMonths,
        aidGrantedAt: now,
        status: 'en_seguimiento',
        reviewCommitmentId: commitment.id,
        nextReviewDate,
        updatedAt: now,
      });
      c.actions.push({
        id: nextId(data, 'welfareActions'),
        date: todayISO(),
        note: `🤝 Se otorgó ayuda (${aidType === 'unica_vez' ? 'única vez' : `por ${aidMonths} mes${aidMonths === 1 ? '' : 'es'}`}). Próxima evaluación: ${nextReviewDate}.`,
        createdBy: req.user.id,
        createdAt: now,
      });
      return c;
    });
    const data = load();
    sendJson(res, 200, withCaseInfo(data.welfareCases.find((c) => c.id === updated.id), data));
  }));

  // Registra la evaluación mensual: la persona responsable (quien registró
  // el caso) decide si se extiende la ayuda un mes más (se crea el próximo
  // compromiso automáticamente) o si el caso se da por solucionado (se
  // cierra). Mismo criterio de "solo el responsable puede completar su
  // propio compromiso" que ya usa /api/commitments/:id/complete — más
  // Administrador, que siempre puede intervenir en cualquier módulo.
  router.post('/api/welfare-cases/:id/review', requireRole(['admin', 'leader'], async (req, res, params, body) => {
    const id = Number(params.id);
    const data0 = load();
    if (!isWelfareCommitteeMember(req.user, data0)) {
      return sendJson(res, 403, { error: 'El módulo de Bienestar es solo para el Obispado, el presidente de Cuórum de Élderes y la presidenta de Sociedad de Socorro' });
    }
    const existing = data0.welfareCases.find((c) => c.id === id);
    if (!existing) return sendJson(res, 404, { error: 'Caso no encontrado' });
    if (!existing.reviewCommitmentId) return sendJson(res, 400, { error: 'Este caso no tiene una evaluación pendiente' });
    const found = findMeetingWithCommitment(data0, existing.reviewCommitmentId);
    if (!found) return sendJson(res, 400, { error: 'No se encontró el compromiso de evaluación de este caso' });
    if (req.user.role !== 'admin' && Number(found.commitment.assignedToUserId) !== Number(req.user.id)) {
      return sendJson(res, 403, { error: 'Solo la persona responsable de este caso puede registrar su evaluación mensual' });
    }
    const decision = ['extender', 'solucionado'].includes(body?.decision) ? body.decision : null;
    if (!decision) return sendJson(res, 400, { error: 'Indica si se extiende la ayuda o el caso se da por solucionado' });
    const notes = String(body?.notes || '').trim();
    const now = new Date().toISOString();
    const updated = await withDb((data) => {
      const c = data.welfareCases.find((x) => x.id === id);
      const f = findMeetingWithCommitment(data, c.reviewCommitmentId);
      if (f && f.commitment.status === 'pending') {
        Object.assign(f.commitment, {
          status: 'completed',
          completedAt: now,
          completionComment: notes || (decision === 'extender' ? 'Se extiende la ayuda' : 'Caso solucionado'),
        });
      }
      c.reviews = c.reviews || [];
      c.reviews.push({ id: nextId(data, 'welfareActions'), date: todayISO(), decision, notes, byUserId: req.user.id, byName: req.user.name, createdAt: now });
      let noteText;
      if (decision === 'extender') {
        const assignee = data.users.find((u) => u.id === Number(c.createdBy)) || req.user;
        const nextReviewDate = addMonthsISO(todayISO(), WELFARE_REVIEW_INTERVAL_MONTHS);
        const commitment = createWelfareReviewCommitment(data, c, assignee, nextReviewDate);
        c.reviewCommitmentId = commitment.id;
        c.nextReviewDate = nextReviewDate;
        c.status = 'en_seguimiento';
        noteText = `📋 Evaluación: se extiende la ayuda un mes más. Próxima evaluación: ${nextReviewDate}.${notes ? ' — ' + notes : ''}`;
      } else {
        c.status = 'cerrado';
        c.closedAt = now;
        c.reviewCommitmentId = null;
        c.nextReviewDate = null;
        noteText = `✅ Evaluación: caso dado por solucionado.${notes ? ' — ' + notes : ''}`;
      }
      c.actions.push({ id: nextId(data, 'welfareActions'), date: todayISO(), note: noteText, createdBy: req.user.id, createdAt: now });
      c.updatedAt = now;
      return c;
    });
    const data = load();
    sendJson(res, 200, withCaseInfo(data.welfareCases.find((c) => c.id === updated.id), data));
  }));
}
