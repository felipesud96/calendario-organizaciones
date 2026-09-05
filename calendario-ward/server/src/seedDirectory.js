// Script de respaldo SOLO para "Directorio" / "Enfoque Ministración": carga
// la lista de miembros del barrio (reporte oficial "Lista de miembros",
// exportado el 5 sept 2026) y el Enfoque Ministración inicial (los hombres
// adultos del análisis de Excel que se pudieron enlazar sin ambigüedad),
// SIN tocar usuarios, organizaciones ni ninguna otra colección.
//
// Igual que seedWardGrowthOnly.js: es seguro correrlo más de una vez —
// solo agrega el Directorio si todavía está vacío, y solo agrega el
// Enfoque Ministración de una persona si esa persona no tenía ya uno
// cargado (así no pisa evaluaciones que ya se hayan actualizado a mano
// desde la app).
import { load, save, nextId } from './db.js';
import { DIRECTORY_SEED, PASTORAL_FOCUS_SEED } from './directorySeedData.js';

const data = load();
let changed = false;

if (data.directoryMembers.length === 0) {
  const now = new Date().toISOString();
  for (const m of DIRECTORY_SEED) {
    data.directoryMembers.push({
      id: nextId(data, 'directoryMembers'),
      name: m.name,
      sex: m.sex,
      birthDate: m.birthDate,
      source: 'import-2026-09-05',
      createdAt: now,
    });
  }
  changed = true;
  console.log(`Se agregaron ${DIRECTORY_SEED.length} personas al Directorio.`);
} else {
  console.log(`El Directorio ya tenía ${data.directoryMembers.length} personas cargadas — no se tocó nada.`);
}

let focusAdded = 0;
let focusSkippedNoMatch = 0;
let focusSkippedExisting = 0;
for (const p of PASTORAL_FOCUS_SEED) {
  const member = data.directoryMembers.find((m) => m.name === p.memberName);
  if (!member) { focusSkippedNoMatch += 1; continue; }
  if (data.pastoralFocus.some((f) => f.memberId === member.id)) { focusSkippedExisting += 1; continue; }
  const now = new Date().toISOString();
  data.pastoralFocus.push({
    id: nextId(data, 'pastoralFocus'),
    memberId: member.id,
    asistencia: p.asistencia,
    tieneLlamamiento: p.tieneLlamamiento,
    faltaConvenio: p.faltaConvenio,
    recomendacionVigente: p.recomendacionVigente,
    updatedAt: now,
    updatedBy: null,
    updatedByName: 'Importación inicial (Excel de Cuadrantes)',
    history: [],
  });
  focusAdded += 1;
  changed = true;
}
console.log(`Enfoque Ministración: ${focusAdded} agregados, ${focusSkippedExisting} ya existían, ${focusSkippedNoMatch} sin coincidencia en el Directorio.`);

if (changed) {
  save(data);
  console.log('Guardado.');
} else {
  console.log('Nada que guardar (ya estaba todo cargado).');
}

console.log(`\nDirectorio: ${data.directoryMembers.length} personas. Usuarios (sin tocar): ${data.users.length}.`);
