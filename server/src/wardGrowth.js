// Módulo "Estadísticas del Barrio" (Crecimiento del Barrio): lógica pura
// (sin Express) para los indicadores trimestrales de crecimiento que el
// Obispado ya venía siguiendo fuera de la app, a partir de los reportes
// oficiales trimestrales — ver routes/wardGrowth.js para la API y
// app.js/renderWardGrowthView para la pantalla.
//
// Carga: siempre manual, por formulario, validada acá — ESE es el único
// camino que efectivamente guarda algo en quarterlyStats/wardSnapshot.
// Existe también un asistente que sube el PDF del informe oficial y
// pre-llena el mismo formulario (ver server/src/pdfExtract.js y la ruta
// POST /api/ward-growth/parse-pdf) — la decisión consciente de este
// proyecto sigue siendo la misma de siempre, solo que ahora tiene un
// matiz: el parseo de PDF en sí NUNCA escribe acá directamente ni evita
// que un humano revise. El formato del reporte oficial es demasiado
// específico (y, en la práctica, viene sin texto extraíble — son PDFs
// "impresos" a puro trazo vectorial, leídos por OCR) como para confiar en
// un parseo silencioso: un error de lectura ahí sería peligroso para datos
// que se usan en decisiones de liderazgo. Por eso el asistente solo
// PRE-LLENA el formulario (marcado visualmente como "completado
// automáticamente, revisar"); sigue siendo este mismo validateQuarterPayload
// el que corre justo antes de guardar, y sigue siendo el humano quien
// aprieta "Guardar".

// Las 6 categorías del reporte oficial, EN ESTE ORDEN EXACTO (no reordenar:
// así vienen agrupados los 26 indicadores en el reporte trimestral real que
// usa el Obispado) — cada una con su rango de números de indicador.
export const WARD_GROWTH_CATEGORIES = [
  { key: 'conversion', label: 'Indicadores de conversión y del crecimiento de la Iglesia', range: [1, 9] },
  { key: 'members', label: 'Miembros / Familias', range: [10, 13] },
  { key: 'adults', label: 'Adultos', range: [14, 17] },
  { key: 'youth', label: 'Jóvenes', range: [18, 20] },
  { key: 'children', label: 'Niños', range: [21, 22] },
  { key: 'converts', label: 'Conversos', range: [23, 26] },
];

function categoryFor(number) {
  const cat = WARD_GROWTH_CATEGORIES.find((c) => number >= c.range[0] && number <= c.range[1]);
  return cat ? cat.key : null;
}

// Los 26 indicadores, en el orden exacto del reporte. `hasPotential` marca
// si ese indicador trae una columna "Potencial" además de "Real" (algunos,
// como totales simples, no la tienen — quedan con pot:null en cada
// trimestre). Las etiquetas son las que el Obispado usa al hablar de cada
// una; varias ya se verificaron contra el análisis previo del usuario
// (Sellados, Investidos, Melquisedec/Futuros Élderes/Mujeres/JAS asisten,
// HJ/MJ asisten, Jóvenes con recomendación, Niños de Primaria asisten) — no
// cambiar esos números de indicador sin volver a validar la comparativa.
export const INDICATOR_DEFS = [
  { number: 1, label: 'Miembros sellados en el templo', hasPotential: true },
  { number: 2, label: 'Miembros investidos', hasPotential: true },
  { number: 3, label: 'Bautismos y confirmaciones de conversos', hasPotential: true },
  { number: 4, label: 'Miembros que participan en la obra misional', hasPotential: true },
  { number: 5, label: 'Matrimonios sellados en el templo (este trimestre)', hasPotential: true },
  { number: 6, label: 'Miembros menos activos reactivados', hasPotential: true },
  { number: 7, label: 'Asistencia a la reunión sacramental', hasPotential: true },
  { number: 8, label: 'Miembros con bautismo/confirmación agendada', hasPotential: false },
  { number: 9, label: 'Adultos con recomendación vigente para el templo', hasPotential: true },
  { number: 10, label: 'Total de miembros registrados', hasPotential: false },
  { number: 11, label: 'Total de familias', hasPotential: false },
  { number: 12, label: 'Entrevistas de ministración completadas — Cuórum de Élderes', hasPotential: true },
  { number: 13, label: 'Entrevistas de ministración completadas — Sociedad de Socorro', hasPotential: true },
  { number: 14, label: 'Cuórum de Élderes (Melquisedec) — asisten', hasPotential: true },
  { number: 15, label: 'Futuros Élderes — asisten', hasPotential: true },
  { number: 16, label: 'Sociedad de Socorro (Mujeres) — asisten', hasPotential: true },
  { number: 17, label: 'Jóvenes Adultos Solteros (JAS) — asisten', hasPotential: true },
  { number: 18, label: 'Hombres Jóvenes (HJ) — asisten', hasPotential: true },
  { number: 19, label: 'Mujeres Jóvenes (MJ) — asisten', hasPotential: true },
  { number: 20, label: 'Jóvenes con recomendación vigente para el templo', hasPotential: true },
  { number: 21, label: 'Niños de Primaria bautizados este trimestre', hasPotential: false },
  { number: 22, label: 'Niños de Primaria — asisten', hasPotential: true },
  { number: 23, label: 'Conversos que asisten regularmente', hasPotential: true },
  { number: 24, label: 'Conversos con llamamiento', hasPotential: true },
  { number: 25, label: 'Conversos con progreso hacia el templo', hasPotential: true },
  { number: 26, label: 'Conversos visitados por sus ministrantes', hasPotential: true },
].map((d) => ({ ...d, category: categoryFor(d.number) }));

export const INDICATOR_NUMBERS = INDICATOR_DEFS.map((d) => d.number);

export function indicatorDef(number) {
  return INDICATOR_DEFS.find((d) => d.number === Number(number)) || null;
}

// Subconjunto usado específicamente por el gráfico "Comparativa entre
// organizaciones" (barras horizontales, % de cambio del primer al último
// trimestre disponible): a propósito NO son "todos los indicadores con
// potencial" — se excluyen a mano las Entrevistas de Ministración (12, 13)
// y Conversos (23-26), porque son denominadores muy chicos (7, 11, etc.) que
// hacen que el % salte muchísimo de un trimestre a otro por pura casualidad
// estadística, no porque la organización realmente haya cambiado — eso
// distorsionaría el ranking y taparía las bajas reales de asistencia de las
// organizaciones (Cuórum, Sociedad de Socorro, HJ, MJ, JAS, Primaria) que es
// lo que este gráfico en particular quiere mostrar. Esos dos grupos ya
// tienen su propio gráfico dedicado (Entrevistas de Ministración; la tabla
// de seguimiento de Conversos).
export const ORG_COMPARATIVA_INDICATORS = [1, 2, 14, 15, 16, 17, 18, 19, 20, 22];

export function sortedQuarters(quarters) {
  return [...(quarters || [])].sort((a, b) => (a.year - b.year) || (a.quarter - b.quarter));
}

function pct(real, pot) {
  if (pot === null || pot === undefined || Number(pot) === 0) return null;
  if (real === null || real === undefined) return null;
  return Math.round((Number(real) / Number(pot)) * 100);
}

export function pctForIndicator(quarter, number) {
  const entry = quarter?.indicators?.[String(number)];
  if (!entry) return null;
  return pct(entry.real, entry.pot);
}

// % de cambio (en puntos porcentuales) entre dos trimestres, para el
// subconjunto de indicadores dado (por defecto, ORG_COMPARATIVA_INDICATORS).
// Redondea el % en cada punta por separado y resta — así el "-39" que ya
// verificó el usuario en su análisis previo (JAS: T1 2025 → T2 2026) sale
// exacto. Ordenado por magnitud de cambio descendente (la baja/subida más
// grande primero).
export function comparativa(quarterFirst, quarterLast, numbers = ORG_COMPARATIVA_INDICATORS) {
  if (!quarterFirst || !quarterLast) return [];
  const rows = [];
  for (const number of numbers) {
    const def = indicatorDef(number);
    const pctFirst = pctForIndicator(quarterFirst, number);
    const pctLast = pctForIndicator(quarterLast, number);
    if (pctFirst === null || pctLast === null) continue; // sin potencial en algún extremo: no comparable
    const diff = pctLast - pctFirst;
    rows.push({
      number, label: def?.label || `Indicador ${number}`, category: def?.category || null,
      pctFirst, pctLast, diff, magnitude: Math.abs(diff),
    });
  }
  rows.sort((a, b) => b.magnitude - a.magnitude);
  return rows;
}

// Seguimiento de conversos: junta las filas de "converts" de TODOS los
// trimestres (en orden cronológico) por nombre — comparado de forma
// insensible a tildes/mayúsculas (ver convertKey() abajo), justamente
// porque en la práctica SÍ pasa que el mismo converso queda tipeado con y
// sin tilde en trimestres distintos (carga manual en uno, OCR del asistente
// de PDF en otro) y una clave exacta lo partía en dos personas de
// seguimiento separadas — se detectó con datos reales (Fuentes Imiguala,
// Diego Adrián/Adrian) y es justamente el tipo de error que este mismo
// módulo existe para prevenir. La comparación se normaliza; lo que se
// GUARDA y se MUESTRA no: cada aparición histórica conserva la ortografía
// exacta con la que se cargó ese trimestre, y la fila de seguimiento se
// muestra con la ortografía de la aparición MÁS RECIENTE (nunca se
// reescribe un trimestre viejo). Sigue sin intentar fusionar nombres que
// solo "se parecen" (dos personas distintas con apellidos parecidos siguen
// siendo dos filas) — únicamente colapsa variantes de tilde/mayúscula del
// mismo nombre normalizado.
//
// Heurística de estado (aproximada, documentada para quien lea el código y
// para la nota que se muestra en el cliente junto a la tabla):
//  - 'critical' si sus 2 apariciones más recientes NO fueron confirmadas
//    como asistencia (attended !== true — o sea, "No" o el dato vino en
//    blanco/"---"): probablemente perdido/a.
//  - 'warning' (nuevo/a) si es su ÚNICA aparición y es justo en el trimestre
//    más reciente, y no asistió esa vez.
//  - 'warning' (sin llamamiento) si tiene 12 años o más, asistió (según
//    dato confirmado) en sus últimas 1-2 apariciones, pero nunca ha tenido
//    llamamiento (hasCalling===false en TODAS sus apariciones registradas).
//  - 'good' si la mayoría de sus apariciones registradas fueron asistencia
//    confirmada.
//  - 'warning' (señal mixta) en cualquier otro caso.
// Clave de comparación para el seguimiento de conversos: NFD + sacar
// diacríticos + minúsculas + espacios colapsados. A propósito NO es el
// nombre que se muestra ni el que se guarda (eso sigue siendo el texto
// exacto de cada trimestre, tal cual vino en cada reporte) — es solo la
// clave interna para decidir si dos filas de "converts" de trimestres
// distintos son la misma persona. Bug real encontrado: un mismo converso
// quedaba spliteado en dos filas de seguimiento porque un trimestre lo
// tenía cargado sin tilde ("Diego Adrian", como vino en esa fuente/OCR) y
// los demás con tilde ("Diego Adrián") — con clave exacta, dos identidades
// separadas; con esta normalización, una sola. Sigue sin normalizar dos
// personas DISTINTAS con el mismo nombre normalizado en dos apellidos
// distintos de verdad (eso seguiría siendo un problema de datos de origen,
// no algo que este normalizado deba intentar resolver).
function convertKey(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

export function computeConvertTracking(quarters) {
  const ordered = sortedQuarters(quarters);
  const lastLabel = ordered.length ? ordered[ordered.length - 1].label : null;
  const people = new Map();
  for (const q of ordered) {
    for (const c of (q.converts || [])) {
      if (!c || !c.name) continue;
      const key = convertKey(c.name);
      let p = people.get(key);
      if (!p) { p = { name: c.name, sex: c.sex, age: c.age, appearances: [] }; people.set(key, p); }
      p.name = c.name; // se muestra con la ortografía del trimestre MÁS RECIENTE
      p.sex = c.sex;
      p.age = c.age; // se queda con el dato de la aparición más reciente
      p.appearances.push({ label: q.label, attended: c.attended ?? null, hasCalling: c.hasCalling ?? null });
    }
  }
  const results = [];
  for (const p of people.values()) {
    const n = p.appearances.length;
    const last2 = p.appearances.slice(-2);
    const lastOne = p.appearances[n - 1];
    let status, statusLabel;
    if (n >= 2 && last2.every((a) => a.attended !== true)) {
      status = 'critical';
      statusLabel = 'En riesgo — probablemente perdido/a';
    } else if (n === 1 && lastOne.label === lastLabel && lastOne.attended === false) {
      status = 'warning';
      statusLabel = 'Nuevo/a — necesita seguimiento';
    } else if (
      p.age !== null && p.age !== undefined && p.age >= 12
      && last2.every((a) => a.attended === true)
      && p.appearances.every((a) => a.hasCalling === false)
    ) {
      status = 'warning';
      statusLabel = 'Asiste con regularidad, sin llamamiento — oportunidad';
    } else {
      const trueCount = p.appearances.filter((a) => a.attended === true).length;
      if (trueCount > n / 2) { status = 'good'; statusLabel = 'Buen camino — activo/a'; }
      else { status = 'warning'; statusLabel = 'Señal mixta — revisar la secuencia'; }
    }
    results.push({
      name: p.name,
      sex: p.sex,
      age: p.age,
      quarters: p.appearances.map((a) => a.label),
      attended: p.appearances.map((a) => a.attended),
      hasCalling: p.appearances.map((a) => a.hasCalling),
      status,
      statusLabel,
    });
  }
  return results.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

// ---------------- Validación de entrada (compartida por POST/PUT) ----------------

function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

export function validateIndicators(indicators) {
  if (!indicators || typeof indicators !== 'object') return 'Faltan los indicadores';
  for (const number of INDICATOR_NUMBERS) {
    const entry = indicators[String(number)];
    if (!entry || typeof entry !== 'object') return `Falta el indicador ${number}`;
    if (!isFiniteNumber(entry.real) || entry.real < 0) return `El valor "Real" del indicador ${number} debe ser un número`;
    if (entry.pot !== null && (!isFiniteNumber(entry.pot) || entry.pot < 0)) return `El valor "Potencial" del indicador ${number} debe ser un número o vacío`;
  }
  return null;
}

export function validateConverts(converts) {
  if (!Array.isArray(converts)) return 'Los conversos deben ser una lista';
  for (const c of converts) {
    if (!c || typeof c.name !== 'string' || !c.name.trim()) return 'Cada converso necesita un nombre';
    if (c.sex !== 'M' && c.sex !== 'V') return `Sexo inválido para ${c.name} (debe ser M o V)`;
    if (!Number.isInteger(c.age) || c.age < 0) return `Edad inválida para ${c.name}`;
    if (c.attended !== true && c.attended !== false && c.attended !== null) return `"Asistió" inválido para ${c.name}`;
    if (c.hasCalling !== true && c.hasCalling !== false && c.hasCalling !== null) return `"Llamamiento" inválido para ${c.name}`;
  }
  return null;
}

// Valida un payload de trimestre completo (creación o edición). `existing`
// es la lista de trimestres YA guardados (para chequear duplicado de
// año+trimestre); `editingId` se pasa en PUT para no chocar consigo mismo.
export function validateQuarterPayload(body, existing, editingId) {
  const label = String(body?.label || '').trim();
  const year = Number(body?.year);
  const quarter = Number(body?.quarter);
  if (!label) return 'Falta la etiqueta (ej: "T1 2025")';
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return 'Año inválido';
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) return 'El trimestre debe ser 1, 2, 3 o 4';
  const dup = (existing || []).some((q) => q.year === year && q.quarter === quarter && q.id !== editingId);
  if (dup) return `Ya existe un trimestre cargado para ${label} (año ${year}, T${quarter})`;
  const indicatorsError = validateIndicators(body?.indicators);
  if (indicatorsError) return indicatorsError;
  const convertsError = validateConverts(body?.converts);
  if (convertsError) return convertsError;
  return null;
}
