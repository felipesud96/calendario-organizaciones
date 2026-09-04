// Extracción asistida de PDF para "Crecimiento del Barrio" (Punto ~102,
// segunda etapa). Lee el PDF de un informe oficial y devuelve un
// BORRADOR con la MISMA forma que espera wardGrowth.js — pero esto NUNCA
// escribe a la base de datos. Ver routes/wardGrowth.js: la ruta que llama a
// este módulo sólo devuelve el borrador al cliente; el guardado real sigue
// pasando, siempre, por los mismos POST/PUT de siempre, con el humano
// revisando y tocando "Guardar" — ese es el límite de seguridad que pidió
// el usuario y que no cambia acá.
//
// Por qué OCR y no un lector de texto de PDF: los 7 reportes reales que
// usa el Obispado se generan con el driver "Microsoft: Print To PDF" y NO
// tienen absolutamente ninguna capa de texto — cada carácter es un trazo
// vectorial (confirmado con qpdf: 0 objetos /Font, 0 operadores de texto
// "Tj", ~14.800 operadores de línea vectorial). pdftotext, pdf-parse,
// pdfjs-dist, etc. devuelven una página en blanco ante esto sin importar
// la librería — no es una limitación de qué herramienta se elija, es que
// el archivo no tiene texto que extraer. La única vía es "renderizar y
// leer la imagen": pdftoppm (rasteriza cada página a PNG) + tesseract
// (OCR). Ambos son binarios de sistema (paquete Debian/Ubuntu
// poppler-utils y tesseract-ocr), no paquetes npm — el registro de npm
// está bloqueado en este entorno (403 de política, confirmado), así que
// tampoco había margen para usar pdf-parse/pdfjs-dist aunque el PDF SÍ
// hubiese tenido texto. Esto es una desviación real de la filosofía
// "cero dependencias externas" del proyecto (ver db.js): ahora el
// servidor de producción necesita poppler-utils + tesseract-ocr
// instalados en el sistema. Se documenta acá y en el reporte de entrega
// porque es una dependencia operativa nueva, no una decisión de código.
//
// Limitación adicional (también documentada, no un bug): el idioma
// "spa" de tesseract no pudo instalarse en este entorno (mismo bloqueo de
// red que npm — apt intentó bajarlo y recibió 403), así que el OCR corre
// en inglés ("eng"). Los NÚMEROS salen prácticamente perfectos con el
// paquete en inglés (son dígitos, no letras) — el efecto se nota solo en
// los NOMBRES de los conversos, donde las tildes y la "ñ" a veces se leen
// mal (á→a, é→e, ñ→"fi" o "n"). Nunca se "adivina" un nombre: se guarda
// tal cual lo lee el OCR y el humano lo corrige en el formulario si hace
// falta — ninguna decisión de liderazgo depende de si un nombre lleva
// tilde.
//
// Estrategia de parseo (ver detalle en cada función): en vez de intentar
// mapear coordenadas x/y de cada palabra (frágil, y tesseract con "eng"
// ya viene sin esa granularidad fina para texto acentuado), se corre OCR
// en modo "bloque uniforme de texto" (psm 6) y se reconstruyen las filas
// de la tabla a partir de patrones de texto — usando como ancla los
// números de indicador (1 a 26, siempre en orden) para el informe
// trimestral, y el orden fijo de las 40 filas para la instantánea. Esto
// funciona porque ambos reportes son tablas de estructura 100% fija
// (mismas filas, mismo orden, siempre) — no es un OCR de propósito
// general, es un parser hecho a medida para estos dos formatos exactos.
// Cuando una fila no se puede leer con confianza (columna corrida, celda
// vacía que la OCR se comió, glifo mal leído), se dejan warnings
// explícitos en vez de inventar un valor plausible.

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TESSERACT_BIN = process.env.TESSERACT_BIN || 'tesseract';
const PDFTOPPM_BIN = process.env.PDFTOPPM_BIN || 'pdftoppm';
const PDFINFO_BIN = process.env.PDFINFO_BIN || 'pdfinfo';
// En producción (imagen Docker de Render) se instala el paquete de idioma
// "spa" de tesseract, así que los nombres con tildes/ñ de la tabla de
// conversos se leen bien. Si TESSERACT_LANG no está seteado, se intenta
// 'spa+eng' primero y, si tesseract no tiene ese idioma instalado (como en
// este entorno de desarrollo, donde no se pudo instalar por política de
// red), se reintenta automáticamente solo con 'eng' — nunca revienta el
// endpoint por esto, solo puede perder tildes en los nombres.
const TESSERACT_LANG = process.env.TESSERACT_LANG || 'spa+eng';

// ---------------- Rasterizado + OCR (child_process, sin librerías) ----------------

function getPageCount(pdfPath) {
  const out = execFileSync(PDFINFO_BIN, [pdfPath], { encoding: 'utf8' });
  const m = /^Pages:\s*(\d+)/m.exec(out);
  return m ? Number(m[1]) : 0;
}

function ocrPage(pdfPath, pageNumber, tmpDir) {
  const prefix = path.join(tmpDir, `page${pageNumber}`);
  execFileSync(PDFTOPPM_BIN, ['-png', '-r', '300', '-f', String(pageNumber), '-l', String(pageNumber), pdfPath, prefix]);
  const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith(`page${pageNumber}-`) && f.endsWith('.png'));
  if (!files.length) throw new Error(`No se pudo rasterizar la página ${pageNumber} del PDF`);
  const pngPath = path.join(tmpDir, files[0]);
  try {
    return execFileSync(TESSERACT_BIN, [pngPath, 'stdout', '--psm', '6', '-l', TESSERACT_LANG], {
      encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // Idioma no instalado (típico en este sandbox de desarrollo) — reintenta
    // en inglés solo, para no romper la extracción por esto.
    if (TESSERACT_LANG !== 'eng' && /Failed loading language|Error opening data file/i.test(String(err.stderr || err.message))) {
      return execFileSync(TESSERACT_BIN, [pngPath, 'stdout', '--psm', '6', '-l', 'eng'], {
        encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
      });
    }
    throw err;
  }
}

// Punto de entrada: recibe el Buffer del PDF subido, devuelve
// { type: 'quarter'|'snapshot'|null, data, warnings }. NUNCA toca la base
// de datos — eso es responsabilidad exclusiva de quien llama.
export function extractFromPdfBuffer(buffer) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-pdf-'));
  try {
    const pdfPath = path.join(tmpDir, 'input.pdf');
    fs.writeFileSync(pdfPath, buffer);
    const pageCount = getPageCount(pdfPath);
    if (!pageCount) return { type: null, data: null, warnings: ['No se pudo leer el PDF (¿está corrupto o protegido?).'] };
    const pageTexts = [];
    for (let p = 1; p <= pageCount; p++) pageTexts.push(ocrPage(pdfPath, p, tmpDir));

    const detected = detectReportType(pageTexts[0]);
    if (detected.type === 'quarter') {
      const warnings = [];
      const { indicators, warnings: iw } = parseIndicatorsPage(pageTexts[0]);
      warnings.push(...iw);
      let converts = [];
      if (pageTexts[1]) {
        const { converts: c, warnings: cw } = parseConvertsPage(pageTexts[1]);
        converts = c;
        warnings.push(...cw);
      } else {
        warnings.push('El PDF no tiene una segunda página con el detalle de conversos; completar esa tabla manualmente.');
      }
      if (detected.quarter === null || detected.year === null) {
        warnings.push('No se pudo determinar el trimestre/año a partir del encabezado del PDF; completar manualmente.');
      }
      const quarter = detected.quarter;
      const year = detected.year;
      const label = (quarter && year) ? `T${quarter} ${year}` : '';
      return { type: 'quarter', data: { label, quarter, year, indicators, converts }, warnings };
    }
    if (detected.type === 'snapshot') {
      const { data, warnings } = parseSnapshotPages(pageTexts[0], pageTexts[1] || '');
      return { type: 'snapshot', data, warnings };
    }
    return { type: null, data: null, warnings: ['No se reconoció el tipo de informe (se esperaba "Informe trimestral" o "Estadísticas de la unidad" en el encabezado del PDF).'] };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------- Detección de tipo de reporte ----------------

export function detectReportType(page1Text) {
  if (/Informe trimestral/i.test(page1Text)) {
    const m = /Trimestre\s+(\d)\D{0,5}(\d{4})/i.exec(page1Text);
    if (m) return { type: 'quarter', quarter: Number(m[1]), year: Number(m[2]) };
    return { type: 'quarter', quarter: null, year: null };
  }
  if (/Estad[ií]sticas de la unidad/i.test(page1Text)) return { type: 'snapshot' };
  return { type: null };
}

// ---------------- Página 1 del informe trimestral: 26 indicadores ----------------

const isNumericTok = (t) => /^\d{1,4}$/.test(t);
const isDashyTok = (t) => /^[-~_.—–]{1,3}$/.test(t);
const isPctTok = (t) => /^\d{1,3}%$/.test(t);

// Cada fila de indicador imprime SIEMPRE 5 columnas de datos al final:
// Real, Potencial, %2025, %2024, %2020 (con guiones para las que no
// aplican). Estrategia: de los tokens de la fila, quedarse con los que
// parecen "de datos" (número, guion/placeholder, o "NN%") — esto ya
// descarta solo, sin pasos extra, tanto ruido de puntuación suelta (ej.
// una "|" mal leída de una línea de la tabla) como las palabras de la
// etiqueta. Se ancla desde la DERECHA (las últimas 5) porque algunas
// etiquetas (ej. "... Escuela Dominical 0 de la Primaria", con una "o"
// mal leída como "0"; o "(a partir del 1 de enero)") traen dígitos
// sueltos ANTES de los datos reales, que un anclaje desde la izquierda
// confundiría con Real/Potencial. Si no hay exactamente 5 candidatos, es
// señal de que la OCR se comió o deformó alguna columna — se avisa
// explícitamente en vez de asumir que la posición sigue siendo válida.
function extractRealPot(rest, indicatorNumber, warnings) {
  const candidates = rest.filter((t) => isNumericTok(t) || isDashyTok(t) || isPctTok(t));
  if (candidates.length < 5) {
    warnings.push(`Indicador ${indicatorNumber}: se esperaban 5 columnas numéricas en esa fila del PDF y se reconocieron ${candidates.length}; verificar Real/Potencial contra el reporte original.`);
  }
  const tail = candidates.length >= 5 ? candidates.slice(-5) : candidates;
  const c0 = tail[0];
  const c1 = tail[1];
  let real = null;
  let pot = null;
  if (c0 !== undefined && (isNumericTok(c0) || isDashyTok(c0))) {
    real = isDashyTok(c0) ? null : Number(c0);
  } else {
    warnings.push(`Indicador ${indicatorNumber}: no se pudo leer el valor "Real" con confianza en el PDF, completar manualmente.`);
  }
  if (c1 !== undefined && (isNumericTok(c1) || isDashyTok(c1))) {
    pot = isDashyTok(c1) ? null : Number(c1);
  } else if (c1 !== undefined) {
    warnings.push(`Indicador ${indicatorNumber}: no se pudo leer el valor "Potencial" con confianza en el PDF, completar manualmente.`);
  }
  return { real: real === null ? 0 : real, pot };
}

export function parseIndicatorsPage(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const indicators = {};
  const warnings = [];
  let expected = 1;
  for (const line of lines) {
    if (expected > 26) break;
    const tokens = line.split(/\s+/);
    if (tokens[0] !== String(expected)) continue;
    const rest = tokens.slice(1);
    if (rest.length < 2) continue;
    indicators[String(expected)] = extractRealPot(rest, expected, warnings);
    expected++;
  }
  for (let n = expected; n <= 26; n++) {
    warnings.push(`Indicador ${n}: no se encontró en el PDF, completar manualmente.`);
    indicators[String(n)] = { real: 0, pot: null };
  }
  return { indicators, warnings };
}

// ---------------- Página 2 del informe trimestral: detalle de conversos ----------------
//
// El nombre de un converso puede envolverse en hasta 3 líneas (el "Apellidos,"
// termina una línea, "Sexo Edad Asistió Llamamiento" ocupa la siguiente ella
// sola, y el resto del nombre de pila queda en una tercera línea aparte) —
// eso es cómo la OCR lee esta tabla en particular, no una heurística
// genérica de ajuste de texto. Además, una celda vacía (más frecuente en
// "¿Asistió?" cuando ese dato no se cargó) a veces desaparece del todo en
// vez de imprimir un guion, corriendo la columna — se detecta contando
// cuántas de las 2 columnas de datos aparecieron y avisando cuando falta
// una, en vez de adivinar cuál es cuál.
const SEX_TOK = '(?:M|V|Vv)';
const TRI_TOK = '(?:S[ií]|No|[-~_—–]{1,3})';
function normSex(t) { return /^v/i.test(t) ? 'V' : 'M'; }
function normTri(t) {
  if (/^s/i.test(t)) return true;
  if (/^no$/i.test(t)) return false;
  return null; // guion / placeholder ("no aplica" o dato en blanco)
}

const FULL_ROW_RE = new RegExp(`^(.+,.+?)\\s+(${SEX_TOK})\\s+(\\d{1,3})\\s+(${TRI_TOK})\\s+(${TRI_TOK})\\s*$`, 'i');
const FULL_ROW_3_RE = new RegExp(`^(.+,.+?)\\s+(${SEX_TOK})\\s+(\\d{1,3})\\s+(${TRI_TOK})\\s*$`, 'i');
const DATA4_RE = new RegExp(`^(${SEX_TOK})\\s+(\\d{1,3})\\s+(${TRI_TOK})\\s+(${TRI_TOK})\\s*$`, 'i');
const DATA3_RE = new RegExp(`^(${SEX_TOK})\\s+(\\d{1,3})\\s+(${TRI_TOK})\\s*$`, 'i');

export function parseConvertsPage(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const converts = [];
  const warnings = [];
  const totalRe = /ultimos?\s+12\s+meses:?\s*(\d+)/i;
  let totalExpected = null;
  let pendingName = '';
  let state = 'idle'; // idle | awaiting_data | awaiting_suffix

  const isNoise = (line) => /^Nombre\s+Sexo\s+Edad/i.test(line) || /Asisti[oó]/i.test(line)
    || /llamamiento/i.test(line) || /^Detalle de conversos/i.test(line) || /^Informe trimestral/i.test(line);
  const looksLikeSuffix = (line) => /^[A-Za-zÀ-ÿ.'\s]+$/.test(line) && line.split(/\s+/).length <= 4
    && !FULL_ROW_RE.test(line) && !FULL_ROW_3_RE.test(line) && !DATA4_RE.test(line) && !DATA3_RE.test(line);

  for (const line of lines) {
    const totalMatch = totalRe.exec(line);
    if (totalMatch) { totalExpected = Number(totalMatch[1]); continue; }
    if (isNoise(line)) continue;

    const full = FULL_ROW_RE.exec(line);
    if (full) {
      if (pendingName) warnings.push(`Se encontró un nombre a medio completar ("${pendingName}") justo antes de "${full[1].trim()}"; revisar la tabla de conversos completa.`);
      pendingName = '';
      converts.push({
        name: full[1].trim().replace(/\s+/g, ' '),
        sex: normSex(full[2]), age: Number(full[3]),
        attended: normTri(full[4]), hasCalling: normTri(full[5]),
      });
      state = 'awaiting_suffix';
      continue;
    }
    const full3 = FULL_ROW_3_RE.exec(line);
    if (full3) {
      if (pendingName) warnings.push(`Se encontró un nombre a medio completar ("${pendingName}") justo antes de "${full3[1].trim()}"; revisar la tabla de conversos completa.`);
      pendingName = '';
      warnings.push(`Para "${full3[1].trim()}" solo se reconoció 1 columna al final de la fila (se esperaban 2: asistió y llamamiento); es probable que "¿Asistió?" haya quedado en blanco en el PDF. Verificar ambos valores manualmente.`);
      converts.push({
        name: full3[1].trim().replace(/\s+/g, ' '),
        sex: normSex(full3[2]), age: Number(full3[3]),
        attended: null, hasCalling: normTri(full3[4]),
      });
      state = 'awaiting_suffix';
      continue;
    }

    if (state === 'awaiting_data') {
      const d4 = DATA4_RE.exec(line);
      if (d4) {
        converts.push({
          name: pendingName.trim().replace(/\s+/g, ' '), sex: normSex(d4[1]), age: Number(d4[2]),
          attended: normTri(d4[3]), hasCalling: normTri(d4[4]),
        });
        pendingName = '';
        state = 'awaiting_suffix';
        continue;
      }
      const d3 = DATA3_RE.exec(line);
      if (d3) {
        warnings.push(`Para "${pendingName.trim()}" solo se reconocieron 3 columnas en la fila (se esperaban 4: sexo, edad, asistió, llamamiento); es probable que "¿Asistió?" haya quedado en blanco en el PDF. Verificar ambos valores manualmente.`);
        converts.push({
          name: pendingName.trim().replace(/\s+/g, ' '), sex: normSex(d3[1]), age: Number(d3[2]),
          attended: null, hasCalling: normTri(d3[3]),
        });
        pendingName = '';
        state = 'awaiting_suffix';
        continue;
      }
      pendingName = (pendingName + ' ' + line).trim();
      continue;
    }

    if (state === 'awaiting_suffix' && looksLikeSuffix(line)) {
      converts[converts.length - 1].name = (converts[converts.length - 1].name + ' ' + line).trim().replace(/\s+/g, ' ');
      state = 'idle';
      continue;
    }

    state = 'awaiting_data';
    pendingName = line;
  }

  if (pendingName) warnings.push(`Quedó un fragmento de nombre sin fila de datos asociada ("${pendingName.trim()}"); revisar la tabla de conversos completa.`);
  if (totalExpected !== null && totalExpected !== converts.length) {
    warnings.push(`Se esperaban ${totalExpected} conversos según el encabezado pero se reconocieron ${converts.length} filas; revisar la tabla completa.`);
  }
  return { converts, warnings, totalExpected };
}

// ---------------- Instantánea ("Estadísticas de la unidad") ----------------

// Los 40 campos "hoja" de la instantánea, EN EL ORDEN EXACTO en que
// aparecen en el PDF (mismo orden que WARD_SNAPSHOT_FIELDS en app.js) —
// el reporte no imprime ningún total propio para "Adultos" (es la suma de
// casados+solteros+JAS, no se guarda aparte) y repite el total de
// "Conversos recientes" al pasar de la página 1 a la página 2
// (continuación de la misma tabla); el parser de abajo filtra esas dos
// líneas antes de emparejar por posición.
const SNAPSHOT_FIELDS = [
  'totalMembers', 'men.total', 'men.highPriests', 'men.elders', 'men.futureElders',
  'women.total',
  'youngMen.total', 'youngMen.priests', 'youngMen.teachers', 'youngMen.deacons',
  'youngWomen.total', 'youngWomen.guardiansOfLight', 'youngWomen.heraldsOfHope', 'youngWomen.faithBuilders',
  'children3plus', 'children0to2',
  'families.total', 'families.withoutMelchizedekHolder', 'families.withYouth', 'families.withChildren', 'families.singleParent',
  'adults.married', 'adults.single36plus', 'adults.youngSingleAdults',
  'recentConverts.total', 'recentConverts.adultMen', 'recentConverts.adultWomen', 'recentConverts.youngMen', 'recentConverts.youngWomen', 'recentConverts.children',
  'ordinationStatus.total', 'ordinationStatus.ordained', 'ordinationStatus.notOrdained',
  'endowedAdults.total', 'endowedAdults.withRecommend', 'endowedAdults.withoutRecommend',
  'notIncluded.total', 'notIncluded.missingBirthdate', 'notIncluded.baptizedNotConfirmed', 'notIncluded.enrolled9plus',
];

function normLabel(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function setPath(obj, path_, val) {
  const keys = path_.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) { o[keys[i]] = o[keys[i]] || {}; o = o[keys[i]]; }
  o[keys[keys.length - 1]] = val;
}

export function parseSnapshotPages(page1Text, page2Text) {
  const rawLines = [...page1Text.split('\n'), ...page2Text.split('\n')].map((l) => l.trim()).filter(Boolean);
  const lineRe = /^(.*\S)\s+\(?(\d+)\)?\s*$/;
  const skipRe = /^(Estad[ií]sticas de la unidad|Barrio\b|Para uso exclusivo)/i;
  const pairs = [];
  const seenLabels = new Set();
  for (const line of rawLines) {
    if (skipRe.test(line)) continue;
    const m = lineRe.exec(line);
    if (!m) continue; // línea sin un número al final (ruido / footer)
    const label = normLabel(m[1]);
    const value = Number(m[2]);
    if (label === 'adultos') continue; // total de "Adultos" no se guarda (es casados+solteros+JAS)
    if (seenLabels.has(label)) continue; // repetición del total del grupo al pasar de página
    pairs.push({ label, value });
    seenLabels.add(label);
  }
  const data = {};
  const warnings = [];
  const n = Math.min(pairs.length, SNAPSHOT_FIELDS.length);
  for (let i = 0; i < n; i++) setPath(data, SNAPSHOT_FIELDS[i], pairs[i].value);
  for (let i = n; i < SNAPSHOT_FIELDS.length; i++) {
    setPath(data, SNAPSHOT_FIELDS[i], 0);
    warnings.push(`No se encontró en el PDF el campo "${SNAPSHOT_FIELDS[i]}" (se esperaban ${SNAPSHOT_FIELDS.length} valores y se reconocieron ${pairs.length}); completar manualmente.`);
  }
  if (pairs.length > SNAPSHOT_FIELDS.length) {
    warnings.push(`Se reconocieron ${pairs.length} líneas de datos pero la instantánea solo tiene ${SNAPSHOT_FIELDS.length} campos; puede haber una fila extra o duplicada — revisar todos los valores contra el PDF.`);
  }
  return { data, warnings };
}
