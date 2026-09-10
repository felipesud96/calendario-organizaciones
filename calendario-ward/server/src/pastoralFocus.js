// Lógica pura del módulo "Directorio" / "Enfoque Ministración" — separada
// de las rutas (mismo patrón que wardGrowth.js) para poder probarla/leerla
// sin el ruido de requireRole/sendJson.
//
// El "cuadrante" replica EXACTO la fórmula que se validó a mano en la
// planilla Excel (misma para las 50 personas, sin constantes por fila):
//   "Cumple todo" = sin convenio pendiente Y recomendación vigente Y tiene
//   llamamiento.
//   - Asistencia distinta de "Bajo" (Medio o Alto):
//       Cumple todo -> Retener
//       No cumple todo -> Enfoque
//   - Asistencia "Bajo":
//       Cumple todo -> Actividad
//       No cumple todo -> Rescatar

export const ASISTENCIA_VALUES = ['Alto', 'Medio', 'Bajo'];
export const CUADRANTES = ['Rescatar', 'Enfoque', 'Retener', 'Actividad'];

// Punto 14 — antes "convenios al día" era un solo casillero (todo o nada);
// ahora se desglosa en los 3 convenios concretos que de verdad se
// evalúan: Investidura del templo y Sellamiento (cualquier adulto),
// Ordenación al sacerdocio (solo hombres — para mujeres se fuerza a 'na',
// ver PUT /api/pastoral-focus/:memberId en routes/directory.js). Cada uno
// puede ser 'si' (al día), 'no' (pendiente) o 'na' (no aplica — ej.
// Sellamiento para quien no está casado/a).
export const CONVENIO_KEYS = ['investidura', 'sellamiento', 'ordenacion'];
export const CONVENIO_STATUS_VALUES = ['si', 'no', 'na'];

// Deriva el booleano agregado `faltaConvenio` (el que sigue usando
// computeCuadrante de abajo, sin tocar su fórmula) a partir del detalle
// granular: falta si CUALQUIERA de los convenios que sí aplican a esta
// persona quedó en 'no' — los marcados 'na' nunca cuentan en contra.
export function faltaConvenioFromChecklist(convenios) {
  if (!convenios) return null;
  return CONVENIO_KEYS.some((k) => convenios[k] === 'no');
}

export function computeCuadrante({ asistencia, tieneLlamamiento, faltaConvenio, recomendacionVigente }) {
  const cumpleTodo = !faltaConvenio && !!recomendacionVigente && !!tieneLlamamiento;
  if (asistencia === 'Bajo') return cumpleTodo ? 'Actividad' : 'Rescatar';
  return cumpleTodo ? 'Retener' : 'Enfoque';
}

// Edad calculada al vuelo desde la fecha de nacimiento (nunca se guarda un
// número de edad fijo, que quedaría desactualizado con el tiempo).
export function ageFromBirthDate(birthDate, atDate = new Date()) {
  if (!birthDate) return null;
  const b = new Date(`${birthDate}T00:00:00`);
  if (Number.isNaN(b.getTime())) return null;
  let age = atDate.getFullYear() - b.getFullYear();
  const m = atDate.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && atDate.getDate() < b.getDate())) age -= 1;
  return age;
}

// Organización "probable" según sexo + edad — solo para agrupar/filtrar el
// Directorio (Primaria, Hombres/Mujeres Jóvenes, Cuórum de Élderes,
// Sociedad de Socorro). Es una estimación: no reemplaza el llamamiento real
// de cada persona, que vive en `users`, no en el Directorio.
export function categoryFor(member) {
  const age = ageFromBirthDate(member.birthDate);
  if (age === null) return 'Sin clasificar';
  if (age <= 11) return 'Primaria';
  if (age <= 17) return member.sex === 'V' ? 'Hombres Jóvenes' : 'Mujeres Jóvenes';
  return member.sex === 'V' ? 'Cuórum de Élderes' : 'Sociedad de Socorro';
}

// El seguimiento por cuadrante (Enfoque Ministración) es, a propósito, solo
// para adultos (18+) — así lo pidió el Obispado. Arrancó siendo solo para
// hombres (Cuórum de Élderes); después se extendió con el mismo modelo
// para mujeres adultas (Sociedad de Socorro) — cada presidencia ve y edita
// solo la mitad que le corresponde (ver isMinisteringFocusLeader /
// isMinisteringFocusLeaderMujeres en routes/directory.js).
export function isAdultMale(member) {
  const age = ageFromBirthDate(member.birthDate);
  return member.sex === 'V' && age !== null && age >= 18;
}

export function isAdultFemale(member) {
  const age = ageFromBirthDate(member.birthDate);
  return member.sex === 'M' && age !== null && age >= 18;
}
