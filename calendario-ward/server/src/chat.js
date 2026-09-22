import { GoogleGenAI } from '@google/genai';
import { load } from './db.js';

export async function procesarPreguntaChat(mensaje) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY no configurada.");

    const db = load();
    const hoy = new Date().toISOString().split('T')[0];
    const mensajeMinusculas = mensaje.toLowerCase();

    let contextoDinamico = "";

    // 1. Contexto Dinámico por Módulo
    if (mensajeMinusculas.match(/(actividad|calendario|cuórum|sociedad|primaria|jóvenes|hoy|mañana|semana|mes)/)) {
      const actividades = db.events
        .filter(e => e.date >= hoy)
        .map(e => {
          const org = db.organizations.find(o => Number(o.id) === Number(e.organizationId));
          return { titulo: e.title, fecha: e.date, organizacion: org ? org.name : 'General' };
        });
      contextoDinamico += "\n--- ACTIVIDADES PRÓXIMAS ---\n" + JSON.stringify(actividades);
    }

    if (mensajeMinusculas.match(/(aseo|limpieza|limpiar|edificio|capilla|turno)/)) {
      const turnosAseo = db.cleaningShifts
        .filter(t => t.date >= hoy)
        .map(t => {
           const fam = db.families.find(f => Number(f.id) === Number(t.familyId));
           return { fecha: t.date, familia: fam ? fam.name : 'Sin asignar' };
        });
      contextoDinamico += "\n--- TURNOS DE ASEO ---\n" + JSON.stringify(turnosAseo);
    }

    if (mensajeMinusculas.match(/(recomendación|templo|hombres|adultos|hermano|miembro)/)) {
      const directorio = db.directoryMembers.map(m => ({
          nombre: m.fullName || m.name,
          genero: m.sex,
          fechaNacimiento: m.birthDate,
          recomendacion: m.templeRecommend ? 'Vigente' : 'No vigente / Desconocida'
      }));
      contextoDinamico += "\n--- DIRECTORIO DE MIEMBROS ---\n" + JSON.stringify(directorio);
    }

    if (contextoDinamico === "") {
      contextoDinamico = "El usuario está saludando o haciendo una pregunta general. Invítalo amablemente a preguntarte sobre el calendario, turnos de aseo o recomendaciones del templo.";
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
6. Para "hombres adultos con recomendación", filtra género 'M', mayores de 18 años y recomendación 'Vigente'.
7. Sé clara, directa y estructurada visualmente.`;

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
    console.error("DETALLE DEL ERROR EN GEMINI CHAT:", error);

    const errStr = JSON.stringify(error || {});
    
    // Si agotamos la cuota de peticiones por minuto/día (Error 429)
    if (errStr.includes("429") || errStr.includes("RESOURCE_EXHAUSTED")) {
      return "🐝 He recibido muchas consultas seguidas y alcancé el límite de uso temporal de la API de Google. Por favor, espera un par de minutos y vuelve a intentarlo.";
    }

    // Si Google está sobrecargado (Error 503)
    if (errStr.includes("503") || errStr.includes("UNAVAILABLE")) {
      return "🐝 Los servidores de Google AI están experimentando alta demanda. Por favor, reintenta tu pregunta en unos momentos.";
    }

    return "🐝 Ocurrió un problema temporal al consultar a la IA. Intenta de nuevo en unos momentos.";
  }
}
