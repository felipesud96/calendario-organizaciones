// Construcción y envío de los correos relacionados a entrevistas: el
// recordatorio 24 horas antes, el aviso de cancelación, y el aviso de
// cambio de fecha/horario. Los tres se envían a los DOS participantes: el
// líder que realiza la entrevista y el miembro que asiste (a cada uno se
// le envía si su email está cargado en la entrevista).

import { sendEmail, isEmailConfigured } from './email.js';

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Devuelve la lista de destinatarios (líder y/o miembro) que tengan email cargado.
function recipients(iv) {
  const list = [];
  if (iv.interviewerEmail) list.push({ email: iv.interviewerEmail, label: iv.interviewerName || 'líder' });
  if (iv.memberEmail) list.push({ email: iv.memberEmail, label: iv.memberName || 'miembro' });
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

async function sendToParticipants(iv, subject, buildHtml) {
  if (!isEmailConfigured()) return;
  for (const r of recipients(iv)) {
    try {
      await sendEmail({ to: r.email, subject, html: buildHtml(r) });
      console.log(`[notificaciones] "${subject}" enviado a ${r.email}`);
    } catch (err) {
      console.error(`[notificaciones] error enviando "${subject}" a ${r.email}:`, err.message);
    }
  }
}

export async function sendReminderEmail(iv) {
  await sendToParticipants(
    iv,
    `Recordatorio: entrevista con ${iv.memberName} mañana`,
    (r) => `<p>Hola ${escHtml(r.label)},</p>
<p>Este es un recordatorio: tienes una entrevista agendada para <strong>mañana</strong> en OrganizaSion.</p>
<ul>${detailRows(iv)}</ul>
<p>— OrganizaSion</p>`
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
