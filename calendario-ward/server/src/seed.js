import { load, save, nextId } from './db.js';
import { hashPassword } from './auth.js';
import { validateQuarterPayload } from './wardGrowth.js';

const ORGS = [
  { name: 'Obispado', color: '#0EA5E9', allowsInterviews: true },
  { name: 'Cuórum de Élderes', color: '#6366F1', allowsInterviews: true },
  { name: 'Sociedad de Socorro', color: '#EC4899', allowsInterviews: true },
  { name: 'Escuela Dominical', color: '#F59E0B', allowsInterviews: false },
  { name: 'Hombres Jóvenes', color: '#10B981', allowsInterviews: false },
  { name: 'Mujeres Jóvenes', color: '#A855F7', allowsInterviews: false },
  { name: 'JAS', color: '#EF4444', allowsInterviews: false },
  { name: 'Primaria', color: '#F97316', allowsInterviews: false },
];

// Nombres de persona de ejemplo para cada líder — a propósito NO se llaman
// "Líder de <organización>": ese texto genérico solo confundía, dando la
// impresión de que el selector de responsable de un compromiso (módulo
// Reuniones) mostraba una etiqueta de rol en vez del nombre real de cada
// usuario. El código ya soportaba varios líderes por organización (no hay
// ningún límite de "un líder por organización" en ninguna parte); lo único
// que hacía falta era que los datos de ejemplo lo reflejaran.
const LEADER_NAMES = {
  'Obispado': 'Roberto Fuentes',
  'Cuórum de Élderes': 'Pedro Salinas',
  'Sociedad de Socorro': 'Daniela Rojas',
  'Escuela Dominical': 'Ana Torres',
  'Hombres Jóvenes': 'Diego Ramírez',
  'Mujeres Jóvenes': 'Valentina Reyes',
  'JAS': 'Felipe Contreras',
  'Primaria': 'Camila Vidal',
};

// Perfil (fecha de nacimiento + sexo) de cada líder principal — necesario
// para la elegibilidad de entrevistas (ver interviewEligibility en db.js).
// A propósito, Pedro Salinas (hombre adulto) y Daniela Rojas (mujer adulta)
// quedan como los ejemplos "positivos" de Cuórum de Élderes y Sociedad de
// Socorro respectivamente.
const LEADER_PROFILES = {
  'Obispado': { birthDate: '1978-03-10', sex: 'M' },
  'Cuórum de Élderes': { birthDate: '1985-07-22', sex: 'M' },
  'Sociedad de Socorro': { birthDate: '1980-11-05', sex: 'F' },
  'Escuela Dominical': { birthDate: '1990-02-14', sex: 'F' },
  'Hombres Jóvenes': { birthDate: '1988-09-30', sex: 'M' },
  'Mujeres Jóvenes': { birthDate: '1992-05-18', sex: 'F' },
  'JAS': { birthDate: '1965-01-01', sex: 'M' },
  'Primaria': { birthDate: '1995-08-08', sex: 'F' },
};

function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]+/g, '.');
}

const data = load();

// Organizaciones (idempotente: actualiza si ya existe por nombre)
const orgIds = {};
for (const org of ORGS) {
  let existing = data.organizations.find((o) => o.name === org.name);
  if (existing) {
    Object.assign(existing, org);
    orgIds[org.name] = existing.id;
  } else {
    const o = { id: nextId(data, 'organizations'), ...org };
    data.organizations.push(o);
    orgIds[org.name] = o.id;
  }
}

function upsertUser({ name, email, password, role, organizationId, isPresident = false, birthDate = null, sex = null }) {
  let existing = data.users.find((u) => u.email === email);
  if (existing) {
    Object.assign(existing, { name, role, organizationId, passwordHash: hashPassword(password), isPresident, birthDate, sex });
    return existing;
  }
  const u = {
    id: nextId(data, 'users'),
    name,
    email,
    passwordHash: hashPassword(password),
    role,
    organizationId: organizationId || null,
    phone: null,
    birthDate,
    sex,
    profilePhoto: null,
    isPresident,
    createdAt: new Date().toISOString(),
  };
  data.users.push(u);
  return u;
}

// Punto 8 (Coordinación de Ministración trimestral, Manual General 20.2.1):
// la app necesita identificar a la persona EXACTA que preside cada una de
// estas tres organizaciones (no "un líder cualquiera" de la organización) —
// ver isPresident en users.js/stake.js. En los datos de ejemplo, el líder
// principal de cada una queda marcado como su presidente/titular.
const PRESIDENT_ORGS = ['Obispado', 'Cuórum de Élderes', 'Sociedad de Socorro'];

const credentials = [];

upsertUser({ name: 'Administrador General', email: 'admin@ward.local', password: 'admin123', role: 'admin', organizationId: null, birthDate: '1975-06-01', sex: 'M' });
credentials.push(['admin@ward.local', 'admin123', 'Administrador']);

for (const org of ORGS) {
  const email = `lider.${slugify(org.name)}@ward.local`;
  const name = LEADER_NAMES[org.name] || `Líder de ${org.name}`;
  const isPresident = PRESIDENT_ORGS.includes(org.name);
  const profile = LEADER_PROFILES[org.name] || {};
  upsertUser({ name, email, password: 'lider123', role: 'leader', organizationId: orgIds[org.name], isPresident, ...profile });
  credentials.push([email, 'lider123', `${name} (Líder de ${org.name})${isPresident ? ' · ★ Presidente' : ''}`]);
}

// Segundo líder de ejemplo en Cuórum de Élderes — a propósito, para mostrar
// que una organización puede tener más de un líder (ej. presidente y
// consejero) y que cada uno aparece en los selectores de responsable (módulo
// Reuniones) por su propio nombre, no por un rótulo genérico compartido. A
// propósito también se deja SIN fecha de nacimiento ni sexo (perfil
// incompleto), para mostrar el aviso obligatorio de "completa tu perfil" que
// le aparece a cualquier cuenta creada antes de que existiera este campo.
upsertUser({
  name: 'Ignacio Herrera',
  email: 'lider2.cuorum.de.elderes@ward.local',
  password: 'lider123',
  role: 'leader',
  organizationId: orgIds['Cuórum de Élderes'],
});
credentials.push(['lider2.cuorum.de.elderes@ward.local', 'lider123', 'Ignacio Herrera (Líder de Cuórum de Élderes) · perfil incompleto a propósito']);

// Miembro de ejemplo — a propósito un JOVEN (Manual General: un joven o una
// joven solo puede agendar entrevista con el Obispado, no con Cuórum de
// Élderes ni Sociedad de Socorro), para poder mostrar esa restricción en el
// auto-agendamiento (Entrevistas → "Mis Actividades").
upsertUser({ name: 'Miembro de Ejemplo', email: 'miembro@ward.local', password: 'miembro123', role: 'member', organizationId: null, birthDate: '2010-01-15', sex: 'M' });
credentials.push(['miembro@ward.local', 'miembro123', 'Miembro (joven de ejemplo, 16 años)']);

// Limpieza: el rol "secretario" se fusionó con "líder" — elimina las cuentas
// de ejemplo de secretarios que hayan quedado de una siembra anterior.
data.users = data.users.filter((u) => !u.email.startsWith('secretario.'));

// Categoría de presupuesto de ejemplo para gastos que no son de una sola
// organización (ej. una actividad de todo el barrio). El líder de Obispado
// puede crear más desde el módulo de Presupuesto.
if (!data.budgetCategories.some((c) => c.name === 'Actividades de Barrio')) {
  data.budgetCategories.push({
    id: nextId(data, 'budgetCategories'),
    name: 'Actividades de Barrio',
    createdBy: null,
    createdAt: new Date().toISOString(),
  });
}

// Enlace del calendario de Estaca (agrupa varios barrios): sus actividades
// tienen prioridad y bloquean la creación de actividades de organizaciones o
// de todo el Barrio que choquen con ellas (ver stakeCalendar.js). Se deja
// configurado por defecto; el Administrador puede cambiarlo desde
// Administración → Estaca.
if (!data.stakeCalendar || !data.stakeCalendar.url) {
  data.stakeCalendar = {
    ...data.stakeCalendar,
    url: 'https://churchofjesuschrist.org/church-calendar/services/ext/v3.0/export/ical/subscribe/c1fcb8a3953a4518b977d428ae968352',
    displayName: 'Estaca',
    lastSyncedAt: null,
    lastSyncOk: null,
    lastSyncError: null,
    eventCount: 0,
    nonBlockingKeywords: data.stakeCalendar?.nonBlockingKeywords || ['entrevista', 'presidencia de estaca', 'sumo consejo', 'presentación anual'],
    showNonBlockingEvents: typeof data.stakeCalendar?.showNonBlockingEvents === 'boolean' ? data.stakeCalendar.showNonBlockingEvents : true,
  };
}

// Módulo "Crecimiento del Barrio": datos REALES del barrio (extraídos de 7
// reportes oficiales trimestrales), no datos de ejemplo inventados — por
// eso el guard de idempotencia es "solo si está vacío" (a diferencia de
// organizaciones/usuarios de arriba, que se actualizan siempre): si el
// Obispado ya cargó/editó algo desde la app, la siembra NUNCA debe pisarlo.
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
}

save(data);

console.log('Datos de ejemplo creados/actualizados.\n');
console.log('Usuarios de prueba (usuario / contraseña / rol):');
for (const [email, pass, label] of credentials) {
  console.log(`  ${email.padEnd(38)} ${pass.padEnd(16)} ${label}`);
}
