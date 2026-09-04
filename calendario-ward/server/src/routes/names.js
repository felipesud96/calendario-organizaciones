import { sendJson } from '../router.js';
import { load } from '../db.js';
import { requireAuth } from '../guard.js';

// Sugerencias de "nombres ya usados" para autocompletar campos de texto
// libre que NO vienen de un <select> de usuarios registrados: adultos
// supervisores de una actividad, quién presenta un tema de una acta,
// persona/familia de un caso de Bienestar, y el líder que entrevista
// cuando lo escribe un Administrador (agendando por otra persona). Mismo
// espíritu que ya usa el módulo de Aseo con las familias — en vez de
// obligar a re-escribir un nombre que ya se usó antes, se sugiere de una
// lista derivada de lo que ya existe, sin mantener un catálogo aparte ni
// forzar a nadie a registrarse como usuario (muchas de estas personas no
// lo son: un padre que ayuda a supervisar, un miembro de otra unidad, etc).

function normalizeSearchText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// Junta nombres desde varias fuentes sin duplicar por mayúsculas/tildes
// distintas (se queda con la primera forma de escritura que encuentra) y
// los ordena por cuántas veces aparece cada uno — de más a menos usado —
// para que las sugerencias más probables salgan primero en la lista.
function dedupByFrequency(rawNames) {
  const seen = new Map(); // norm -> { name, count }
  for (const raw of rawNames) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const norm = normalizeSearchText(name);
    if (!seen.has(norm)) seen.set(norm, { name, count: 0 });
    seen.get(norm).count += 1;
  }
  return [...seen.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es'))
    .map((x) => x.name);
}

export function registerNamesRoutes(router) {
  router.get('/api/names/suggestions', requireAuth(async (req, res) => {
    const data = load();
    const supervisingAdults = dedupByFrequency(data.events.flatMap((e) => e.supervisingAdults || []));
    const presenters = dedupByFrequency(data.meetings.flatMap((m) => (m.agendaItems || []).map((a) => a.presenter)));
    const welfareMembers = dedupByFrequency((data.welfareCases || []).map((c) => c.memberName));
    const interviewers = dedupByFrequency(data.interviews.map((iv) => iv.interviewerName));
    sendJson(res, 200, { supervisingAdults, presenters, welfareMembers, interviewers });
  }));
}
