// ----------------------------------------------------------------------
// TIPOS DE ENTREVISTA Y QUIÉN PUEDE HACERLAS (Manual General, 31.2.2)
// ----------------------------------------------------------------------
// Fuente: Manual General, capítulo 31 "Entrevistas y otras reuniones con
// los miembros", tabla 31.2.2 — solo la parte que corresponde al BARRIO
// (lo que hace la presidencia de estaca no se agenda en esta app).
//
//   quien: 'obispo'      → solo el obispo
//          'obispado'    → el obispo o un consejero asignado
//          'presidencia' → presidencias de Cuórum de Élderes / Sociedad de Socorro
//          'cualquiera'  → sin restricción (entrevista general / de seguimiento)
//
// Si la Iglesia actualiza el Manual, basta con ajustar esta tabla.
// ----------------------------------------------------------------------
import { normNombre } from './db.js';

export const TIPOS_ENTREVISTA = [
  { key: 'general', label: 'General / seguimiento', quien: 'cualquiera' },

  // --- Solo el obispo ---
  { key: 'recomendacion_primera', label: 'Recomendación del templo — primera vez (investidura o sellamiento propios)', quien: 'obispo', ref: '26.3.3' },
  { key: 'recomendacion_converso', label: 'Recomendación del templo — miembro recién bautizado', quien: 'obispo', ref: '26.5.1' },
  { key: 'ordenacion_presbitero', label: 'Ordenación al oficio de presbítero', quien: 'obispo', ref: '18.10.2' },
  { key: 'ordenacion_converso', label: 'Ordenación al Sacerdocio Aarónico de un converso', quien: 'obispo', ref: '38.2.9.1' },
  { key: 'recomendacion_elder', label: 'Recomendación para ordenación a élder', quien: 'obispo', ref: '31.2.6' },
  { key: 'mision', label: 'Recomendación para misión de tiempo completo', quien: 'obispo', ref: '24.4.2' },
  { key: 'llamamiento_presidente', label: 'Llamamiento de presidente(a) de una organización del barrio', quien: 'obispo', ref: '30.8' },
  { key: 'dignidad', label: 'Arrepentimiento de pecados graves', quien: 'obispo', ref: 'cap. 32' },
  { key: 'endoso', label: 'Endoso eclesiástico (universidad / instituto / Fondo Perpetuo)', quien: 'obispo', ref: '34.3.1.2' },
  { key: 'diezmos', label: 'Declaración de diezmos', quien: 'obispo' },
  { key: 'ofrendas_ayuno', label: 'Ayuda con ofrendas de ayuno (bienestar)', quien: 'obispo', ref: '22.6.1' },

  // --- El obispo o un consejero asignado ---
  { key: 'recomendacion_renovacion', label: 'Renovación de recomendación del templo', quien: 'obispado', ref: '26.3.2' },
  { key: 'recomendacion_bautismos', label: 'Recomendación de uso limitado (bautismos y confirmaciones por los muertos)', quien: 'obispado', ref: '26.3.1' },
  { key: 'sellamiento_padres', label: 'Recomendación para sellamiento a los padres', quien: 'obispado', ref: '27.4' },
  { key: 'llamamiento', label: 'Extender un llamamiento (según la tabla 30.8)', quien: 'obispado', ref: '30.8' },
  { key: 'bautismo_nino', label: 'Bautismo de un niño o niña de 8 años', quien: 'obispado', ref: '31.2.3.1' },
  { key: 'ordenacion_diacono_maestro', label: 'Ordenación a diácono o maestro', quien: 'obispado', ref: '18.10.2' },
  { key: 'bendicion_patriarcal', label: 'Recomendación para bendición patriarcal', quien: 'obispado', ref: '18.17' },
  {
    key: 'jovenes', label: 'Entrevista semestral de jóvenes', quien: 'obispado', ref: '31.3.1',
    nota: 'Al menos una de las dos entrevistas del año debe ser con el obispo (desde los 16 años, idealmente ambas). Un padre u otro adulto debe estar presente (31.1.4).',
  },

  // --- Presidencias de Cuórum de Élderes y Sociedad de Socorro ---
  { key: 'ministracion', label: 'Entrevista de ministración', quien: 'presidencia', ref: '21.3' },
];

export const QUIEN_LABEL = {
  obispo: 'Solo el obispo',
  obispado: 'El obispo o un consejero asignado',
  presidencia: 'Presidencias de Cuórum de Élderes / Sociedad de Socorro',
  cualquiera: 'Cualquier líder que entrevista',
};

export function tipoPorKey(key) {
  return TIPOS_ENTREVISTA.find((t) => t.key === key) || null;
}

const clave = (s) => normNombre(s).split(' ').filter(Boolean).sort().join(' ');
const orgDe = (data, u) => data.organizations.find((o) => o.id === Number(u?.organizationId)) || null;

export function esObispo(u, data) {
  const org = orgDe(data, u);
  return !!u && u.role === 'leader' && org?.name === 'Obispado' && (u.calling === 'Presidente' || u.isPresident === true);
}
function esDelObispado(u, data) {
  const org = orgDe(data, u);
  return !!u && u.role === 'leader' && org?.name === 'Obispado' && u.calling !== 'Secretario';
}
function esDePresidenciaMinistracion(u, data) {
  const org = orgDe(data, u);
  return !!u && u.role === 'leader' && ['Cuórum de Élderes', 'Sociedad de Socorro'].includes(org?.name) && u.calling !== 'Secretario';
}

export function obispoDelBarrio(data) {
  return data.users.find((u) => esObispo(u, data)) || null;
}

// Cuenta del entrevistador a partir del ID o, si no, del nombre escrito
// (solo si el nombre es inequívoco).
export function resolverEntrevistador(data, { interviewerUserId = null, interviewerName = '' }) {
  if (interviewerUserId) return data.users.find((u) => u.id === Number(interviewerUserId)) || null;
  const k = clave(interviewerName);
  if (!k) return null;
  const us = data.users.filter((u) => clave(u.name) === k);
  return us.length === 1 ? us[0] : null;
}

// ¿Puede ESTA persona hacer ESTE tipo de entrevista, en ESTA organización?
// → { ok: true, nota? } | { ok: false, error } | { ok: true, advertencia }
export function validarTipoEntrevista(data, { tipoKey, organizationId, entrevistador }) {
  const tipo = tipoPorKey(tipoKey || 'general');
  if (!tipo) return { ok: false, error: 'Tipo de entrevista desconocido' };
  const org = data.organizations.find((o) => o.id === Number(organizationId));
  const nota = tipo.nota || null;
  const ref = tipo.ref ? ` (Manual General ${tipo.ref})` : '';
  if (tipo.quien === 'cualquiera') return { ok: true, nota };

  if (tipo.quien === 'obispo' || tipo.quien === 'obispado') {
    if (org?.name !== 'Obispado') {
      return { ok: false, error: `"${tipo.label}" le corresponde al Obispado${tipo.quien === 'obispo' ? ' (solo al obispo)' : ''}${ref}. Agéndala en la organización Obispado.` };
    }
    if (!entrevistador) {
      return { ok: true, nota, advertencia: `No pude verificar quién entrevista: "${tipo.label}" la hace ${tipo.quien === 'obispo' ? 'solo el obispo' : 'el obispo o un consejero'}${ref}.` };
    }
    if (tipo.quien === 'obispo' && !esObispo(entrevistador, data)) {
      const ob = obispoDelBarrio(data);
      // Si nadie del Obispado tiene declarado el llamamiento "Obispo"
      // (Presidente) en su perfil, no hay cómo saber quién es: se avisa en
      // vez de bloquear.
      if (!ob) return { ok: true, nota, advertencia: `"${tipo.label}" la hace solo el obispo${ref}. Declara el llamamiento del obispo en su perfil para que la app lo verifique.` };
      return { ok: false, error: `Según el Manual General${tipo.ref ? ` (${tipo.ref})` : ''}, "${tipo.label}" la hace solo el obispo${ob ? ` (${ob.name})` : ''}, no ${entrevistador.name}.`, sugerido: ob ? { id: ob.id, name: ob.name } : null };
    }
    if (tipo.quien === 'obispado' && !esDelObispado(entrevistador, data)) {
      return { ok: false, error: `"${tipo.label}" la hace el obispo o uno de sus consejeros${ref}, no ${entrevistador.name}.` };
    }
    return { ok: true, nota };
  }

  if (tipo.quien === 'presidencia') {
    if (!['Cuórum de Élderes', 'Sociedad de Socorro'].includes(org?.name)) {
      return { ok: false, error: `"${tipo.label}" la hacen las presidencias de Cuórum de Élderes o Sociedad de Socorro${ref}.` };
    }
    if (entrevistador && !esDePresidenciaMinistracion(entrevistador, data)) {
      return { ok: false, error: `"${tipo.label}" la hace un miembro de la presidencia${ref}, no ${entrevistador.name}.` };
    }
    return { ok: true, nota };
  }
  return { ok: true, nota };
}

// Tipos que un líder específico puede hacer (para el enlace público).
export function tiposQuePuedeHacer(data, lider) {
  const org = orgDe(data, lider);
  return TIPOS_ENTREVISTA.filter((t) => validarTipoEntrevista(data, { tipoKey: t.key, organizationId: org?.id, entrevistador: lider }).ok);
}

// Deducir el tipo desde lo que alguien escribió (Deseret).
const PISTAS = [
  ['recomendacion_renovacion', /\b(renov\w*)\b.*\b(recomendacion|templo)\b|\b(recomendacion|templo)\b.*\brenov\w*/],
  ['recomendacion_primera', /\b(primera (vez )?recomendacion|investidura|sellar\w*|sellamiento propio|casarse en el templo)\b/],
  ['recomendacion_bautismos', /\b(uso limitado|bautismos? por (los )?(muertos|antepasados)|bautismos vicarios)\b/],
  ['sellamiento_padres', /\bsellamiento a (los |sus )?padres\b/],
  ['ordenacion_presbitero', /\bpresbitero\b/],
  ['ordenacion_diacono_maestro', /\b(diacono|maestro)\b.*\bordenacion\b|\bordenacion\b.*\b(diacono|maestro)\b/],
  ['recomendacion_elder', /\b(elder|sacerdocio de melquisedec)\b/],
  ['mision', /\bmision\w*\b/],
  ['bendicion_patriarcal', /\bbendicion patriarcal\b/],
  ['bautismo_nino', /\bbautismo\b.*\b(nin[oa]|8 anos|ocho anos)\b/],
  ['jovenes', /\b(jovenes|joven|semestral|mujeres jovenes|hombres jovenes)\b/],
  ['ministracion', /\bministracion\b/],
  ['diezmos', /\bdiezmos?\b/],
  ['ofrendas_ayuno', /\b(ofrendas? de ayuno|ayuda economica|bienestar)\b/],
  ['llamamiento_presidente', /\bllamamiento\b.*\bpresident\w*\b/],
  ['llamamiento', /\b(llamamiento|llamar a servir)\b/],
  ['dignidad', /\b(arrepentimiento|confesion|dignidad)\b/],
  ['endoso', /\b(endoso|fondo perpetuo|instituto|universidad)\b/],
];
export function inferirTipoEntrevista(norm) {
  for (const [k, re] of PISTAS) if (re.test(norm)) return k;
  if (/\brecomendacion\b|\btemplo\b/.test(norm)) return 'recomendacion_renovacion';
  return null;
}
