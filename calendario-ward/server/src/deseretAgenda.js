// ----------------------------------------------------------------------
// DESERET COMO AYUDA MEMORIA (puntos 76 a 83 y 88)
// ----------------------------------------------------------------------
//   76 "¿Qué tenía que hacer?"          → atrasado + hoy + pendientes sin fecha
//   77 "¿Qué hablamos con Pedro?"       → actas, compromisos, entrevistas y notas
//   78 "Anota esto: …" (texto o dictado) → lo ordena en pendientes y recordatorios
//   79 "Anota esto" / "guárdalo"        → guarda la última respuesta como pendiente
//   80 "Prepárame el domingo"           → todo lo del domingo + qué llevar
//   82 "¿Cuándo puedo preparar la clase?" → espacios libres en tu agenda
//   83 "¿Cómo me fue la semana pasada?" → cumplido / pendiente + reagendar
//   88 "… y recuérdame …"               → separa el recordatorio del resto
// Siempre con los permisos de cada módulo (actas: canSeeMeetingRecord).
// ----------------------------------------------------------------------
import { load, withDb, nextId } from './db.js';
import { resumenSemana } from './semana.js';
import { canSeeMeetingRecord, canSeeMeetingFullContent } from './routes/meetings.js';
import { preparativosDe } from './routes/preparativos.js';
import { resp, normalizeSearchText, fechaLegible, parseFecha, parseHora } from './chat.js';
import { jsonRapido } from './iaRapida.js';

const ZONA = process.env.TZ_APP || 'America/Santiago';
function ahora() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}
const sumar = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10); };
const diaSem = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); };
const DC = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const corta = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${DC[diaSem(iso)]} ${d}/${m}`; };

// ---------------- Detección ----------------
const RE_QUE_HACER = /\b(que (tenia|tengo|debo|deberia|me toca) (que )?hacer( hoy)?|que se me (esta )?olvid\w*|que me falta( hacer)?|que (tengo|hay) pendiente|en que (quede|estaba)|pendientes de hoy)\b/;
const RE_HABLAMOS = /\bque (hablamos|conversamos|converse|hable|vimos|acordamos|quedamos|tratamos) con\s+(.+)/;
const RE_ANOTA = /^\s*(deseret,?\s*)?((anota|anotame|apunta|apuntame|guarda) esto\b|toma nota\b|guardalo\b|guardala\b|(anota|apunta)\s*:)/;
const RE_DOMINGO = /\b(prepar\w*|como viene|que tengo|organiz\w*|que me toca|resumen)\b.{0,20}\b(el |este |mi |del |para el )?domingo\b/;
const RE_CUANDO_PERSONAL = /\bcuando (puedo|podria|me conviene|tengo tiempo (para|de)|alcanzo a)\s+(preparar|estudiar|llamar|visitar|leer|escribir|revisar|ir|terminar|hacer)\b(.*)$/;
const RE_ACTIVIDAD = /\b(actividad|campamento|convivencia|paseo|noche de hogar|fiesta|taller|reunion|evento|asado|servicio)\b/;
const RE_SEMANA_PASADA = /\b(semana pasada|ultima semana|la semana anterior)\b.{0,30}|\bcomo me fue\b/;
const RE_Y_RECUERDAME = /^(.{6,}?)[,;]?\s+y\s+(recu[eé]rdame|av[ií]same|recordarme)\b(.+)$/i;

export function detectarAgenda(norm) {
  if (norm === '__posponer_atrasados') return 'posponer';
  if (RE_ANOTA.test(norm)) return 'anota';
  if (RE_HABLAMOS.test(norm)) return 'hablamos';
  if (RE_QUE_HACER.test(norm)) return 'quehacer';
  if (RE_DOMINGO.test(norm)) return 'domingo';
  if (RE_CUANDO_PERSONAL.test(norm) && !RE_ACTIVIDAD.test(norm)) return 'cuando';
  if (RE_SEMANA_PASADA.test(norm) && /\b(como|resumen|que (cumpli|hice|quedo))\b/.test(norm)) return 'pasada';
  return null;
}
// 88: "agenda una entrevista con Juan el martes y recuérdame llamarlo el lunes a las 10"
export function separarRecordatorio(mensaje) {
  const m = String(mensaje).match(RE_Y_RECUERDAME);
  if (!m) return null;
  return { resto: m[1].trim(), recordatorio: `recuérdame${m[3]}`.trim() };
}

export async function manejarAgenda(tipo, { mensaje, norm, usuario, historial, hoyObj }) {
  const data = load();
  switch (tipo) {
    case 'quehacer': return queHacer(usuario, data);
    case 'hablamos': return queHablamos(norm, usuario, data);
    case 'anota': return anota(mensaje, norm, usuario, historial, hoyObj);
    case 'domingo': return domingo(usuario, data);
    case 'cuando': return cuandoPuedo(norm, mensaje, usuario, data);
    case 'pasada': return semanaPasada(usuario, data);
    case 'posponer': return posponerAtrasados(usuario);
    default: return null;
  }
}

// ---------------- 76 ----------------
function queHacer(usuario, data) {
  const a = ahora();
  const r = resumenSemana(usuario, data, { desde: a.fecha, dias: 1 });
  const atrasados = r.compromisos.filter((c) => c.atrasado);
  const prepAtrasados = (r.preparativos || []).filter((p) => p.atrasado);
  const hoy = [...r.entrevistas, ...r.actividades, ...(r.recordatorios || []), ...r.compromisos.filter((c) => !c.atrasado), ...(r.preparativos || []).filter((p) => !p.atrasado)]
    .sort((x, y) => (x.hora || '99').localeCompare(y.hora || '99'));
  const pend = (data.pendientes || []).filter((p) => Number(p.userId) === Number(usuario.id) && !p.hecho).slice(0, 6);
  const partes = [];
  if (atrasados.length || prepAtrasados.length) partes.push(`**Atrasado**\n${[...atrasados, ...prepAtrasados].slice(0, 6).map((x) => `• ${x.titulo} (vencía el ${corta(x.fecha)})`).join('\n')}`);
  if (hoy.length) partes.push(`**Hoy**\n${hoy.slice(0, 8).map((x) => `• ${x.hora ? `${x.hora} · ` : ''}${x.titulo}`).join('\n')}`);
  if (pend.length) partes.push(`**Pendientes sin fecha**\n${pend.map((p) => `• ${p.texto}`).join('\n')}`);
  if (!partes.length) return resp('No tienes nada atrasado ni nada para hoy. ¡Vas al día!');
  return resp(`Esto es lo que tienes que hacer:\n\n${partes.join('\n\n')}`, atrasados.length ? { opciones: [{ label: 'Pasar los atrasados a la próxima semana', value: '__posponer_atrasados' }] } : {});
}

// ---------------- 77 ----------------
const STOP = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'hermano', 'hermana', 'hno', 'hna', 'familia', 'y', 'en', 'la', 'ultima', 'vez', 'reunion']);
function queHablamos(norm, usuario, data) {
  const quien = (norm.match(RE_HABLAMOS) || [])[2].replace(/\b\w/g, (c) => c.toUpperCase()).replace(/[?¿.!]+/g, '').replace(/\b(la ultima vez|en la reunion|el otro dia)\b/g, '').trim();
  const pal = quien.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  if (!pal.length) return resp('¿Con quién? Por ejemplo: "¿qué hablamos con Pedro Salinas?"');
  const tiene = (t) => { const n = normalizeSearchText(t); return pal.every((w) => n.includes(w)); };
  const hallazgos = [];
  for (const m of data.meetings || []) {
    if (!canSeeMeetingRecord(usuario, m, data)) continue;
    const full = canSeeMeetingFullContent(usuario, m, data);
    for (const it of m.agendaItems || []) {
      const txt = [it.topic, it.notes, it.need, it.analysis, it.agreement, it.followUp, it.who, it.what].filter(Boolean).join(' · ');
      if (full && tiene(txt)) hallazgos.push({ f: m.date, t: `Acta "${m.title}": ${String(it.topic || '').slice(0, 80)}${it.agreement ? ` — acuerdo: ${String(it.agreement).slice(0, 100)}` : ''}` });
    }
    for (const c of m.commitments || []) {
      const asignado = data.users.find((u) => u.id === Number(c.assignedToUserId))?.name || '';
      if ((full || !c.confidential) && (tiene(c.description) || tiene(asignado))) hallazgos.push({ f: c.dueDate || m.date, t: `Compromiso: ${String(c.description).slice(0, 100)} (${asignado || 'sin responsable'}, ${c.status === 'completed' ? 'cumplido' : 'pendiente'})` });
    }
  }
  for (const iv of data.interviews || []) {
    const mio = Number(iv.interviewerUserId) === Number(usuario.id) || iv.interviewerName === usuario.name;
    if (mio && tiene(iv.memberName || '')) hallazgos.push({ f: iv.date, t: `Entrevista con ${iv.memberName}${iv.status === 'done' ? ' (realizada)' : iv.date >= ahora().fecha ? ' (agendada)' : ''}` });
  }
  for (const p of data.pendientes || []) if (Number(p.userId) === Number(usuario.id) && tiene(p.texto)) hallazgos.push({ f: String(p.creadoEn).slice(0, 10), t: `Tu nota: ${p.texto}${p.hecho ? ' (hecha)' : ''}` });
  for (const r of data.recordatorios || []) if (Number(r.userId) === Number(usuario.id) && tiene(r.texto)) hallazgos.push({ f: r.fecha || String(r.createdAt).slice(0, 10), t: `Recordatorio: ${r.texto}` });
  if (!hallazgos.length) return resp(`No encontré nada anotado sobre **${quien}** en actas, compromisos, entrevistas ni en tus notas.`);
  hallazgos.sort((a, b) => String(b.f).localeCompare(String(a.f)));
  return resp(`Lo que encontré sobre **${quien}** (lo más reciente primero):\n\n${hallazgos.slice(0, 10).map((h) => `• ${h.f ? `${corta(h.f)} — ` : ''}${h.t}`).join('\n')}`);
}

// ---------------- 78 / 79 ----------------
async function anota(mensaje, norm, usuario, historial, hoyObj) {
  const contenido = String(mensaje).replace(/^\s*(deseret,?\s*)?(an[oó]ta(me)?\s+esto|ap[uú]nta(me)?\s+esto|gu[aá]rda\s+esto|toma\s+nota(\s+de\s+esto)?|gu[aá]rdal[oa]|an[oó]ta|ap[uú]nta)\s*[:,-]?\s*/i, '');
  if (contenido.trim().length < 12) {
    // 79: guardar la última respuesta de Deseret como pendiente.
    const ultimo = [...(historial || [])].reverse().find((h) => h && h.bot);
    if (!ultimo) return resp('¿Qué anoto? Dímelo así: "anota esto: preguntarle al obispo por el campamento".');
    const texto = String(ultimo.bot).replace(/\[[^\]]*\]$/, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 190);
    await nuevoPendiente(usuario, texto);
    return resp(`Listo, lo guardé en tus **pendientes** (en Inicio):\n"${texto}${texto.length >= 190 ? '…' : ''}"`);
  }
  // 78: ordenar el texto (dictado o escrito) en pendientes y recordatorios.
  const hoy = ahora().fecha;
  const sistema = `Ordenas notas dictadas por un líder de barrio de La Iglesia en Chile. Hoy es ${hoy} (${['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][diaSem(hoy)]}). Separa el texto en tareas concretas y cortas (máx. 12 palabras cada una, en infinitivo o como recordatorio). Si una tarea tiene día, ponlo en "fecha" (AAAA-MM-DD) y si tiene hora, en "hora" (HH:MM, 24 h); si no, null. Devuelve SOLO JSON: {"items":[{"texto":"...","fecha":null,"hora":null}]} con 1 a 10 items.`;
  let j = null;
  try { j = await jsonRapido(sistema, contenido.slice(0, 2500)); } catch { j = null; }
  let items = Array.isArray(j?.items) ? j.items : null;
  if (!items || !items.length) {
    items = contenido.split(/\n+|;|\.\s+(?=[A-ZÁÉÍÓÚ])/).map((t) => t.trim()).filter((t) => t.length > 2).map((t) => ({ texto: t, fecha: parseFecha(t.toLowerCase(), hoyObj), hora: parseHora(t.toLowerCase()) }));
  }
  const pend = []; const recs = [];
  for (const it of items.slice(0, 10)) {
    const texto = String(it.texto || '').replace(/\s+/g, ' ').trim().slice(0, 190);
    if (!texto) continue;
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(it.fecha || '')) && it.fecha >= hoy ? it.fecha : null;
    if (fecha) {
      const hora = /^\d{2}:\d{2}$/.test(String(it.hora || '')) ? it.hora : '09:00';
      // Si ese día y hora ya pasaron (ej. "el viernes a las 10" dicho el viernes en la tarde), va a la semana siguiente.
      const a = ahora();
      recs.push({ texto, fecha: `${fecha} ${hora}` <= `${a.fecha} ${a.hm}` ? sumar(fecha, 7) : fecha, hora });
    }
    else pend.push(texto);
  }
  for (const t of pend) await nuevoPendiente(usuario, t);
  if (recs.length) {
    await withDb((db) => {
      db.recordatorios = db.recordatorios || [];
      for (const r of recs) db.recordatorios.push({ id: nextId(db, 'recordatorios'), userId: usuario.id, texto: r.texto.charAt(0).toUpperCase() + r.texto.slice(1), fecha: r.fecha, hora: r.hora, enviado: false, createdAt: new Date().toISOString() });
    });
  }
  if (!pend.length && !recs.length) return resp('No logré sacar tareas de eso. ¿Me lo dices de nuevo, una cosa por frase?');
  return resp(`Listo, lo ordené así:${recs.length ? `\n\n**Recordatorios** (te aviso ese día)\n${recs.map((r) => `• ${corta(r.fecha)} ${r.hora} — ${r.texto}`).join('\n')}` : ''}${pend.length ? `\n\n**Pendientes sin fecha** (en Inicio)\n${pend.map((t) => `• ${t}`).join('\n')}` : ''}\n\nSi algo quedó mal, dime "deshaz lo último".`);
}
async function nuevoPendiente(usuario, texto) {
  const t = String(texto).trim();
  await withDb((db) => {
    db.pendientes = db.pendientes || [];
    db.pendientes.push({ id: nextId(db, 'pendientes'), userId: usuario.id, texto: t.charAt(0).toUpperCase() + t.slice(1), hecho: false, creadoEn: new Date().toISOString() });
  });
}

// ---------------- 80 ----------------
function domingo(usuario, data) {
  const a = ahora();
  const d = diaSem(a.fecha);
  const dom = d === 0 ? a.fecha : sumar(a.fecha, 7 - d);
  const r = resumenSemana(usuario, data, { desde: dom, dias: 1 });
  const cosas = [...r.entrevistas, ...r.actividades, ...(r.recordatorios || [])].sort((x, y) => (x.hora || '99').localeCompare(y.hora || '99'));
  const llevar = (data.events || []).filter((e) => e.date === dom && String(e.queLlevar || '').trim() && cosas.some((c) => c.id === e.id))
    .map((e) => `${e.title}: ${String(e.queLlevar).split(/\n+/).filter(Boolean).join(', ')}`);
  const comp = resumenSemana(usuario, data, { desde: a.fecha, dias: Math.max(1, 7 - d + 1) }).compromisos.filter((c) => c.fecha <= dom);
  const prep = preparativosDe(usuario, data, dom);
  const partes = [];
  partes.push(cosas.length ? `**Agenda**\n${cosas.map((x) => `• ${x.hora ? `${x.hora} · ` : ''}${x.titulo}${x.lugar ? ` (${x.lugar})` : ''}`).join('\n')}` : '**Agenda**\nNo tienes reuniones ni entrevistas anotadas ese día.');
  if (llevar.length) partes.push(`**Qué llevar**\n${llevar.map((l) => `• ${l}`).join('\n')}`);
  if (comp.length || prep.length) partes.push(`**Antes del domingo**\n${[...comp, ...prep].slice(0, 6).map((x) => `• ${x.titulo}${x.atrasado ? ' (atrasado)' : ''}`).join('\n')}`);
  return resp(`Tu domingo ${corta(dom)}:\n\n${partes.join('\n\n')}`);
}

// ---------------- 82 ----------------
function cuandoPuedo(norm, mensaje, usuario, data) {
  const m = norm.match(RE_CUANDO_PERSONAL);
  const tarea = `${m[3]}${m[4] || ''}`.replace(/[?¿.!]+/g, '').trim();
  const a = ahora();
  const ocupado = new Map();
  const r = resumenSemana(usuario, data, { desde: a.fecha, dias: 8 });
  for (const x of [...r.entrevistas, ...r.actividades, ...(r.recordatorios || [])]) {
    if (!x.hora) continue;
    const l = ocupado.get(x.fecha) || []; l.push([x.hora, x.fin || sumarHora(x.hora, 60)]); ocupado.set(x.fecha, l);
  }
  const libres = [];
  for (let i = 0; i < 8 && libres.length < 4; i++) {
    const f = sumar(a.fecha, i);
    const dsem = diaSem(f);
    if (dsem === 0) continue; // el domingo suele estar lleno
    const horas = dsem === 6 ? ['10:00', '16:00', '19:00'] : ['19:00', '20:30'];
    for (const h of horas) {
      if (f === a.fecha && h <= a.hm) continue;
      const fin = sumarHora(h, 60);
      const choca = (ocupado.get(f) || []).some(([ini, fi]) => h < fi && ini < fin);
      if (!choca) { libres.push({ f, h }); break; }
    }
  }
  if (!libres.length) return resp('Esta semana tu agenda está bien llena. ¿Te lo dejo como pendiente sin fecha? Dime "anota esto: …".');
  return resp(`Para **${tarea}**, estos espacios están libres en tu agenda:\n\n${libres.map((l) => `• ${corta(l.f)} a las ${l.h}`).join('\n')}\n\nToca uno y te lo recuerdo ese día:`, {
    opciones: libres.map((l) => ({ label: `${corta(l.f)} ${l.h}`, value: `recuérdame ${tarea} el ${l.f} a las ${l.h}` })),
  });
}
function sumarHora(h, min) {
  const [H, M] = h.split(':').map(Number); const t = Math.min(23 * 60 + 59, H * 60 + M + min);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// ---------------- 83 ----------------
function semanaPasada(usuario, data) {
  const a = ahora();
  const desde = sumar(a.fecha, -7);
  let ok = 0; const pendientes = [];
  for (const m of data.meetings || []) {
    for (const c of m.commitments || []) {
      if (Number(c.assignedToUserId) !== Number(usuario.id) || !c.dueDate || c.dueDate < desde || c.dueDate >= a.fecha) continue;
      if (c.status === 'completed') ok += 1; else if (c.status === 'pending') pendientes.push(c.description);
    }
  }
  let prepOk = 0;
  for (const e of data.events || []) for (const t of e.preparativos || []) if (Number(t.responsableId) === Number(usuario.id) && t.hecho && String(t.hechoEn || '').slice(0, 10) >= desde) prepOk += 1;
  const entrevistas = (data.interviews || []).filter((iv) => iv.status === 'done' && iv.date >= desde && iv.date < a.fecha && (Number(iv.interviewerUserId) === Number(usuario.id) || iv.interviewerName === usuario.name)).length;
  const pendHechos = (data.pendientes || []).filter((p) => Number(p.userId) === Number(usuario.id) && p.hecho && String(p.hechoEn || '').slice(0, 10) >= desde).length;
  const total = ok + pendientes.length;
  const texto = `**Tu semana pasada**\n• Compromisos cumplidos: ${ok}${total ? ` de ${total}` : ''}\n• Preparativos hechos: ${prepOk}\n• Entrevistas realizadas: ${entrevistas}\n• Pendientes tachados: ${pendHechos}${pendientes.length ? `\n\n**Quedó pendiente**\n${pendientes.slice(0, 6).map((t) => `• ${t}`).join('\n')}` : '\n\n¡No quedó nada atrasado!'}`;
  return resp(texto, pendientes.length ? { opciones: [{ label: 'Pasar los atrasados a la próxima semana', value: '__posponer_atrasados' }] } : {});
}
async function posponerAtrasados(usuario) {
  const a = ahora();
  const nueva = sumar(a.fecha, 7);
  let n = 0;
  await withDb((db) => {
    for (const m of db.meetings || []) for (const c of m.commitments || []) {
      if (Number(c.assignedToUserId) === Number(usuario.id) && c.status === 'pending' && c.dueDate && c.dueDate < a.fecha) { c.dueDate = nueva; c.pushPorVencerSent = false; c.pushVencidoSent = false; n += 1; }
    }
  });
  return resp(n ? `Listo: moví ${n} compromiso${n === 1 ? '' : 's'} atrasado${n === 1 ? '' : 's'} al **${fechaLegible(nueva)}**.` : 'No tenías compromisos atrasados.');
}
