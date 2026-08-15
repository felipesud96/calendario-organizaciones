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

function upsertUser({ name, email, password, role, organizationId }) {
  let existing = data.users.find((u) => u.email === email);
  if (existing) {
    Object.assign(existing, { name, role, organizationId, passwordHash: hashPassword(password) });
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
    createdAt: new Date().toISOString(),
  };
  data.users.push(u);
  return u;
}

const credentials = [];

upsertUser({ name: 'Administrador General', email: 'admin@ward.local', password: 'admin123', role: 'admin', organizationId: null });
credentials.push(['admin@ward.local', 'admin123', 'Administrador']);

for (const org of ORGS) {
  const email = `lider.${slugify(org.name)}@ward.local`;
  upsertUser({ name: `Líder de ${org.name}`, email, password: 'lider123', role: 'leader', organizationId: orgIds[org.name] });
  credentials.push([email, 'lider123', `Líder de ${org.name}`]);
}

upsertUser({ name: 'Miembro de Ejemplo', email: 'miembro@ward.local', password: 'miembro123', role: 'member', organizationId: null });
credentials.push(['miembro@ward.local', 'miembro123', 'Miembro']);

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

save(data);

console.log('Datos de ejemplo creados/actualizados.\n');
console.log('Usuarios de prueba (usuario / contraseña / rol):');
for (const [email, pass, label] of credentials) {
  console.log(`  ${email.padEnd(38)} ${pass.padEnd(16)} ${label}`);
}
