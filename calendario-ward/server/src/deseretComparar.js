// ----------------------------------------------------------------------
// DESERET — CUADROS COMPARATIVOS Y SUGERENCIAS DE LLAMAMIENTO
// ----------------------------------------------------------------------
//   "Compara a Gabriel Aracena con Jaime Cuenca"
//      → tabla lado a lado con lo que quien pregunta puede ver de cada ficha
//        (mismos permisos que la Ficha 360°).
//   "¿A quién le falta llamamiento?" / "¿A quién podríamos llamar?"
//      → personas del Enfoque Ministración sin llamamiento, ordenadas por
//        quiénes están más listos para recibir uno (asistencia,
//        recomendación, convenios), con el motivo de cada una.
//
// Las respuestas traen `tabla: { columnas, filas, voz }`, que el widget
// dibuja como cuadro (y se puede copiar para pegar en Excel/Sheets).
// ----------------------------------------------------------------------
import { resolverPersona, puedeVerFichas, buscarPersonas, fichaPersona } from './persona.js';
import { isMinisteringFocusLeaderHombres, isMinisteringFocusLeaderMujeres } from './routes/directory.js';
import { computeCuadrante, ageFromBirthDate, isAdultMale, isAdultFemale } from './pastoralFocus.js';
import { resp, redactarConIA, filtrarAlucinacion, fechaLegible } from './chat.js';

// ---------------- Detección ----------------
const RE_COMPARAR = /\b(compar\w*|cuadro comparativo|diferencias? entre)\b/;
const RE_LLAMAMIENTO = new RegExp([
  String.raw`\bllamamientos?\b.{0,40}\b(falta\w*|sin|libres?|disponibles?|candidat\w*|sugi\w*|podri\w*|recomi\w*|quien(es)?)\b`,
  String.raw`\b(falta\w*|sin|no tienen?|candidat\w*|sugi\w*|recomi\w*|quien(es)?)\b.{0,40}\bllamamientos?\b`,
  String.raw`\bquien(es)?\b.{0,25}\b(podri\w+|puedo|podemos|deberi\w+|conviene)\s+llamar\b`,
].join('|'));

export function detectarComparar(norm) {
  if (RE_COMPARAR.test(norm)) return 'comparar';
  if (RE_LLAMAMIENTO.test(norm)) return 'llamamiento';
  return null;
}

export function manejarComparar(tipo, { mensaje, norm, usuario, data, historial }) {
  if (tipo === 'comparar') return compararPersonas(mensaje, usuario, data, historial);
  if (tipo === 'llamamiento') return sugerirLlamamientos(mensaje, norm, usuario, data);
  return null;
}

const clave = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zñ ]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
const primerNombre = (nombre) => {
  // "Apellido, Nombre" (Directorio) → "Nombre"; si no, la primera palabra.
  const s = String(nombre || '');
  return (s.includes(',') ? s.split(',')[1] : s).trim().split(/\s+/)[0] || s;
};
// "Cuenca Rodriguez, Jaime Ariel" → "Jaime Cuenca" (para columnas angostas).
const nombreCorto = (nombre) => {
  const s = String(nombre || '');
  if (!s.includes(',')) return s.split(/\s+/).slice(0, 2).join(' ');
  const [ap, no] = s.split(',');
  return `${no.trim().split(/\s+/)[0]} ${ap.trim().split(/\s+/)[0]}`;
};
const nombreNatural = (nombre) => {
  const s = String(nombre || '');
  if (!s.includes(',')) return s;
  const [ap, no] = s.split(',');
  return `${no.trim()} ${ap.trim()}`;
};

// ======================================================================
// CUADRO COMPARATIVO
// ======================================================================
function extraerNombres(mensaje) {
  const m = mensaje.match(/(comp[aá]r\S*|cuadro\s+comparativo|diferencias?\s+entre)/i);
  let resto = m ? mensaje.slice(m.index + m[0].length) : mensaje;
  const relleno = /^\s*(me|nos|por favor|un|una|el|la|las|los|de|del|entre|a|al|en|con|las?\s+fichas?|fichas?|datos|informaci[oó]n|cuadro|comparativo|comparaci[oó]n|hermanos?|hermanas?|hnos?\.?|hnas?\.?)\b[\s,:]*/i;
  for (let i = 0; i < 12 && relleno.test(resto); i++) resto = resto.replace(relleno, '');
  return resto
    .replace(/[?¿!.]+/g, ' ')
    .split(/\s*(?:,|;|\by\b|\be\b|\bcon\b|\bvs\.?|\bversus\b|\bcontra\b)\s*/i)
    .map((s) => s.replace(/^(el|la|a|al|hermanos?|hermanas?|hno\.?|hna\.?)\s+/i, '').trim())
    .filter((s) => s.length >= 3);
}

// Una sola persona para ese nombre: exacta si la hay; si no, la única que
// calza con todas las palabras. Devuelve { unica } o { varias } o {}.
function elegirPersona(nombre, data) {
  const res = buscarPersonas(nombre, data);
  if (!res.length) return {};
  if (res.length === 1) return { unica: res[0] };
  const k = clave(nombre);
  const exactas = res.filter((r) => clave(r.nombre) === k);
  if (exactas.length === 1) return { unica: exactas[0] };
  return { varias: res.slice(0, 6) };
}

const fila = (f, seccion, etiqueta) => (f.secciones.find((s) => s.clave === seccion)?.filas || []).find(([k]) => k === etiqueta)?.[1];
const resumen = (f, seccion) => f.secciones.find((s) => s.clave === seccion)?.resumen;
const siNo = (v) => (v === true ? 'Sí' : v === false ? 'No' : '—');
const CONVENIO = { si: 'Sí', no: 'Pendiente', na: 'No aplica' };

function enfoqueDetalle(viewer, data, ref) {
  const p = resolverPersona(data, ref);
  if (!p?.d) return null;
  const puede = p.d.sex === 'V' ? isMinisteringFocusLeaderHombres(viewer, data) : isMinisteringFocusLeaderMujeres(viewer, data);
  const f = (data.pastoralFocus || []).find((x) => x.memberId === p.d.id);
  if (!puede || !f || !f.asistencia) return puede ? { sinEvaluar: true } : null;
  return {
    cuadrante: computeCuadrante(f),
    asistencia: f.asistencia,
    llamamiento: siNo(f.tieneLlamamiento),
    recomendacion: siNo(f.recomendacionVigente),
    convenios: f.faltaConvenio ? 'Alguno pendiente' : 'Al día',
    investidura: f.convenios ? CONVENIO[f.convenios.investidura] || '—' : null,
    sellamiento: f.convenios ? CONVENIO[f.convenios.sellamiento] || '—' : null,
    ordenacion: f.convenios && p.d.sex === 'V' ? CONVENIO[f.convenios.ordenacion] || '—' : null,
    evaluado: String(f.updatedAt || '').slice(0, 10) || '—',
  };
}

async function compararPersonas(mensaje, usuario, data, historial) {
  if (!puedeVerFichas(usuario)) return resp('🔒 Las fichas de las personas (y compararlas) están disponibles para líderes, secretarios y el Administrador.');
  const nombres = extraerNombres(mensaje);
  if (nombres.length < 2) return resp('📊 ¿A quiénes comparo? Dime al menos dos nombres, por ejemplo: "compara a Gabriel Aracena con Jaime Cuenca".');
  if (nombres.length > 4) return resp('📊 Puedo comparar hasta 4 personas a la vez (para que el cuadro se lea bien en el teléfono). ¿Cuáles 4?');

  const elegidas = [];
  for (const n of nombres) {
    const r = elegirPersona(n, data);
    if (r.varias) {
      return resp(`🔎 Encontré varias personas que coinciden con **${n}**. ¿Cuál quieres comparar?`, {
        opciones: r.varias.map((x) => ({ label: x.nombre, value: `compara a ${nombres.map((o) => (o === n ? nombreNatural(x.nombre) : o)).join(' con ')}` })),
      });
    }
    if (!r.unica) return resp(`🔎 No encontré a **${n}** en el Directorio ni entre los usuarios. Revisa el nombre y lo intento de nuevo.`);
    elegidas.push(r.unica);
  }

  const fichas = elegidas.map((r) => {
    const ref = { directoryId: r.directoryId, userId: r.userId };
    return { f: fichaPersona(usuario, data, ref), e: enfoqueDetalle(usuario, data, ref) };
  }).filter((x) => x.f);
  if (fichas.length < 2) return resp('No pude armar las fichas para compararlas.');

  const verEnfoque = fichas.some((x) => x.e && !x.e.sinEvaluar);
  const filas = [
    ['Edad', (x) => fila(x.f, 'basicos', 'Edad')],
    ['Organización', (x) => fila(x.f, 'basicos', 'Organización probable')],
    ['Llamamiento en la app', (x) => fila(x.f, 'basicos', 'Llamamiento') || (x.f.userId ? 'Sin llamamiento registrado' : 'Sin cuenta')],
    ...(verEnfoque ? [
      ['Cuadrante', (x) => (x.e?.sinEvaluar ? 'Sin evaluar' : x.e?.cuadrante)],
      ['Asistencia', (x) => x.e?.asistencia],
      ['Tiene llamamiento', (x) => x.e?.llamamiento],
      ['Recomendación vigente', (x) => x.e?.recomendacion],
      ['Convenios', (x) => x.e?.convenios],
      ['Investidura', (x) => x.e?.investidura],
      ['Sellamiento', (x) => x.e?.sellamiento],
      ['Ordenación', (x) => x.e?.ordenacion],
      ['Evaluado el', (x) => (x.e?.evaluado && x.e.evaluado !== '—' ? fechaLegible(x.e.evaluado) : null)],
    ] : []),
    ['Entrevistas', (x) => resumen(x.f, 'entrevistas')?.replace(/\s*\(que puedas ver\)/, '').replace(/^Sin entrevistas registradas\.?$/, 'Ninguna')],
    ['Discursos', (x) => resumen(x.f, 'discursos')?.replace(/^Sin discursos registrados\.?$/, 'Ninguno')],
    ['Solicitudes pendientes', (x) => {
      const s = x.f.secciones.find((z) => z.clave === 'solicitudes');
      return s ? String(s.items.length) : null;
    }],
    ['Bienestar', (x) => resumen(x.f, 'bienestar')],
  ].map(([etiqueta, valor]) => [etiqueta, ...fichas.map((x) => valor(x) || '—')])
    .filter((r) => r.slice(1).some((v) => v !== '—'));

  const columnas = ['', ...fichas.map((x) => nombreCorto(x.f.nombre))];
  const tabla = { columnas, filas, voz: 'columnas', sinResaltar: ['Edad', 'Evaluado el'] };
  const titulo = `📊 **${columnas.slice(1).join(' vs. ')}**`;
  const distintas = filas.filter((r) => new Set(r.slice(1)).size > 1 && !['Edad', 'Evaluado el'].includes(r[0])).map((r) => r[0].toLowerCase());

  const contexto = filas.map((r) => `${r[0]}: ${columnas.slice(1).map((c, i) => `${c} = ${r[i + 1]}`).join(' | ')}`).join('\n');
  const sistema = `Eres Deseret, asistente de OrganizaSion. Compara a estas personas del barrio con SOLO estos datos (ya filtrados según los permisos de quien pregunta):
${contexto}

Escribe 2 o 3 frases: en qué se parecen, en qué se diferencian y, si corresponde, una sugerencia práctica (una entrevista, un llamamiento, un seguimiento). El cuadro ya se muestra debajo: NO lo repitas completo. No inventes datos. Tono cercano y respetuoso, nunca de juicio. Vocabulario SUD (nunca "pastoral").`;
  const redactado = await redactarConIA(sistema, historial, mensaje);
  const texto = redactado ? `${titulo}\n\n${filtrarAlucinacion(redactado)}`
    : `${titulo}\n\n${distintas.length ? `Se diferencian en: **${distintas.join(', ')}**.` : 'En lo que puedes ver de sus fichas, están en una situación muy parecida.'} Aquí va el cuadro:`;
  return resp(texto, {
    tabla,
    opciones: fichas.map((x) => ({ label: `📇 Ficha de ${primerNombre(x.f.nombre)}`, value: `ficha de ${x.f.nombre}`, ficha: { directoryId: x.f.directoryId, userId: x.f.userId } })),
  });
}

// ======================================================================
// SUGERENCIAS DE LLAMAMIENTO
// ======================================================================
const PUNTOS_ASISTENCIA = { Alto: 3, Medio: 2, Bajo: 0.5 };

function sugerirLlamamientos(mensaje, norm, usuario, data) {
  const puedeH = isMinisteringFocusLeaderHombres(usuario, data);
  const puedeM = isMinisteringFocusLeaderMujeres(usuario, data);
  if (!puedeH && !puedeM) return resp('🔒 Las sugerencias de llamamiento salen del **Enfoque Ministración**, que ven el Obispado y las presidencias de Cuórum de Élderes y Sociedad de Socorro.');

  // ¿Pidió solo hermanos o solo hermanas?
  const soloH = /\b(hermanos|hombres|varones|elderes|cuorum)\b/.test(norm) && !/\b(hermanas|mujeres|sociedad de socorro)\b/.test(norm);
  const soloM = /\b(hermanas|mujeres|sociedad de socorro)\b/.test(norm) && !soloH;
  const verH = puedeH && !soloM;
  const verM = puedeM && !soloH;
  // "...para maestro de la Primaria" → se menciona en la respuesta.
  const para = (mensaje.match(/\b(?:para|como)\s+(?:un[ao]?\s+|el\s+|la\s+)?((?:maestr|president|consejer|secretari|l[ií]der|especialista|director|pianista|obrer|asesor|misioner)[^?¿!.,]{0,40})/i)?.[1] || '').trim();

  const hoy = new Date().toISOString().slice(0, 10);
  const hace6m = new Date(Date.now() - 183 * 86400000).toISOString().slice(0, 10);
  const porId = new Map((data.directoryMembers || []).map((m) => [m.id, m]));
  const focoPorId = new Map((data.pastoralFocus || []).map((f) => [f.memberId, f]));
  const candidatos = [];
  let yaTienenEnApp = 0; let sinEvaluar = 0; let evaluados = 0;

  for (const m of data.directoryMembers || []) {
    const esH = isAdultMale(m); const esM = isAdultFemale(m);
    if (!((verH && esH) || (verM && esM))) continue;
    const f = focoPorId.get(m.id);
    if (!f || !f.asistencia) { sinEvaluar += 1; continue; }
    evaluados += 1;
    if (f.tieneLlamamiento !== false) continue;
    const p = resolverPersona(data, { directoryId: m.id });
    if (p?.u?.role === 'leader') { yaTienenEnApp += 1; continue; }
    const conveniosAlDia = !f.faltaConvenio;
    const vieja = String(f.updatedAt || '').slice(0, 10) < hace6m;
    const puntaje = (PUNTOS_ASISTENCIA[f.asistencia] || 0) + (f.recomendacionVigente ? 1 : 0) + (conveniosAlDia ? 1 : 0) - (vieja ? 0.3 : 0);
    const pendientes = f.convenios
      ? Object.entries({ investidura: 'investidura', sellamiento: 'sellamiento', ordenacion: 'ordenación' }).filter(([k]) => f.convenios[k] === 'no').map(([, v]) => v)
      : (f.faltaConvenio ? ['algún convenio'] : []);
    const entrevista = (data.interviews || []).find((iv) => Number(iv.memberDirectoryId) === m.id && (iv.status || 'scheduled') === 'scheduled' && iv.date >= hoy);
    const motivo = [
      f.asistencia === 'Alto' ? 'asiste siempre' : f.asistencia === 'Medio' ? 'asiste seguido' : 'asiste poco; un llamamiento podría ayudarle a volver',
      f.recomendacionVigente ? 'tiene recomendación' : null,
      pendientes.length ? `le falta ${pendientes.join(' y ')}` : null,
      entrevista ? `entrevista agendada el ${fechaLegible(entrevista.date)}` : null,
      vieja ? 'evaluación de hace más de 6 meses' : null,
    ].filter(Boolean).join('; ');
    const edad = ageFromBirthDate(m.birthDate);
    candidatos.push({ m, f, puntaje, motivo, edad, pendientes });
  }

  candidatos.sort((a, b) => b.puntaje - a.puntaje || (a.edad ?? 99) - (b.edad ?? 99));
  const quienes = verH && verM ? 'hermanos y hermanas' : verH ? 'hermanos' : 'hermanas';
  const evaluadosTxt = verH ? 'evaluados' : 'evaluadas';
  if (!candidatos.length) {
    return resp(`🙌 Según el **Enfoque Ministración**, no hay ${quienes} ${evaluadosTxt} sin llamamiento.${sinEvaluar ? ` Eso sí, hay **${sinEvaluar}** ${verH && verM ? 'adultos' : quienes} sin evaluar todavía; al completar su evaluación podrían aparecer candidatos.` : ''}`);
  }

  const top = candidatos.slice(0, 8);
  const tabla = {
    columnas: ['Persona', 'Asistencia', 'Recomendación', 'Convenios', 'Por qué'],
    filas: top.map((c) => [
      `${nombreCorto(c.m.name)}${c.edad !== null ? ` (${c.edad})` : ''}`,
      c.f.asistencia,
      c.f.recomendacionVigente ? 'Vigente' : 'No',
      c.pendientes.length ? 'Pendiente' : 'Al día',
      c.motivo,
    ]),
    voz: 'filas',
  };
  const notas = [
    candidatos.length > top.length ? `Te muestro los ${top.length} primeros de **${candidatos.length}** sin llamamiento.` : null,
    yaTienenEnApp ? `${yaTienenEnApp} figuran sin llamamiento en el Enfoque pero sí tienen uno en la app: conviene actualizar su evaluación.` : null,
    sinEvaluar ? `Hay **${sinEvaluar}** ${verH && verM ? 'adultos' : quienes} sin evaluar en el Enfoque; también podrían ser candidatos.` : null,
  ].filter(Boolean);
  const texto = `🙋 **${candidatos.length} ${quienes} sin llamamiento** (de ${evaluados} ${evaluadosTxt})${para ? ` que podrían servir como **${para}**` : ''}. Los ordené por quién parece más listo para recibir uno (asistencia, recomendación y convenios):`
    + (notas.length ? `\n\n${notas.join('\n')}` : '')
    + `\n\n_Es solo un punto de partida: el llamamiento lo decide el obispado, buscando inspiración.${para ? ' Revisa también que la edad y el perfil calcen con ese llamamiento.' : ''}_`;
  return resp(texto, {
    tabla,
    opciones: top.slice(0, 3).map((c) => ({ label: `📇 Ficha de ${primerNombre(c.m.name)}`, value: `ficha de ${c.m.name}`, ficha: { directoryId: c.m.id, userId: null } })),
  });
}
