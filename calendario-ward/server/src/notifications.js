// Construcción y envío de los correos relacionados a entrevistas: el
// recordatorio 24 horas antes, el aviso de cancelación, y el aviso de
// cambio de fecha/horario. Los tres se envían a los DOS participantes: el
// líder que realiza la entrevista y el miembro que asiste (a cada uno se
// le envía si su email está cargado en la entrevista).

import { sendEmail, isEmailConfigured } from './email.js';
import { sendUserWhatsApp } from './whatsapp.js';
import { sendUserPush } from './webpush.js';

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Punto 40 — preferencias de notificación por tipo: cada usuario puede
// apagar un tipo de aviso desde "Mi Perfil" (notificationPrefs: { interviews,
// commitments, councilPrep, dailyDigest, push }). Si el campo no existe
// (cuenta vieja, nunca tocó esa preferencia) se considera ACTIVADO por
// defecto — así nadie deja de recibir algo que ya recibía sin haberlo
// decidido. `user` puede ser null/undefined (ej: un email suelto que no
// corresponde a ninguna cuenta) — en ese caso no hay preferencia que
// respetar, así que se manda igual.
export function notifEnabled(user, type) {
  if (!user || !user.notificationPrefs) return true;
  return user.notificationPrefs[type] !== false;
}

// Punto 39: el push tiene, además de la preferencia por TIPO de arriba
// (interviews/commitments/etc.), un interruptor MAESTRO propio ('push') —
// hay que pasar los dos filtros para que le llegue un push de un tipo dado:
// que ese tipo no esté apagado, Y que no haya apagado el push en general
// (por ejemplo, alguien que solo quiere sus recordatorios por WhatsApp).
export function pushEnabledFor(user, type) {
  return notifEnabled(user, type) && notifEnabled(user, 'push');
}

// Devuelve la lista de destinatarios (líder y/o miembro) que tengan email
// cargado, salvo los que estén en `skipEmails` (Punto 40: la persona
// desactivó ese tipo de aviso desde su cuenta — ver notifEnabled arriba).
// El entrevistador es un campo de texto libre, no siempre ligado a una
// cuenta real, así que su copia no se puede filtrar por preferencia: solo
// se excluye por email explícito cuando SÍ hay una cuenta detrás (ver
// checkAndSendReminders en reminders.js).
function recipients(iv, skipEmails = new Set()) {
  const list = [];
  if (iv.interviewerEmail && !skipEmails.has(iv.interviewerEmail)) list.push({ email: iv.interviewerEmail, label: iv.interviewerName || 'líder' });
  if (iv.memberEmail && !skipEmails.has(iv.memberEmail)) list.push({ email: iv.memberEmail, label: iv.memberName || 'miembro' });
  return list;
}

function detailRows(iv) {
  return [
    `<li><strong>Miembro:</strong> ${escHtml(iv.memberName)}</li>`,
    iv.interviewerName ? `<li><strong>Líder:</strong> ${escHtml(iv.interviewerName)}</li>` : '',
    `<li><strong>Fecha:</strong> ${escHtml(iv.date)}</li>`,
    `<li><strong>Hora:</strong> ${escHtml(iv.startTime)}${iv.endTime ? ' - ' + escHtml(iv.endTime) : ''}</li>`,
    iv.location ? `<li><strong>Lugar:</strong> ${escHtml(iv.location)}</li>` : '',
    iv.description ? `<li><strong>Detalle:</strong> ${escHtml(iv.description)}</li>` : '',
  ].filter(Boolean).join('');
}

async function sendToParticipants(iv, subject, buildHtml, skipEmails = new Set()) {
  if (!isEmailConfigured()) return;
  for (const r of recipients(iv, skipEmails)) {
    try {
      await sendEmail({ to: r.email, subject, html: buildHtml(r) });
      console.log(`[notificaciones] "${subject}" enviado a ${r.email}`);
    } catch (err) {
      console.error(`[notificaciones] error enviando "${subject}" a ${r.email}:`, err.message);
    }
  }
}

export async function sendReminderEmail(iv, skipEmails = new Set()) {
  await sendToParticipants(
    iv,
    `Recordatorio: entrevista con ${iv.memberName} mañana`,
    (r) => `<p>Hola ${escHtml(r.label)},</p>
<p>Este es un recordatorio: tienes una entrevista agendada para <strong>mañana</strong> en OrganizaSion.</p>
<ul>${detailRows(iv)}</ul>
<p>— OrganizaSion</p>`,
    skipEmails
  );
}

export async function sendCancellationEmail(iv) {
  await sendToParticipants(
    iv,
    `Entrevista cancelada: ${iv.memberName}`,
    (r) => `<p>Hola ${escHtml(r.label)},</p>
<p>Te informamos que la siguiente entrevista fue <strong>cancelada</strong>:</p>
<ul>${detailRows(iv)}</ul>
<p>— OrganizaSion</p>`
  );
}

export async function sendRescheduleEmail(iv, previous) {
  await sendToParticipants(
    iv,
    `Entrevista reprogramada: ${iv.memberName}`,
    (r) => `<p>Hola ${escHtml(r.label)},</p>
<p>La siguiente entrevista cambió de fecha/horario:</p>
<ul>
  <li><strong>Antes:</strong> ${escHtml(previous.date)} a las ${escHtml(previous.startTime)}</li>
  <li><strong>Ahora:</strong> ${escHtml(iv.date)} a las ${escHtml(iv.startTime)}${iv.endTime ? ' - ' + escHtml(iv.endTime) : ''}</li>
  ${iv.location ? `<li><strong>Lugar:</strong> ${escHtml(iv.location)}</li>` : ''}
  ${iv.description ? `<li><strong>Detalle:</strong> ${escHtml(iv.description)}</li>` : ''}
</ul>
<p>— OrganizaSion</p>`
  );
}

// Recordatorio de un compromiso (acta de Reuniones y Consejos) que vence
// mañana — se manda al email de la cuenta de quien es responsable, igual
// que el resto de los correos automáticos: si esa persona no tiene un email
// real cargado (recuerda que el "usuario" de ingreso no siempre es un
// correo de verdad), simplemente no le llega, sin error para nadie.
export async function sendCommitmentDueSoonEmail(commitment, assigneeEmail, assigneeName, meetingTitle) {
  if (!isEmailConfigured() || !assigneeEmail) return;
  try {
    await sendEmail({
      to: assigneeEmail,
      subject: `Recordatorio: compromiso que vence mañana`,
      html: `<p>Hola ${escHtml(assigneeName)},</p>
<p>Este es un recordatorio: tienes un compromiso que vence <strong>mañana</strong>, del acta "${escHtml(meetingTitle)}":</p>
<ul><li>${escHtml(commitment.description)}</li></ul>
<p>Puedes marcarlo como completado desde OrganizaSion → Reuniones y Consejos → Mis Asignaciones.</p>
<p>— OrganizaSion</p>`,
    });
    console.log(`[notificaciones] recordatorio de compromiso enviado a ${assigneeEmail}`);
  } catch (err) {
    console.error(`[notificaciones] error enviando recordatorio de compromiso a ${assigneeEmail}:`, err.message);
  }
}

// Punto 18 (idea de UX basada en el Manual General): antes de la próxima
// reunión de un consejo (Consejo de Barrio / Coordinación de Ministración),
// avisa a quienes preparan la agenda qué compromisos del consejo ANTERIOR
// siguen sin resolverse — así el consejo puede empezar revisando el
// seguimiento, como pide el patrón de consejo del Manual, en vez de que se
// pierdan de una reunión a la siguiente.
export async function sendCouncilPrepEmail(toEmail, toName, meeting, pendingCommitments) {
  if (!isEmailConfigured() || !toEmail || !pendingCommitments.length) return;
  try {
    await sendEmail({
      to: toEmail,
      subject: `Antes de "${meeting.title}": compromisos pendientes del consejo anterior`,
      html: `<p>Hola ${escHtml(toName)},</p>
<p>El próximo <strong>${escHtml(meeting.title)}</strong> es el <strong>${escHtml(meeting.date)}</strong>. Del consejo anterior quedaron estos compromisos sin resolver — puede ser buen inicio de agenda revisar su seguimiento:</p>
<ul>${pendingCommitments.map((c) => `<li>${escHtml(c.description)} — responsable: ${escHtml(c.assignedToName)}${c.dueDate ? `, vencía el ${escHtml(c.dueDate)}` : ''}</li>`).join('')}</ul>
<p>— OrganizaSion</p>`,
    });
    console.log(`[notificaciones] recordatorio de preparación de consejo enviado a ${toEmail}`);
  } catch (err) {
    console.error(`[notificaciones] error enviando recordatorio de preparación de consejo a ${toEmail}:`, err.message);
  }
}

// ------------------------------------------------------------------
// Notificaciones por WhatsApp (CallMeBot) — ver whatsapp.js.
//
// A diferencia del correo (que se manda al email suelto que se haya escrito
// en la propia entrevista/compromiso, sea o no de una cuenta registrada),
// el WhatsApp SOLO puede llegarle a una CUENTA de la app que ya activó su
// clave de CallMeBot en "Mi Perfil" — por eso estas funciones reciben
// directamente el objeto `user` (o null si esa entrevista/compromiso no
// está vinculado a ninguna cuenta), y sendUserWhatsApp() ya se encarga de
// no hacer nada si esa cuenta no tiene WhatsApp configurado.
//
// Alcance: por ahora solo al MIEMBRO de la entrevista (memberUserId) y al
// RESPONSABLE del compromiso (assignedToUserId) — el entrevistador queda
// afuera porque hoy es un campo de texto libre, sin vincularlo a una cuenta
// registrada (a diferencia del miembro, que si se busca con el
// autocompletado sí queda vinculado).
// ------------------------------------------------------------------

function interviewLine(iv) {
  return `📅 ${iv.date} a las ${iv.startTime}${iv.endTime ? '-' + iv.endTime : ''}${iv.location ? ' · ' + iv.location : ''}${iv.interviewerName ? ' · con ' + iv.interviewerName : ''}`;
}

export async function sendInterviewScheduledWhatsApp(iv, memberUser) {
  await sendUserWhatsApp(memberUser, `✅ Se agendó tu entrevista en OrganizaSion.\n${interviewLine(iv)}`, 'entrevista agendada');
}

export async function sendInterviewTodayWhatsApp(iv, memberUser) {
  await sendUserWhatsApp(memberUser, `⏰ Recordatorio: hoy tienes una entrevista en OrganizaSion.\n${interviewLine(iv)}`, 'recordatorio de entrevista hoy');
}

export async function sendInterviewCancelledWhatsApp(iv, memberUser) {
  await sendUserWhatsApp(memberUser, `❌ Se canceló tu entrevista en OrganizaSion.\n${interviewLine(iv)}`, 'entrevista cancelada');
}

export async function sendInterviewRescheduledWhatsApp(iv, memberUser, previous) {
  await sendUserWhatsApp(memberUser, `🔄 Tu entrevista en OrganizaSion cambió de fecha/hora.\nAntes: ${previous.date} a las ${previous.startTime}\nAhora: ${interviewLine(iv)}`, 'entrevista reprogramada');
}

export async function sendCommitmentDueTodayWhatsApp(commitment, user, meetingTitle) {
  await sendUserWhatsApp(user, `🎯 Recordatorio: tu compromiso vence HOY en OrganizaSion.\n"${commitment.description}" (acta: ${meetingTitle})`, 'compromiso vence hoy');
}

// Nace de una pregunta directa: cuando ya existía una actividad en un día, y
// otra organización agenda encima (choque de horario y/o lugar), hasta ahora
// SOLO se avisaba a quien la agendaba en segundo lugar (el aviso "suave" del
// calendario, que igual la deja guardar) — quien la había puesto primero
// nunca se enteraba. Este WhatsApp es inmediato (no espera al recordatorio
// por cron) y le llega al DUEÑO de la actividad más antigua apenas se guarda
// la que choca con ella.
export async function sendEventConflictWhatsApp(originalEvent, newEvent, orgName, originalOwner) {
  await sendUserWhatsApp(
    originalOwner,
    `⚠️ Choque de horario en OrganizaSion.\nTu actividad "${originalEvent.title}" del ${originalEvent.date} a las ${originalEvent.startTime} ahora se cruza con una actividad nueva de ${orgName}: "${newEvent.title}" (${newEvent.date} a las ${newEvent.startTime}).\nRevísalo en OrganizaSion → Mis Actividades.`,
    'choque de horario con actividad nueva'
  );
}

// ------------------------------------------------------------------
// Punto 39 — Notificaciones push del navegador (ver webpush.js). Mismo
// espíritu que las de WhatsApp de arriba: reciben directamente el `user`
// (una notificación push SOLO puede llegarle a una cuenta que ya se
// suscribió desde su propio navegador — no hay campo de texto libre
// posible como con el email/entrevistador) y nunca lanzan hacia arriba.
// Cada llamada debe ir siempre detrás de un chequeo de pushEnabledFor(user,
// tipo) en el punto donde se dispara — igual criterio que ya se usa para
// gatear canSendWhatsApp/notifEnabled antes de las de WhatsApp.
// ------------------------------------------------------------------

export async function sendInterviewReminderPush(iv, memberUser) {
  await sendUserPush(memberUser, {
    title: '⏰ Entrevista mañana',
    body: `${iv.date} a las ${iv.startTime}${iv.location ? ' · ' + iv.location : ''}`,
  });
}

export async function sendInterviewTodayPush(iv, memberUser) {
  await sendUserPush(memberUser, {
    title: '⏰ Hoy tienes una entrevista',
    body: `${iv.startTime}${iv.endTime ? '-' + iv.endTime : ''}${iv.location ? ' · ' + iv.location : ''}${iv.interviewerName ? ' · con ' + iv.interviewerName : ''}`,
  });
}

export async function sendCommitmentDueTodayPush(commitment, user, meetingTitle) {
  await sendUserPush(user, {
    title: '🎯 Compromiso vence hoy',
    body: `${commitment.description} (acta: ${meetingTitle})`,
  });
}

export async function sendEventConflictPush(originalEvent, newEvent, orgName, originalOwner) {
  await sendUserPush(originalOwner, {
    title: '⚠️ Choque de horario',
    body: `"${originalEvent.title}" (${originalEvent.date}) ahora se cruza con una actividad nueva de ${orgName}.`,
  });
}

// Resumen diario para el Obispado (y el Administrador): un solo correo cada
// mañana con lo que corresponde hoy — así no hace falta entrar a la app
// todos los días solo para confirmar que no se olvida nada. Reutiliza la
// idea de "Panel de Obispado" pero acotada a HOY (no a los próximos 7 días).
export async function sendDailyDigestEmail(toEmail, toName, digest) {
  if (!isEmailConfigured() || !toEmail) return;
  const { cleaningToday, interviewsToday, activitiesToday, commitmentsDueToday } = digest;
  if (!cleaningToday.length && !interviewsToday.length && !activitiesToday.length && !commitmentsDueToday.length) return;
  const section = (title, items, render) => items.length
    ? `<p><strong>${escHtml(title)}</strong></p><ul>${items.map(render).join('')}</ul>`
    : '';
  try {
    await sendEmail({
      to: toEmail,
      subject: `Resumen de hoy en OrganizaSion`,
      html: `<p>Hola ${escHtml(toName)},</p>
<p>Esto es lo que corresponde hoy en el Barrio:</p>
${section('🧹 Turnos de aseo', cleaningToday, (s) => `<li>${escHtml(s.familyName)}</li>`)}
${section('👤 Entrevistas', interviewsToday, (iv) => `<li>${escHtml(iv.memberName)} — ${escHtml(iv.startTime)}${iv.organizationName ? ' · ' + escHtml(iv.organizationName) : ''}</li>`)}
${section('📅 Actividades', activitiesToday, (e) => `<li>${escHtml(e.title)} — ${escHtml(e.startTime)}${e.organizationName ? ' · ' + escHtml(e.organizationName) : ''}</li>`)}
${section('🎯 Compromisos que vencen hoy', commitmentsDueToday, (c) => `<li>${escHtml(c.description)} — responsable: ${escHtml(c.assignedToName)}</li>`)}
<p>— OrganizaSion</p>`,
    });
    console.log(`[notificaciones] resumen diario enviado a ${toEmail}`);
  } catch (err) {
    console.error(`[notificaciones] error enviando resumen diario a ${toEmail}:`, err.message);
  }
}
