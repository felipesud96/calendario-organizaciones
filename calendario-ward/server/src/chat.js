import { GoogleGenAI } from '@google/genai';
import { load, save } from './db.js';

// Memoria temporal para rastrear el progreso de agendamiento
const borradoresPendientes = {};

export async function procesarPreguntaChat(mensaje, usuario) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY no configurada.");

    const db = load();
    const hoy = new Date().toISOString().split('T')[0];
    const userId = usuario?.id || usuario?.email || 'anonimo';
    const normalizar = (str) => str ? str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() : "";
    const mensajeNorm = normalizar(mensaje);

    // --- FASE 2: SI YA HABÍAMOS PREGUNTADO POR EL LUGAR Y AHORA ELIGE/ESCRIBE EL LUGAR ---
    if (borradoresPendientes[userId] && borradoresPendientes[userId].paso === 'PREGUNTAR_LUGAR') {
      const borrador = borradoresPendientes[userId];
      borrador.location = mensaje.replace(/^(en\s+|el\s+|la\s+)/i, '').trim();

      // Si seleccionó "Capilla", le preguntamos la sala específica mediante botones
      if (normalizar(borrador.location).includes('capilla')) {
        borrador.paso = 'PREGUNTAR_SALA';
        
        return {
          texto: `📍 **Ubicación:** Capilla seleccionada.\n\n🏛️ **¿En qué sala o espacio de la capilla se realizará?**`,
          opciones: [
            "Salón Sacramental",
            "Salón Cultural",
            "Oficina del Obispo",
            "Salón de Primaria",
            "Cocina / Comedor"
          ]
        };
      }

      // Si fue otro lugar (ej: Casa, Zoom), completamos el registro directamente
      return guardarEventoFinal(db, userId, borrador, borrador.location, usuario);
    }

    // --- FASE 3: SI HABÍAMOS PREGUNTADO LA SALA DE LA CAPILLA ---
    if (borradoresPendientes[userId] && borradoresPendientes[userId].paso === 'PREGUNTAR_SALA') {
      const borrador = borradoresPendientes[userId];
      const salaElegida = mensaje.trim();
      const lugarCompleto = `Capilla - ${salaElegida}`;

      return guardarEventoFinal(db, userId, borrador, lugarCompleto, usuario);
    }

    // --- FASE 1: INICIO DE LA SOLICITUD DE AGENDAMIENTO ---
    if (mensajeNorm.match(/(agendar|crear|programar|anotar|registrar|actividad|reunion|evento)/) && mensajeNorm.match(/(el|la|fecha|mañana|hoy|\d{1,2})/)) {
      
      const rol = normalizar(usuario?.role || usuario?.cargo || '');
      const esLider = /(obispo|cuorum|sociedad|admin|presidente|secretario)/.test(rol);

      if (!esLider) {
        return "🔒 Lo siento, solo los miembros del Obispado, Presidencias y Secretarios tienen permisos para agendar actividades.";
      }

      const buscaHora = mensaje.match(/(\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm|hrs|horas))/i);
      const buscaFecha = mensaje.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}|\d{1,2}\s+de\s+[a-z]+)/i);

      const tituloLimpio = mensaje
        .replace(/(agendar|crear|programar|anotar|registrar)\s+(una\s+)?(reunion|actividad|evento)\s*/i, '')
        .replace(/(\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm|hrs|horas))/i, '')
        .trim();

      const hora = buscaHora ? buscaHora[1].trim() : "19:00";
      const fecha = buscaFecha ? buscaFecha[1] : hoy;

      // Guardamos borrador en paso de PREGUNTAR_LUGAR
      borradoresPendientes[userId] = {
        title: tituloLimpio || 'Actividad de Organización',
        date: fecha,
        time: hora,
        paso: 'PREGUNTAR_LUGAR'
      };

      // Retornamos la pregunta junto con las OPCIONES EN BOTONES
      return {
        texto: `🐝 ¡Excelente! Voy a agendar **"${tituloLimpio}"** para la fecha **${fecha}** a las **${hora}**.\n\n📍 **¿Dónde se llevará a cabo?**`,
        opciones: [
          "Capilla del Barrio",
          "Casa de un miembro",
          "Oficina del Obispo",
          "Virtual / Zoom"
        ]
      };
    }

    // --- CONSULTAS CONVENCIONALES ---
    let contextoDinamico = "";
    if (mensajeNorm.match(/(actividad|calendario|cuorum|sociedad|primaria|jovenes|hoy|manana|semana|mes)/)) {
      contextoDinamico += "\n--- ACTIVIDADES EN CALENDARIO ---\n" + JSON.stringify(db.events.filter(e => e.date >= hoy));
    }

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: mensaje,
      config: {
        systemInstruction: `Eres Deseret, la abeja asistente de OrganizaSion.
Contexto: ${contextoDinamico}
Sé concisa, usa listas y formato **negrita** con emojis.`
      }
    });

    return response.text || "🐝 No pude procesar tu consulta.";

  } catch (error) {
    console.error("Error en procesarPreguntaChat:", error);
    return "🐝 Ocurrió un contratiempo al procesar la solicitud. Intenta de nuevo.";
  }
}

// Función auxiliar para registrar el evento final en JSON
function guardarEventoFinal(db, userId, borrador, lugarFinal, usuario) {
  const nuevoEvento = {
    id: Date.now(),
    title: borrador.title,
    date: borrador.date,
    time: borrador.time,
    location: lugarFinal,
    description: `Agendado por Deseret IA a petición de ${usuario?.name || 'Líder'}`,
    organizationId: usuario?.organizationId || 1,
    createdBy: usuario?.name || 'Deseret IA',
    createdAt: new Date().toISOString()
  };

  db.events = db.events || [];
  db.events.push(nuevoEvento);
  save(db);

  delete borradoresPendientes[userId];

  return `✅ **¡Evento agendado exitosamente en el Calendario!**\n\n` +
         `📅 **Actividad:** ${nuevoEvento.title}\n` +
         `📆 **Fecha:** ${nuevoEvento.date}\n` +
         `⏰ **Hora:** ${nuevoEvento.time}\n` +
         `📍 **Lugar exacto:** ${nuevoEvento.location}\n` +
         `👤 **Registrado por:** ${nuevoEvento.createdBy}\n\n` +
         `*El evento ya está visible en el calendario del barrio.*`;
}
