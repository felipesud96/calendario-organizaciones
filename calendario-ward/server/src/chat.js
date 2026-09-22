import { GoogleGenAI } from '@google/genai';
import { load } from './db.js';

export async function procesarPreguntaChat(mensaje) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY no configurada.");

    // 1. Cargamos la base de datos JSON de tu aplicación usando tu propia función
    const db = load();
    
    // 2. Extraemos y combinamos manualmente las actividades (events) y las organizaciones
    const actividadesFormateadas = db.events.map(evento => {
      const org = db.organizations.find(o => Number(o.id) === Number(evento.organizationId));
      return {
        titulo: evento.title,
        fecha: evento.date,
        hora_inicio: evento.startTime,
        lugar: evento.location,
        organizacion: org ? org.name : 'General'
      };
    });

    const contextoActividades = JSON.stringify(actividadesFormateadas);

    // 3. Inicializamos Gemini con el modelo oficial
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: mensaje,
      config: {
        systemInstruction: `Eres Deseret, la abeja asistente amigable de la aplicación OrganizaSion del barrio.
Tu trabajo es responder preguntas de los miembros sobre el calendario y las actividades del barrio.

Esta es la lista actualizada de actividades en formato JSON:
${contextoActividades}

Instrucciones:
- Usa ÚNICAMENTE los datos provistos en el JSON anterior para responder.
- Si preguntan por "Cuórum de Élderes", "Primaria", etc., filtra los datos por el campo 'organizacion'.
- Responde de forma amable, clara y breve.`
      }
    });

    return response.text;
  } catch (error) {
    console.error("DETALLE DEL ERROR EN GEMINI CHAT:", error);
    throw error;
  }
}
