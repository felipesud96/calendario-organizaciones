import { GoogleGenAI } from '@google/genai';
import { getDb } from './db.js'; // Importamos tu conexión a la base de datos de OrganizaSion

export async function procesarPreguntaChat(mensaje) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY no configurada.");

    // 1. Consultamos la base de datos real para obtener todas las actividades actuales
    const db = await getDb();
    const actividades = await db.all(`
      SELECT a.id, a.titulo, a.fecha, a.hora_inicio, a.lugar, o.nombre AS organizacion
      FROM actividades a
      LEFT JOIN organizaciones o ON a.organizacion_id = o.id
      ORDER BY a.fecha ASC
    `);

    // 2. Le pasamos las actividades reales como contexto en las instrucciones a Deseret
    const contextoActividades = JSON.stringify(actividades);

    const ai = new GoogleGenAI({ apiKey });

    // 3. Consultamos a Gemini con el contexto de tu barrio
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: mensaje,
      config: {
        systemInstruction: `Eres Deseret, la abeja asistente amigable de la aplicación OrganizaSion del barrio.
Tu trabajo es responder preguntas de los miembros sobre el calendario y actividades.

Esta es la lista actualizada de actividades en la base de datos del barrio en formato JSON:
${contextoActividades}

Instrucciones:
- Usa ÚNICAMENTE los datos provistos en el JSON anterior para responder sobre cantidades, fechas y detalles de las actividades.
- Si te preguntan por las actividades del "Cuórum de Élderes", "Primaria", "Sociedad de Socorro", etc., filtra los datos por el campo 'organizacion'.
- Responde de forma breve, clara, amable y con un tono cercano de miembro de la iglesia.`
      }
    });

    return response.text;
  } catch (error) {
    console.error("DETALLE DEL ERROR EN GEMINI CHAT:", error);
    throw error;
  }
}
