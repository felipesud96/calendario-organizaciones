// Script de respaldo SOLO para "Crecimiento del Barrio": agrega los 6
// trimestres reales (T1 2025 – T2 2026) y la instantánea del barrio, SIN
// tocar usuarios, organizaciones ni ninguna otra colección.
//
// Por qué existe este archivo aparte de seed.js: seed.js también
// crea/actualiza usuarios de ejemplo (admin@ward.local, lider.*@ward.local,
// etc.) y, si esas cuentas YA existen (por ejemplo porque nunca cambiaste el
// correo del Administrador, solo la contraseña), seed.js les vuelve a poner
// la contraseña de ejemplo (admin123, lider123, ...) — que es pública en el
// código. Eso está bien en un servicio recién creado y vacío, pero es
// peligroso ejecutarlo sobre una base de datos que ya tiene cuentas reales.
//
// Este script hace SOLO la parte seguro-de-repetir: agrega los trimestres y
// la instantánea de "Crecimiento del Barrio" únicamente si todavía no
// existen (no pisa nada si el Obispado ya cargó o editó algo desde la app).
import { load, save, nextId } from './db.js';
import { validateQuarterPayload } from './wardGrowth.js';

function ind(pairs) {
  const o = {};
  for (const [n, real, pot] of pairs) o[String(n)] = { real, pot };
  return o;
}

const WARD_GROWTH_QUARTERS = [
  {
    label: 'T1 2025', year: 2025, quarter: 1,
    indicators: ind([
      [1,61,72],[2,50,76],[3,4,8],[4,39,53],[5,0,14],[6,11,15],[7,104,174],[8,7,null],[9,45,144],
      [10,177,null],[11,77,null],[12,10,11],[13,10,17],[14,36,39],[15,5,14],[16,47,60],[17,15,22],
      [18,11,15],[19,12,16],[20,20,31],[21,5,null],[22,27,28],[23,7,7],[24,5,6],[25,3,3],[26,3,6],
    ]),
    converts: [
      { name: 'Dominguez Vergara, Joisy Janeth', sex: 'M', age: 48, attended: true, hasCalling: true },
      { name: 'Guevara Garcia, Carlos', sex: 'V', age: 36, attended: true, hasCalling: true },
      { name: 'Guevara Robles, Mariana Itzel', sex: 'M', age: 9, attended: true, hasCalling: null },
      { name: 'Manrique Dominguez, Ariana Isamar', sex: 'M', age: 18, attended: true, hasCalling: true },
      { name: 'Manrique Dominguez, Heidy Naomi', sex: 'M', age: 11, attended: true, hasCalling: null },
      { name: 'Puebla Sandoval, Ihanko Samir', sex: 'V', age: 16, attended: true, hasCalling: true },
      { name: 'Riquelme Romero, Román Esteban', sex: 'V', age: 14, attended: true, hasCalling: true },
    ],
  },
  {
    label: 'T2 2025', year: 2025, quarter: 2,
    indicators: ind([
      [1,64,73],[2,53,79],[3,4,8],[4,41,56],[5,1,16],[6,10,14],[7,110,182],[8,10,null],[9,57,150],
      [10,186,null],[11,83,null],[12,4,12],[13,9,17],[14,36,41],[15,3,15],[16,49,64],[17,14,23],
      [18,10,14],[19,12,16],[20,22,30],[21,6,null],[22,27,30],[23,7,10],[24,1,7],[25,3,4],[26,3,7],
    ]),
    converts: [
      { name: 'Adana Gajardo, Isabel Margarita', sex: 'M', age: 38, attended: true, hasCalling: false },
      { name: 'Freire Rogel, Benjamin Andres', sex: 'V', age: 9, attended: true, hasCalling: null },
      { name: 'Fuentes Imiguala, Diego Adrián', sex: 'V', age: 30, attended: false, hasCalling: false },
      { name: 'Guevara Garcia, Carlos', sex: 'V', age: 37, attended: true, hasCalling: true },
      { name: 'Guevara Robles, Mariana Itzel', sex: 'M', age: 10, attended: true, hasCalling: null },
      { name: 'Molina Rodríguez, Leticia Fernanda', sex: 'M', age: 10, attended: false, hasCalling: null },
      { name: 'Pérez Rivas, Gabriangeli Paola', sex: 'M', age: 18, attended: true, hasCalling: false },
      { name: 'Puebla Sandoval, Ihanko Samir', sex: 'V', age: 16, attended: false, hasCalling: false },
      { name: 'Riquelme Romero, Román Esteban', sex: 'V', age: 15, attended: true, hasCalling: false },
      { name: 'Riveros Hernández, Damarys Jeannette', sex: 'M', age: 29, attended: true, hasCalling: false },
    ],
  },
  {
    label: 'T3 2025', year: 2025, quarter: 3,
    indicators: ind([
      [1,67,78],[2,60,88],[3,4,11],[4,45,61],[5,1,17],[6,9,13],[7,108,192],[8,6,null],[9,55,158],
      [10,199,null],[11,86,null],[12,2,12],[13,17,17],[14,27,45],[15,2,16],[16,37,68],[17,8,26],
      [18,13,13],[19,11,17],[20,22,30],[21,6,null],[22,24,34],[23,3,6],[24,1,3],[25,1,2],[26,0,3],
    ]),
    converts: [
      { name: 'Freire Rogel, Benjamin Andres', sex: 'V', age: 9, attended: true, hasCalling: null },
      { name: 'Fuentes Imiguala, Diego Adrian', sex: 'V', age: 31, attended: false, hasCalling: false },
      { name: 'Guevara Robles, Mariana Itzel', sex: 'M', age: 10, attended: true, hasCalling: null },
      { name: 'Molina Rodríguez, Leticia Fernanda', sex: 'M', age: 11, attended: false, hasCalling: null },
      { name: 'Riquelme Romero, Román Esteban', sex: 'V', age: 15, attended: true, hasCalling: true },
      { name: 'Riveros Hernández, Damarys Jeannette', sex: 'M', age: 30, attended: false, hasCalling: false },
    ],
  },
  {
    label: 'T4 2025', year: 2025, quarter: 4,
    indicators: ind([
      [1,50,60],[2,39,64],[3,2,10],[4,33,50],[5,1,18],[6,9,12],[7,88,171],[8,10,null],[9,45,134],
      [10,163,null],[11,77,null],[12,1,8],[13,0,13],[14,25,33],[15,3,17],[16,39,56],[17,10,26],
      [18,7,12],[19,11,16],[20,20,28],[21,3,null],[22,24,26],[23,7,10],[24,1,7],[25,1,3],[26,2,7],
    ]),
    converts: [
      { name: 'Carreño Abarca, Isidora Belén', sex: 'M', age: 12, attended: true, hasCalling: false },
      { name: 'Carreño Abarca, León Baltazar', sex: 'V', age: 8, attended: true, hasCalling: null },
      { name: 'Fuentes Imiguala, Diego Adrián', sex: 'V', age: 31, attended: false, hasCalling: false },
      { name: 'Gomez Victor, Teresa', sex: 'M', age: 58, attended: true, hasCalling: false },
      { name: 'González Cáceres, Beatriz Alejandra', sex: 'M', age: 25, attended: false, hasCalling: false },
      { name: 'Molina Rodríguez, Leticia Fernanda', sex: 'M', age: 11, attended: true, hasCalling: null },
      { name: 'Ortega Crisostomo, Santino', sex: 'V', age: 11, attended: true, hasCalling: null },
      { name: 'Riquelme Romero, Román Esteban', sex: 'V', age: 15, attended: true, hasCalling: true },
      { name: 'Riveros Hernández, Damarys Jeannette', sex: 'M', age: 30, attended: false, hasCalling: false },
      { name: 'Valderama Ponce, Lorenzo Alonso', sex: 'V', age: 22, attended: true, hasCalling: false },
    ],
  },
  {
    label: 'T1 2026', year: 2026, quarter: 1,
    indicators: ind([
      [1,51,61],[2,40,66],[3,3,10],[4,34,51],[5,1,18],[6,8,13],[7,77,164],[8,9,null],[9,32,139],
      [10,165,null],[11,79,null],[12,2,8],[13,4,15],[14,27,34],[15,3,17],[16,40,57],[17,12,27],
      [18,7,13],[19,15,18],[20,20,31],[21,3,null],[22,21,23],[23,5,9],[24,2,8],[25,1,3],[26,2,8],
    ]),
    converts: [
      { name: 'Carreño Abarca, Isidora Belén', sex: 'M', age: 12, attended: true, hasCalling: false },
      { name: 'Carreño Abarca, León Baltazar', sex: 'V', age: 9, attended: true, hasCalling: null },
      { name: 'Fuentes Imiguala, Diego Adrián', sex: 'V', age: 31, attended: false, hasCalling: false },
      { name: 'Gomez Victor, Teresa', sex: 'M', age: 58, attended: true, hasCalling: false },
      { name: 'González Cáceres, Beatriz Alejandra', sex: 'M', age: 25, attended: true, hasCalling: true },
      { name: 'Molina Rodríguez, Leticia Fernanda', sex: 'M', age: 11, attended: null, hasCalling: null },
      { name: 'Ortega Crisostomo, Santino', sex: 'V', age: 11, attended: null, hasCalling: null },
      { name: 'Riveros Hernández, Damarys Jeannette', sex: 'M', age: 30, attended: null, hasCalling: false },
      { name: 'Valderama Ponce, Lorenzo Alonso', sex: 'V', age: 23, attended: true, hasCalling: true },
    ],
  },
  {
    label: 'T2 2026', year: 2026, quarter: 2,
    indicators: ind([
      [1,53,65],[2,44,68],[3,3,10],[4,35,53],[5,0,18],[6,8,13],[7,88,169],[8,7,null],[9,35,143],
      [10,171,null],[11,83,null],[12,4,11],[13,1,15],[14,27,35],[15,4,18],[16,39,59],[17,8,28],
      [18,7,13],[19,12,18],[20,16,31],[21,4,null],[22,22,24],[23,4,7],[24,2,6],[25,1,3],[26,2,6],
    ]),
    converts: [
      { name: 'Atria, Paul Alex', sex: 'V', age: 57, attended: false, hasCalling: false },
      { name: 'Carreño Abarca, Isidora Belén', sex: 'M', age: 13, attended: true, hasCalling: false },
      { name: 'Carreño Abarca, León Baltazar', sex: 'V', age: 9, attended: true, hasCalling: null },
      { name: 'Gomez Victor, Teresa', sex: 'M', age: 59, attended: true, hasCalling: false },
      { name: 'González Cáceres, Beatriz Alejandra', sex: 'M', age: 26, attended: false, hasCalling: true },
      { name: 'Ortega Crisostomo, Santino', sex: 'V', age: 11, attended: false, hasCalling: null },
      { name: 'Valderama Ponce, Lorenzo Alonso', sex: 'V', age: 23, attended: true, hasCalling: true },
    ],
  },
];

const data = load();
let changed = false;

if (!Array.isArray(data.quarterlyStats) || data.quarterlyStats.length === 0) {
  const now = new Date().toISOString();
  data.quarterlyStats = [];
  for (const q of WARD_GROWTH_QUARTERS) {
    const err = validateQuarterPayload(q, data.quarterlyStats, null);
    if (err) throw new Error(`Siembra de Crecimiento del Barrio inválida (${q.label}): ${err}`);
    data.quarterlyStats.push({
      id: nextId(data, 'quarterlyStats'),
      ...q,
      createdAt: now, createdBy: null, updatedAt: now, updatedBy: null,
    });
  }
  changed = true;
  console.log(`Se agregaron ${data.quarterlyStats.length} trimestres de "Crecimiento del Barrio".`);
} else {
  console.log(`"Crecimiento del Barrio" ya tiene ${data.quarterlyStats.length} trimestre(s) cargado(s) — no se tocó nada.`);
}

if (!data.wardSnapshot) {
  data.wardSnapshot = {
    totalMembers: 175,
    men: { total: 54, highPriests: 15, elders: 21, futureElders: 18 },
    women: { total: 63 },
    youngMen: { total: 14, priests: 6, teachers: 6, deacons: 2 },
    youngWomen: { total: 16, guardiansOfLight: 2, heraldsOfHope: 5, faithBuilders: 9 },
    children3plus: 24,
    children0to2: 4,
    families: { total: 84, withoutMelchizedekHolder: 52, withYouth: 28, withChildren: 23, singleParent: 4 },
    adults: { married: 71, single36plus: 18, youngSingleAdults: 30 },
    recentConverts: { total: 7, adultMen: 2, adultWomen: 2, youngMen: 1, youngWomen: 1, children: 1 },
    ordinationStatus: { total: 3, ordained: 1, notOrdained: 2 },
    endowedAdults: { total: 68, withRecommend: 40, withoutRecommend: 28 },
    notIncluded: { total: 10, missingBirthdate: 0, baptizedNotConfirmed: 0, enrolled9plus: 10 },
    updatedAt: new Date().toISOString(),
    updatedBy: null,
  };
  changed = true;
  console.log('Se agregó la instantánea ("Miembros y familias") del barrio.');
} else {
  console.log('La instantánea del barrio ya existía — no se tocó nada.');
}

if (changed) {
  save(data);
  console.log('Guardado.');
} else {
  console.log('Nada que guardar (ya estaba todo cargado).');
}

console.log(`\nUsuarios en la base de datos (sin tocar): ${data.users.length}`);
