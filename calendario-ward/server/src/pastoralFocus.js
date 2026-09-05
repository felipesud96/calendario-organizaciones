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
// para hombres adultos (18+) — así lo pidió el Obispado.
export function isAdultMale(member) {
  const age = ageFromBirthDate(member.birthDate);
  return member.sex === 'V' && age !== null && age >= 18;
}
