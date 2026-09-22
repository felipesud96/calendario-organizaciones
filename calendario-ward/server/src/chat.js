import { GoogleGenAI } from '@google/genai';
import { load } from './db.js';

export async function procesarPreguntaChat(mensaje) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY no configurada.");

    // 1. Cargamos tu base de datos JSON en memoria
    const db = load();
    const hoy = new Date().toISOString().split('T')[0];
    const mensajeMinusculas = mensaje.toLowerCase();

    let contextoDinamico = "";

    // --- MÓDULO 1: ACTIVIDADES Y CALENDARIO ---
    if (mensajeMinusculas.match(/(actividad|calendario|cuórum|sociedad|primaria|jóvenes|hoy|mañana|semana|mes)/)) {
      const actividades = db.events
        .filter(e => e.date >= hoy) // Solo enviamos eventos futuros para que sea ultra rápido
        .map(e => {
          const org = db.organizations.find(o => Number(o.id) === Number(e.organizationId));
          return { titulo: e.title, fecha: e.date, organizacion: org ? org.name : 'General' };
        });
      contextoDinamico += "\n--- ACTIVIDADES PRÓXIMAS ---\n" + JSON.stringify(actividades);
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
    if (mensajeMinusculas.match(/(recomendación|templo|hombres|adultos|hermano|miembro)/)) {
      const directorio = db.directoryMembers.map(m => ({
          nombre: m.fullName || m.name,
          genero: m.sex,
          fechaNacimiento: m.birthDate, // La IA calculará si es mayor de 18 años
          recomendacion: m.templeRecommend ? 'Vigente' : 'No vigente / Desconocida'
      }));
      contextoDinamico += "\n--- DIRECTORIO DE MIEMBROS ---\n" + JSON.stringify(directorio);
    }

    // --- SALUDO GENERAL (Si no preguntó por nada específico) ---
    if (contextoDinamico === "") {
      contextoDinamico = "El usuario está saludando o haciendo una pregunta general. Invítalo amablemente a preguntarte sobre las actividades del calendario, los turnos de aseo o las recomendaciones del templo.";
    }

    // 2. Inicializamos la conexión a Google Gemini
    const ai = new GoogleGenAI({ apiKey });

    // 3. Llamada al modelo CORRECTO: gemini-3.6-flash
    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: mensaje,
      config: {
        systemInstruction: `Eres Deseret, la abeja asistente de la app OrganizaSion.
Aquí tienes la información extraída de la base de datos:
${contextoDinamico}

REGLAS DE DISEÑO ESTRICTAS PARA TUS RESPUESTAS:
1. NUNCA respondas con un solo párrafo gigante.
2. Usa listas con viñetas (bullet points) o números para mostrar actividades, turnos o nombres, un elemento por línea.
3. Resalta SIEMPRE en **negrita** los títulos de actividades, nombres de personas/familias y las fechas.
4. Usa emojis para que el mensaje se vea amigable y visual (ej: 📅, 🧹, 🏛️, 🐝).
5. Deja un espacio en blanco (salto de línea) antes y después de tu lista para que respire.
6. Si te preguntan por "hombres adultos con recomendación", filtra solo a los de género 'M', que tengan 18 años o más (según su fechaNacimiento), y cuya recomendación sea 'Vigente'.
7. Sé clara, directa y muy organizada visualmente.`
      }
    });

    return response.text;
  } catch (error) {
    console.error("DETALLE DEL ERROR EN GEMINI CHAT:", error);
    throw error;
  }
}
