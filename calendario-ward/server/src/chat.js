import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import { load, save } from './db.js';

// Cache local en memoria para respuestas ultrarrápidas (<10 ms)
const cacheRespuestas = new Map();

export async function procesarPreguntaChat(mensaje, historial = []) {
  try {
    const db = load();
    const hoyObj = new Date();
    const hoy = hoyObj.toISOString().split('T')[0];
    const mensajeMinusculas = mensaje.toLowerCase().trim();

    // ------------------------------------------------------------------------
    // MÓDULO 1: AGENDAMIENTO Y CREACIÓN DE ACTIVIDADES / REUNIONES EN DB.JSON
    // ------------------------------------------------------------------------
    if (mensajeMinusculas.match(/(agendar|crear|programar|añadir|agregar)\s+(actividad|reunión|reunion|evento)/)) {
      
      // 1. Extraer título limpio
      let titulo = mensaje
        .replace(/(agendar|crear|programar|añadir|agregar)\s+(una|un|la|el)?\s*(actividad|reunión|reunion|evento)?\s*(de|para)?/i, '')
        .trim();
      
      if (!titulo) titulo = "Nueva Actividad / Reunión";

      // 2. Extraer fecha (formato AAAA-MM-DD o 'mañana')
      let fechaEvento = hoy;
      const fechaMatch = mensaje.match(/\d{4}-\d{2}-\d{2}/);
      
      if (fechaMatch) {
        fechaEvento = fechaMatch[0];
      } else if (mensajeMinusculas.includes('mañana') || mensajeMinusculas.includes('manana')) {
        const mananaObj = new Date(hoyObj);
        mananaObj.setDate(hoyObj.getDate() + 1);
        fechaEvento = mananaObj.toISOString().split('T')[0];
      }

      // 3. Mapear organización
      let orgId = 1; // General por defecto
      const orgs = db.organizations || [];

      if (mensajeMinusculas.includes('élderes') || mensajeMinusculas.includes('elderes') || mensajeMinusculas.includes('cuórum') || mensajeMinusculas.includes('cuorum')) {
        const org = orgs.find(o => o.name.toLowerCase().includes('élderes') || o.name.toLowerCase().includes('elderes'));
        if (org) orgId = org.id;
      } else if (mensajeMinusculas.includes('sociedad') || mensajeMinusculas.includes('socorro')) {
        const org = orgs.find(o => o.name.toLowerCase().includes('socorro'));
        if (org) orgId = org.id;
      } else if (mensajeMinusculas.includes('jóvenes') || mensajeMinusculas.includes('jovenes')) {
        const org = orgs.find(o => o.name.toLowerCase().includes('jóvenes') || o.name.toLowerCase().includes('jovenes'));
        if (org) orgId = org.id;
      }

      // 4. Crear registro y guardar en db.json usando save() de db.js
      const nuevoEvento = {
        id: Date.now(),
        title: titulo.charAt(0).toUpperCase() + titulo.slice(1),
        date: fechaEvento,
        organizationId: Number(orgId)
      };

      if (!db.events) db.events = [];
      db.events.push(nuevoEvento);
      
      // Escritura persistente
      save(db);

      // Limpiar caché previa para reflejar el evento de inmediato
      cacheRespuestas.clear();

      return `✅ **¡Actividad agendada con éxito en la base de datos!**\n\n` +
             `• **Título:** ${nuevoEvento.title}\n` +
             `• **Fecha:** ${nuevoEvento.date}\n` +
             `• **Estado:** Guardada en el calendario de OrganizaSion 🐝`;
    }

    // ------------------------------------------------------------------------
    // MÓDULO 2: VERIFICAR CACHÉ DE LECTURA (<10 ms)
    // ------------------------------------------------------------------------
    if (cacheRespuestas.has(mensajeMinusculas)) {
      console.log('⚡ Respuesta entregada desde caché local');
      return cacheRespuestas.get(mensajeMinusculas);
    }

    let contextoDinamico = "";
    let respuestaLocalFallback = "";

    // Módulo Actividades / Calendario
    if (mensajeMinusculas.match(/(actividad|actividades|calendario|cuórum|cuorum|élderes|elderes|sociedad|primaria|jóvenes|jovenes|fin de semana|mes|próximo|proximo)/)) {
      let filtroEventos = (db.events || []).filter(e => e.date >= hoy);

      if (mensajeMinusculas.includes('fin de semana')) {
        const sabado = new Date(hoyObj);
        sabado.setDate(hoyObj.getDate() + ((6 - hoyObj.getDay() + 7) % 7));
        const domingo = new Date(sabado);
        domingo.setDate(sabado.getDate() + 1);
        
        const fSab = sabado.toISOString().split('T')[0];
        const fDom = domingo.toISOString().split('T')[0];
        filtroEventos = filtroEventos.filter(e => e.date === fSab || e.date === fDom);
      }

      const actividades = filtroEventos.map(e => {
        const org = (db.organizations || []).find(o => Number(o.id) === Number(e.organizationId));
        return { titulo: e.title, fecha: e.date, organizacion: org ? org.name : 'General' };
      });

      contextoDinamico += "\n--- ACTIVIDADES ENCONTRADAS EN EL CALENDARIO ---\n" + JSON.stringify(actividades);

      if (actividades.length > 0) {
        respuestaLocalFallback = "📅 **Actividades encontradas en el calendario:**\n\n" + 
          actividades.map(a => `• **${a.titulo}** (${a.organizacion}) - Fecha: **${a.fecha}**`).join("\n");
      } else {
        respuestaLocalFallback = "📅 No encontré actividades agendadas para el periodo consultado.";
      }
    }

    // Módulo Aseo
    if (mensajeMinusculas.match(/(aseo|limpieza|limpiar|edificio|capilla|turno|familia)/)) {
      const turnosAseo = (db.cleaningShifts || [])
        .filter(t => t.date >= hoy)
        .map(t => {
           const fam = (db.families || []).find(f => Number(f.id) === Number(t.familyId));
           return { fecha: t.date, familia: fam ? fam.name : 'Sin asignar' };
        });

      contextoDinamico += "\n--- TURNOS DE ASEO ---\n" + JSON.stringify(turnosAseo);

      if (turnosAseo.length > 0) {
        respuestaLocalFallback = "🧹 **Próximos turnos de aseo del edificio:**\n\n" + 
          turnosAseo.map(t => `• Fecha: **${t.fecha}** - Familia: **${t.familia}**`).join("\n");
      }
    }

    // Módulo Directorio y Templo
    if (mensajeMinusculas.match(/(recomendación|recomendacion|templo|porcentaje|cuántos|cuantos|jóvenes|jovenes|adultos|cumpleaños|miembros)/)) {
      const miembros = db.directoryMembers || [];
      const totalMiembros = miembros.length;
      const conRecomendacion = miembros.filter(m => m.templeRecommend).length;
      const porcentajeVigente = totalMiembros > 0 ? Math.round((conRecomendacion / totalMiembros) * 100) : 0;

      const metricas = {
        totalMiembros,
        porcentajeConRecomendacionVigente: `${porcentajeVigente}%`,
        miembrosDetalle: miembros.map(m => ({
          nombre: m.fullName || m.name,
          genero: m.sex,
          fechaNacimiento: m.birthDate,
          recomendacion: m.templeRecommend ? 'Vigente' : 'No vigente'
        }))
      };

      contextoDinamico += "\n--- ESTADÍSTICAS Y DIRECTORIO DE MIEMBROS ---\n" + JSON.stringify(metricas);

      if (mensajeMinusculas.includes('porcentaje') || mensajeMinusculas.includes('cuántos') || mensajeMinusculas.includes('cuantos')) {
        respuestaLocalFallback = `🏛️ **Estadísticas de Recomendación del Templo:**\n\n` +
          `• Un **${porcentajeVigente}%** de los miembros registrados tiene su recomendación del templo vigente (${conRecomendacion} de ${totalMiembros} miembros).`;
      }
    }

    if (contextoDinamico === "") {
      contextoDinamico = "El usuario está saludando o haciendo una consulta general. Invítalo a consultar o agendar actividades, aseo o información del barrio.";
      respuestaLocalFallback = "🐝 ¡Hola! Puedo ayudarte a consultar o **agendar** actividades en el calendario, revisar los turnos de aseo o verificar recomendaciones del templo. ¿Qué te gustaría hacer?";
    }

    const systemInstruction = `Eres Deseret, la abeja asistente de OrganizaSion.
Aquí tienes la información extraída de la base de datos:
${contextoDinamico}

REGLAS DE COMPORTAMIENTO:
1. Responde preguntas de CONSULTA E INFORMACIÓN directamente. NUNCA menciones restricciones de permisos.
2. NUNCA respondas en un solo párrafo gigante. Usa listas ordenadas con viñetas.
3. Pon en **negrita** los títulos de actividades, nombres de familias y fechas.
4. Usa emojis amigables (🐝, 📅, 🧹, 🏛️).`;

    // ------------------------------------------------------------------------
    // CAPA 1: MODELO PRINCIPAL (GEMINI 3.6 FLASH)
    // ------------------------------------------------------------------------
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const ai = new GoogleGenAI({ apiKey: geminiKey });
        const response = await ai.models.generateContent({
          model: 'gemini-3.6-flash',
          contents: mensaje,
          config: { systemInstruction }
        });

        if (response && response.text) {
          console.log('🤖 Respuesta generada exitosamente con Gemini 3.6 Flash');
          cacheRespuestas.set(mensajeMinusculas, response.text);
          return response.text;
        }
      } catch (errGemini) {
        console.warn('⚠️ Gemini falló (saturación/cuota). Pasando a Groq...');
      }
    }

    // ------------------------------------------------------------------------
    // CAPA 2: RESPALDO DE EMERGENCIA (GROQ LLaMA 3.3 70B)
    // ------------------------------------------------------------------------
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      try {
        const groq = new Groq({ apiKey: groqKey });
        const completion = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: mensaje }
          ],
          temperature: 0.5,
          max_tokens: 1024
        });

        const respuestaGroq = completion.choices[0]?.message?.content;
        if (respuestaGroq) {
          console.log('🚀 Respuesta generada exitosamente con Groq');
          cacheRespuestas.set(mensajeMinusculas, respuestaGroq);
          return respuestaGroq;
        }
      } catch (errGroq) {
        console.warn('⚠️ Groq falló. Usando Fallback Local...');
      }
    }

    // ------------------------------------------------------------------------
    // CAPA 3: FALLBACK LOCAL OFFLINE (Cero consumo de API)
    // ------------------------------------------------------------------------
    if (respuestaLocalFallback) {
      console.log('🛡️ Respuesta entregada por Fallback Local');
      return respuestaLocalFallback;
    }

    return "🐝 No pude procesar tu solicitud en este momento. Por favor intenta de nuevo.";

  } catch (error) {
    console.error("DETALLE DEL ERROR GENERAL:", error);
    return "🐝 Ocurrió un inconveniente al procesar la solicitud. Intenta de nuevo.";
  }
}
