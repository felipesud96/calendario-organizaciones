import { GoogleGenAI } from '@google/genai';

// Inicializa Gemini. Render tomará automáticamente GEMINI_API_KEY del entorno.
const ai = new GoogleGenAI({});

// Declaración de la herramienta (Function Calling)
const declaracionHerramientas = [{
  functionDeclarations: [
    {
      name: 'obtenerActividades',
      description: 'Busca en la base de datos las actividades de una organización.',
      parameters: {
        type: 'OBJECT',
        properties: {
          organizacion: {
            type: 'STRING',
            description: 'Nombre de la organización (ej: JAS, Obispado, Primaria, Sociedad de Socorro)'
          }
        },
        required: ['organizacion']
      }
    }
  ]
}];

export async function procesarPreguntaChat(mensaje) {
  const chat = ai.chats.create({
    model: 'gemini-2.5-flash',
    config: {
      systemInstruction: "Eres el asistente de OrganizaSion. Responde dudas sobre el calendario de forma breve, clara y amable para miembros de la iglesia.",
      tools: declaracionHerramientas
    }
  });

  let respuesta = await chat.sendMessage(mensaje);

  // Si Gemini decide consultar la base de datos
  if (respuesta.functionCalls && respuesta.functionCalls.length > 0) {
    const llamada = respuesta.functionCalls[0];
    
    if (llamada.name === 'obtenerActividades') {
      const { organizacion } = llamada.args;
      
      // Muestra/ejemplo de prueba (aquí conectarás la lectura de tus datos reales)
      const actividadesPrueba = [
        { titulo: "Noche de Hogar", fecha: "2026-10-15", organizacion: organizacion }
      ]; 

      respuesta = await chat.sendMessage([{
        functionResponse: {
          name: llamada.name,
          response: { resultado: actividadesPrueba }
        }
      }]);
    }
  }

  return respuesta.text;
}
