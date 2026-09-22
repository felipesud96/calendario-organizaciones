import { GoogleGenAI } from '@google/genai';

export async function procesarPreguntaChat(mensaje) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      console.error("ERROR: GEMINI_API_KEY no está configurada en Render.");
      throw new Error("Clave API no configurada");
    }

    const ai = new GoogleGenAI({ apiKey });

    // Actualizamos al modelo gemini-3.6-flash
    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: mensaje,
      config: {
        systemInstruction: "Eres Deseret, la abeja asistente amigable de OrganizaSion. Responde de forma breve y amable a los miembros de la iglesia."
      }
    });

    return response.text;
  } catch (error) {
    console.error("DETALLE DEL ERROR EN GEMINI CHAT:", error);
    throw error;
  }
}
