import { GoogleGenAI } from '@google/genai';
import { load, save } from './db.js';

export async function procesarPreguntaChat(mensaje, usuario) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY no configurada.");

    const db = load();
    const hoy = new Date().toISOString().split('T')[0];
    const normalizar = (str) => str ? str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() : "";
    const mensajeNorm = normalizar(mensaje);

    // --- FLUJO DE AGENDAMIENTO INTELIGENTE EN EL CALENDARIO ---
    if (mensajeNorm.match(/(agendar|crear|programar|anotar|registrar)\s+(una\s+)?(reunion|actividad|evento)/)) {
      
      // 1. Validar Permisos por Rol
      const rol = normalizar(usuario?.role || usuario?.cargo || '');
      const esLider = /(obispo|cuorum|sociedad|admin|presidente|secretario)/.test(rol);

      if (!esLider) {
        return "🔒 Lo siento, solo los miembros del Obispado, Presidencias y Secretarios tienen permisos para registrar eventos en el calendario.";
      }

      // 2. Extraer parámetros mediante expresiones o palabras clave
      const buscaLugar = mensaje.match(/(?:en|lugar|ubicacion|salon)\s+([A-Za-z0-9áéíóúÁÉÍÓÚñÑ\s]+?)(?=\s+a\s+las|\s+el|\s+$)/i);
      const buscaHora = mensaje.match(/(\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm|hrs|horas))/i);
      const buscaFecha = mensaje.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})/i);

      const tituloLimpio = mensaje
        .replace(/(agendar|crear|programar|anotar|registrar)\s+(una\s+)?(reunion|actividad|evento)\s*/i, '')
        .replace(/(?:en|lugar|ubicacion|salon)\s+[A-Za-z0-9áéíóúÁÉÍÓÚñÑ\s]+/i, '')
        .replace(/(\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm|hrs|horas))/i, '')
        .trim();

      const lugar = buscaLugar ? buscaLugar[1].trim() : null;
      const hora = buscaHora ? buscaHora[1].trim() : "19:00"; // Hora por defecto si no especifica
      const fecha = buscaFecha ? buscaFecha[1] : hoy;

      // 3. Si no especificó el LUGAR, Deseret se lo pregunta para completar el registro
      if (!lugar) {
        return `🐝 ¡Claro que sí! Voy a agendar **"${tituloLimpio || 'Reunión'}"** para la fecha **${fecha}** a las **${hora}**.\n\n📍 **¿En qué lugar o salón se llevará a cabo?** *(Ejemplo: Capilla, Salón Sacramental, Casa de la familia Pérez, Zoom)*`;
      }

      // 4. Mapeo completo hacia la estructura real del Calendario (db.events)
      const nuevoEvento = {
        id: Date.now(),
        title: tituloLimpio || 'Reunión de Organización',
        date: fecha,
        time: hora,
        location: lugar,
        description: `Agendado automáticamente por Deseret IA a petición de ${usuario?.name || 'Líder'}`,
        organizationId: usuario?.organizationId || 1,
        createdBy: usuario?.name || 'Deseret IA',
        createdAt: new Date().toISOString()
      };

      db.events = db.events || [];
      db.events.push(nuevoEvento);
      save(db);

      return `✅ **¡Evento agendado exitosamente en el Calendario!**\n\n` +
             `📅 **Actividad:** ${nuevoEvento.title}\n` +
             `📆 **Fecha:** ${nuevoEvento.date}\n` +
             `⏰ **Hora:** ${nuevoEvento.time}\n` +
             `📍 **Lugar:** ${nuevoEvento.location}\n` +
             `👤 **Registrado por:** ${nuevoEvento.createdBy}\n\n` +
             `*El evento ya está visible para todos los miembros en el calendario del barrio.*`;
    }

    // --- BÚSQUEDAS REGULARES Y CONSULTAS AL SISTEMA ---
    let contextoDinamico = "";

    if (mensajeNorm.match(/(actividad|calendario|cuorum|sociedad|primaria|jovenes|hoy|manana|semana|mes)/)) {
      const actividades = db.events.filter(e => e.date >= hoy);
      contextoDinamico += "\n--- ACTIVIDADES EN CALENDARIO ---\n" + JSON.stringify(actividades);
    }

    if (mensajeNorm.match(/(aseo|limpieza|capilla|turno)/)) {
      const turnos = db.cleaningShifts.filter(t => t.date >= hoy);
      contextoDinamico += "\n--- TURNOS DE ASEO ---\n" + JSON.stringify(turnos);
    }

    if (contextoDinamico === "") {
      contextoDinamico = "Responde amablemente. Si el usuario quiere agendar un evento, recuérdale incluir Título, Fecha, Hora y Lugar.";
    }

    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: mensaje,
      config: {
        systemInstruction: `Eres Deseret, la abeja asistente de OrganizaSion.
Contexto activo de la Base de Datos:
${contextoDinamico}

REGLAS DE RESPUESTA:
- Formatea siempre con listas y palabras clave en **negrita**.
- Usa emojis amigables (🐝, 📅, 📍, ⏰).`
      }
    });

    return response.text || "🐝 No pude procesar tu consulta.";

  } catch (error) {
    console.error("Error en procesarPreguntaChat:", error);
    return "🐝 Ocurrió un contratiempo al procesar la solicitud. Intenta de nuevo en unos momentos.";
  }
}
