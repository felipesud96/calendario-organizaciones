import { GoogleGenAI } from '@google/genai';
import { load } from './db.js';

export async function procesarPreguntaChat(mensaje) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY no configurada.");

    // 1. Cargamos la base de datos JSON
    const db = load();
    const hoy = new Date().toISOString().split('T')[0];
    const mensajeMinusculas = mensaje.toLowerCase();

    let contextoDinamico = "";

    // --- MÓDULO 1: ACTIVIDADES Y CALENDARIO ---
    if (mensajeMinusculas.match(/(actividad|actividades|calendario|cuórum|cuorum|élderes|elderes|sociedad|primaria|jóvenes|jovenes|hoy|mañana|semana|mes)/)) {
      const actividades = db.events
        .filter(e => e.date >= hoy) // Filtramos eventos futuros para máxima velocidad
        .map(e => {
          const org = db.organizations.find(o => Number(o.id) === Number(e.organizationId));
          return { titulo: e.title, fecha: e.date, organizacion: org ? org.name : 'General' };
        });
      contextoDinamico += "\n--- ACTIVIDADES PRÓXIMAS EN EL CALENDARIO ---\n" + JSON.stringify(actividades);
    }

    // --- MÓDULO 2: ASEO DEL EDIFICIO ---
    if (mensajeMinusculas.match(/(aseo|limpieza|limpiar|edificio|capilla|turno)/)) {
      const turnosAseo = db.cleaningShifts
        .filter(t => t.date >= hoy)
        .map(t => {
           const fam = db.families.find(f => Number(f.id) === Number(t.familyId));
           return { fecha: t.date, familia: fam ? fam.name : 'Sin asignar' };
        });
      contextoDinamico += "\n--- TURNOS DE ASEO ---\n" + JSON.stringify(turnosAseo);
    }

    // --- MÓDULO 3: RECOMENDACIONES DEL TEMPLO Y DIRECTORIO ---
    if (mensajeMinusculas.match(/(recomendación|recomendacion|templo|hombres|adultos|hermano|miembro)/)) {
      const directorio = db.directoryMembers.map(m => ({
          nombre: m.fullName || m.name,
          genero: m.sex,
          fechaNacimiento: m.birthDate,
          recomendacion: m.templeRecommend ? 'Vigente' : 'No vigente / Desconocida'
      }));
      contextoDinamico += "\n--- DIRECTORIO DE MIEMBROS ---\n" + JSON.stringify(directorio);
    }

    // --- MENSAJE GENERAL SI NO HAY COINCIDENCIA ---
    if (contextoDinamico === "") {
      contextoDinamico = "El usuario está saludando o haciendo una pregunta general. Invítalo amablemente a consultar sobre las actividades del calendario, los turnos de aseo o las recomendaciones del templo.";
    }

    // 2. Inicializamos la conexión a Google Gemini
    const ai = new GoogleGenAI({ apiKey });

    // 3. Reglas de Comportamiento e Instrucciones del Sistema
    const systemInstruction = `Eres Deseret, la abeja asistente de la app OrganizaSion.
Aquí tienes la información disponible de la base de datos:
${contextoDinamico}

REGLAS DE COMPORTAMIENTO (ESTRICTAS):
1. El usuario SOLO te está haciendo preguntas de CONSULTA E INFORMACIÓN.
2. JAMÁS respondas diciendo que faltan permisos, roles o accesos para ver/consultar datos, sin importar si la persona es presidente, miembro o visitante.
3. Responde directamente la pregunta contando o listando los datos entregados en la información de arriba.
4. Si te preguntan cuántas actividades tiene una organización (ej: Cuórum de Élderes), cuenta cuántas hay en la lista y muestra sus detalles.

REGLAS DE DISEÑO DE RESPUESTA:
1. NUNCA respondas con un solo párrafo gigante.
2. Usa listas con viñetas o números para mostrar actividades, turnos o nombres, un elemento por línea.
3. Resalta SIEMPRE en **negrita** los títulos de actividades, nombres de personas/familias y las fechas.
4. Usa emojis amigables (ej: 🐝, 📅, 🧹, 🏛️).
5. Deja espacios entre líneas para que sea fácil de leer.`;

    // 4. Petición a la API usando el modelo oficial gemini-3.6-flash
    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: mensaje,
      config: { systemInstruction }
    });

    if (response && response.text) {
      return response.text;
    }

    return "🐝 No pude procesar una respuesta en este momento. Intenta de nuevo.";

  } catch (error) {
    console.error("DETALLE DEL ERROR EN GEMINI CHAT:", error);

    const errStr = JSON.stringify(error || {});

    // Manejo de cuota agotada (Error 429)
    if (errStr.includes("429") || errStr.includes("RESOURCE_EXHAUSTED")) {
      return "🐝 Alcanzamos el límite temporal de consultas gratuitas a Google. Por favor, espera un minuto y vuelve a intentar.";
    }

    // Manejo de servidores ocupados (Error 503)
    if (errStr.includes("503") || errStr.includes("UNAVAILABLE")) {
      return "🐝 Los servidores de Google AI están experimentando alta demanda. Por favor, reintenta tu pregunta en unos momentos.";
    }

    return "🐝 Ocurrió un problema temporal al consultar la información. Intenta de nuevo en unos momentos.";
  }
}
