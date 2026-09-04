// Generación de archivos/feeds .ics (formato iCalendar, RFC 5545), sin
// librerías externas, para que cualquiera pueda suscribirse a su "Mis
// Actividades" desde Google Calendar, Apple Calendar u Outlook.
//
// Las horas se escriben como "hora flotante" (sin sufijo Z ni TZID): el
// barrio funciona en un único huso horario, así que cada calendario personal
// las interpreta según la zona horaria local del dispositivo — que para
// alguien del mismo barrio es, en la práctica, la correcta.

function icsEscapeText(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// RFC 5545 exige que ninguna línea supere los 75 octetos; las líneas más
// largas se "pliegan" en varias, cada una de continuación empieza con un
// espacio. Se pliega por caracteres completos (no corta un carácter UTF-8 a
// la mitad) contando bytes reales.
function foldLine(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const parts = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    const limit = parts.length === 0 ? 75 : 74; // -1 para el espacio de continuación
    if (currentBytes + chBytes > limit) {
      parts.push(current);
      current = ch;
      currentBytes = chBytes;
    } else {
      current += ch;
      currentBytes += chBytes;
    }
  }
  if (current) parts.push(current);
  return parts.map((p, i) => (i === 0 ? p : ' ' + p)).join('\r\n');
}

function formatIcsDateTime(dateStr, timeStr) {
  const [y, m, d] = String(dateStr).split('-');
  const [hh, mm] = String(timeStr || '00:00').split(':');
  return `${y}${m}${d}T${(hh || '00').padStart(2, '0')}${(mm || '00').padStart(2, '0')}00`;
}

function formatIcsUtcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

// items: [{ id, kind: 'event'|'interview', date, startTime, endTime, summary, location, description, organizationName }]
export function buildIcsCalendar(items, calendarName) {
  const now = formatIcsUtcStamp();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OrganizaSion//Mis Actividades//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscapeText(calendarName)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const it of items) {
    if (!it.date || !it.startTime) continue;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${it.kind}-${it.id}@calendario-barrio-valle-grande`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART:${formatIcsDateTime(it.date, it.startTime)}`);
    if (it.endTime) {
      lines.push(`DTEND:${formatIcsDateTime(it.date, it.endTime)}`);
    } else {
      lines.push('DURATION:PT1H');
    }
    lines.push(`SUMMARY:${icsEscapeText(it.summary)}`);
    if (it.location) lines.push(`LOCATION:${icsEscapeText(it.location)}`);
    if (it.description) lines.push(`DESCRIPTION:${icsEscapeText(it.description)}`);
    if (it.organizationName) lines.push(`CATEGORIES:${icsEscapeText(it.organizationName)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
