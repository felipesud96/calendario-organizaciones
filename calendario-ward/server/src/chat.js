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

    // 1. Enrutamiento de contexto por módulo
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

    // 2. Ejecución con reintentos para mitigar el error 503 por saturación temporal
    let intentos = 0;
    const maxIntentos = 3;

    while (intentos < maxIntentos) {
      try {
        const response = await ai.models.generateContent({
          model: 'gemini-3.6-flash',
          contents: mensaje,
          config: { systemInstruction }
        });

        if (response && response.text) {
          return response.text;
        }
      } catch (err) {
        intentos++;
        console.warn(`Intento ${intentos} falló con error: ${err.message}`);
        
        // Si no es el último intento, esperar 1.5 segundos antes de reintentar
        if (intentos < maxIntentos) {
          await new Promise(resolve => setTimeout(resolve, 1500));
        } else {
          throw err;
        }
      }
    }

  } catch (error) {
    console.error("DETALLE DEL ERROR EN GEMINI CHAT:", error);
    // Retornamos un mensaje de contingencia en lugar de lanzar la excepción al servidor
    return "🐝 Los servidores de Google Gemini están experimentando alta demanda en este momento. Por favor, intenta enviar tu pregunta nuevamente en unos segundos.";
  }
}
