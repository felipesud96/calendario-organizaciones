import { GoogleGenAI } from '@google/genai';
import { load } from './db.js';

export async function procesarPreguntaChat(mensaje, usuario) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY no configurada.");

    const db = load();
    const hoy = new Date().toISOString().split('T')[0];
    const mensajeMinusculas = mensaje.toLowerCase();

    // Normalizar tildes y caracteres especiales para la búsqueda difusa
    const normalizar = (str) => str ? str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() : "";
    const mensajeNorm = normalizar(mensaje);

    let contextoDinamico = "";

    // 1. Módulo: Actividades y Calendario
    if (mensajeNorm.match(/(actividad|calendario|cuorum|sociedad|primaria|jovenes|hoy|manana|semana|mes)/)) {
      const actividades = db.events
        .filter(e => e.date >= hoy)
        .map(e => {
          const org = db.organizations.find(o => Number(o.id) === Number(e.organizationId));
          return { titulo: e.title, fecha: e.date, organizacion: org ? org.name : 'General' };
        });
      contextoDinamico += "\n--- ACTIVIDADES PRÓXIMAS ---\n" + JSON.stringify(actividades);
    }

    // 2. Módulo: Turnos de Aseo
    if (mensajeNorm.match(/(aseo|limpieza|limpiar|edificio|capilla|turno)/)) {
      const turnosAseo = db.cleaningShifts
        .filter(t => t.date >= hoy)
        .map(t => {
           const fam = db.families.find(f => Number(f.id) === Number(t.familyId));
           return { fecha: t.date, familia: fam ? fam.name : 'Sin asignar' };
        });
      contextoDinamico += "\n--- TURNOS DE ASEO ---\n" + JSON.stringify(turnosAseo);
    }

    // 3. Módulo: Recomendaciones del Templo (RESTRINGIDO POR ROL)
    if (mensajeNorm.match(/(recomendacion|templo|hombres|adultos|hermano|miembro)/)) {
      // Normalizamos el rol del usuario logueado
      const rolUsuario = normalizar(usuario?.role || usuario?.cargo || '');
      
      // Cargos autorizados a ver recomendaciones
      const esAutorizado = 
        rolUsuario.includes('obispo') || 
        rolUsuario.includes('obispado') || 
        rolUsuario.includes('presidente_cuorum') || 
        rolUsuario.includes('presidente cuorum') || 
        rolUsuario.includes('quorum') || 
        rolUsuario.includes('presidenta_soc_soc') || 
        rolUsuario.includes('sociedad de socorro') ||
        rolUsuario.includes('soc_soc') ||
        rolUsuario.includes('admin');

      if (esAutorizado) {
        const directorio = db.directoryMembers.map(m => ({
            nombre: m.fullName || m.name,
            genero: m.sex,
            fechaNacimiento: m.birthDate,
            recomendacion: m.templeRecommend ? 'Vigente' : 'No vigente / Desconocida'
        }));
        contextoDinamico += "\n--- DIRECTORIO DE MIEMBROS (RECOMENDACIONES) ---\n" + JSON.stringify(directorio);
      } else {
        return "🔒 **Información confidencial:** La consulta sobre recomendaciones del templo está reservada únicamente para los miembros del Obispado, la Presidencia del Cuórum de Élderes y la Presidencia de la Sociedad de Socorro.";
      }
    }

    if (contextoDinamico === "") {
      contextoDinamico = "El usuario está saludando o haciendo una pregunta general. Invítalo amablemente a preguntarte sobre el calendario de actividades o los turnos de aseo.";
    }

    const ai = new GoogleGenAI({ apiKey });

    const systemInstruction = `Eres Deseret, la abeja asistente de la app OrganizaSion.
Aquí tienes la información extraída de la base de datos:
${contextoDinamico}

REGLAS DE DISEÑO ESTRICTAS PARA TUS RESPUESTAS:
1. NUNCA respondas con un solo párrafo gigante.
2. Usa listas con viñetas o números para mostrar actividades, turnos o nombres, un elemento por línea.
3. Resalta SIEMPRE en **negrita** los títulos de actividades, nombres de personas/familias y las fechas.
4. Usa emojis amigables (ej: 📅, 🧹, 🏛️, 🐝).
5. Deja un espacio en blanco antes y después de tu lista.
6. Sé clara, directa y estructurada visualmente.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: mensaje,
      config: { systemInstruction }
    });

    if (response && response.text) {
      return response.text;
    }

    return "🐝 No pude obtener una respuesta en este momento. Intenta de nuevo.";

  } catch (error) {
    console.warn("Manejando error de la API de Gemini de forma segura:", error?.message || error);
    return "🐝 He recibido muchas consultas seguidas y alcancé el límite de uso temporal de Google. Por favor, espera unos segundos e intenta de nuevo.";
  }
}
