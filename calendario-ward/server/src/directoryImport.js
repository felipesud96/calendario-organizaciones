// Extracción del PDF oficial "Lista de miembros" (el mismo tipo de export
// que se cargó una vez a mano el 5 sept 2026 — ver seedDirectory.js /
// directorySeedData.js) para poder re-importarlo desde la app cuando
// cambia la membresía del barrio, en vez de tener que procesarlo a mano
// cada vez.
//
// A diferencia de los reportes de "Crecimiento del Barrio" (pdfExtract.js),
// que se generan con el driver "Microsoft: Print To PDF" sin ninguna capa
// de texto (necesitan rasterizar + OCR), el export "Lista de miembros" de
// la Iglesia SÍ trae texto real embebido en el PDF — así que alcanza con
// `pdftotext -layout` (mismo paquete del sistema, poppler-utils, que ya
// hace falta para el pdftoppm de pdfExtract.js — NO es una dependencia
// nueva para producción) en vez de rasterizar + tesseract.
//
// Estrategia de parseo: la tabla tiene 4 columnas (Nombre / Sexo / Edad /
// Fecha de nacimiento). Cada persona ocupa un bloque separado del
// siguiente por una línea en blanco, pero cuando el nombre es muy largo la
// exportación lo corta en 2 o 3 líneas: el resto del apellido puede quedar
// en la línea de ARRIBA de la fila con los datos, y/o el resto del nombre
// en la línea de ABAJO — sin ninguna línea en blanco de por medio dentro
// del mismo bloque (confirmado a mano contra el PDF real: "Alegre
// Barrantes, Valentina De Las" / fila de datos / "Rosas", las 3 pegadas).
// Por eso se agrupa por bloques separados por líneas vacías, se ubica
// DENTRO de cada bloque la única línea que calza con el patrón "nombre +
// V|M + edad + fecha" (DATA_LINE_RE), y el nombre completo se arma uniendo
// esa línea (la parte antes de la V/M) con cualquier línea extra antes/
// después. Las líneas de encabezado/pie que la exportación repite en cada
// página impresa, y la línea final "Recuento: N", se descartan antes de
// agrupar.
//
// IMPORTANTE (mismo límite de seguridad que pdfExtract.js): esta función
// NUNCA escribe a la base de datos — solo devuelve la lista de personas
// leídas del PDF, más warnings si algo no se pudo leer con confianza. Es
// routes/directory.js quien arma, con esto, un borrador de qué agregar y
// qué ya no aparece (posible baja) comparando contra el Directorio actual
// — y es el Obispado quien revisa y confirma, persona por persona, antes
// de que se guarde nada (ver /api/directory/import/preview y
// /api/directory/import/apply).

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PDFTOTEXT_BIN = process.env.PDFTOTEXT_BIN || 'pdftotext';

const MESES = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, mayo: 5, jun: 6, jul: 7,
  ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12,
};

// "7 nov 1991" / "15 mayo 2013" -> "1991-11-07" (o null si no calza)
function parseFechaChilena(str) {
  const m = /^(\d{1,2})\s+([a-záéíóúñ]+)\.?\s+(\d{4})$/i.exec(str.trim());
  if (!m) return null;
  const dia = Number(m[1]);
  const mes = MESES[m[2].toLowerCase()];
  const anio = Number(m[3]);
  if (!mes || dia < 1 || dia > 31) return null;
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// Línea de datos real: "<nombre>  <espacios>  V|M  <espacios>  <edad>  <espacios>  <fecha>"
// — los espacios entre columnas son muchos (columnas fijas del reporte);
// dentro del nombre y de la fecha nunca hay 2+ espacios seguidos, así que
// "\s{2,}" ubica de forma confiable el límite entre columnas.
const DATA_LINE_RE = /^(.*?)\s{2,}([VM])\s{2,}(\d{1,3})\s{2,}(.+)$/;

function isNoiseLine(line) {
  const t = line.trim();
  // OJO: las líneas en blanco NO son "ruido" acá — son las que separan un
  // bloque (una persona) del siguiente más abajo. Si se filtraran acá,
  // todo el documento se agruparía en un solo bloque gigante.
  if (!t) return false;
  if (DATA_LINE_RE.test(line)) return false;
  if (/^Nombre\s+Sexo\s+Edad\s+Fecha de nacimiento$/i.test(t)) return true;
  if (/Para uso exclusivo de la Iglesia/i.test(t)) return true;
  if (/^Lista de miembros$/i.test(t)) return true;
  if (/^Recuento:\s*\d+$/i.test(t)) return true;
  // Encabezado de la unidad en la primera página, p.ej. "Valle Grande Ward (2097885)"
  if (/^[\wÀ-ÿ .'-]+\(\d+\)$/.test(t)) return true;
  return false;
}

// Recibe el Buffer del PDF subido. Devuelve { people, expectedCount, warnings }.
// `people`: [{ name, sex, birthDate }] — mismo shape que DIRECTORY_SEED.
export function parseMemberListPdfBuffer(buffer) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-pdf-'));
  try {
    const pdfPath = path.join(tmpDir, 'input.pdf');
    fs.writeFileSync(pdfPath, buffer);
    let text;
    try {
      text = execFileSync(PDFTOTEXT_BIN, ['-layout', pdfPath, '-'], {
        encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
      });
    } catch (err) {
      return {
        people: [],
        expectedCount: null,
        warnings: ['No se pudo leer el PDF (¿está corrupto, protegido, o no es un PDF con texto? — este importador es solo para el export oficial "Lista de miembros").'],
      };
    }

    let expectedCount = null;
    const recuentoMatch = text.match(/Recuento:\s*(\d+)/i);
    if (recuentoMatch) expectedCount = Number(recuentoMatch[1]);

    const lines = text.split('\n').filter((l) => !isNoiseLine(l));

    // Agrupa en bloques separados por líneas en blanco — lo que queda tras
    // filtrar el ruido son solo líneas de nombre/datos y blancos entre
    // personas (ver comentario de arriba sobre nombres cortados en varias
    // líneas SIN blanco de por medio dentro del mismo bloque).
    const blocks = [];
    let current = [];
    for (const raw of lines) {
      if (!raw.trim()) {
        if (current.length) blocks.push(current);
        current = [];
      } else {
        current.push(raw);
      }
    }
    if (current.length) blocks.push(current);

    const people = [];
    const warnings = [];
    for (const block of blocks) {
      const dataLineIdx = block.findIndex((l) => DATA_LINE_RE.test(l));
      if (dataLineIdx === -1) {
        warnings.push(`No se pudo leer una fila del PDF: "${block.join(' / ')}".`);
        continue;
      }
      const m = DATA_LINE_RE.exec(block[dataLineIdx]);
      const namePart = m[1].trim();
      const sex = m[2];
      const fechaStr = m[4].trim();
      const before = block.slice(0, dataLineIdx).map((l) => l.trim()).filter(Boolean);
      const after = block.slice(dataLineIdx + 1).map((l) => l.trim()).filter(Boolean);
      const name = [...before, namePart, ...after].join(' ').replace(/\s+/g, ' ').trim();
      if (!name) { warnings.push('Se encontró una fila sin nombre y se omitió.'); continue; }
      const birthDate = parseFechaChilena(fechaStr);
      if (!birthDate) warnings.push(`No se pudo leer la fecha de nacimiento de "${name}" ("${fechaStr}") — quedará sin fecha, se puede completar a mano después.`);
      people.push({ name, sex, birthDate });
    }

    if (expectedCount !== null && people.length !== expectedCount) {
      warnings.push(`El PDF dice "Recuento: ${expectedCount}" pero se lograron leer ${people.length} personas — revisá la lista con cuidado antes de aplicar cambios.`);
    }

    return { people, expectedCount, warnings };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
