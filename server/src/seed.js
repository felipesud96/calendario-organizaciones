import { load, save, nextId } from './db.js';
import { hashPassword } from './auth.js';

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

save(data);

console.log('Datos de ejemplo creados/actualizados.\n');
console.log('Usuarios de prueba (usuario / contraseña / rol):');
for (const [email, pass, label] of credentials) {
  console.log(`  ${email.padEnd(38)} ${pass.padEnd(16)} ${label}`);
}
