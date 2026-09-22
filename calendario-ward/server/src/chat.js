import { GoogleGenAI } from '@google/genai';

export async function procesarPreguntaChat(mensaje) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("La variable GEMINI_API_KEY no está disponible en el entorno.");
  }

  const ai = new GoogleGenAI({ apiKey });

  // Petición directa al modelo gemini-2.5-flash
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: mensaje,
    config: {
      systemInstruction: "Eres Deseret, la abeja asistente de OrganizaSion. Responde de forma amable, clara y breve a los miembros de la iglesia."
    }
  });

  return response.text;
}
