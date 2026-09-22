import { GoogleGenAI } from '@google/genai';
import { load } from './db.js';

// Cache local en memoria (Punto 15)
const cacheRespuestas = new Map();

export async function procesarPreguntaChat(mensaje, historial = []) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const db = load();
    const hoyObj = new Date();
    const hoy = hoyObj.toISOString().split('T')[0];
    const mensajeMinusculas = mensaje.toLowerCase().trim();

    // --- PUNTO 15: VERIFICAR CACHE LOCAL ---
    if (cacheRespuestas.has(mensajeMinusculas)) {
      console.log('⚡ Respuesta entregada desde caché local');
      return cacheRespuestas.get(mensajeMinusculas);
    }

    let contextoDinamico = "";
    let respuestaLocalFallback = "";

    // --- PUNTO 6 y 7: CALENDARIO Y RANGOS TEMPORALES / ORGANIZACIONES COMBINADAS ---
    if (mensajeMinusculas.match(/(actividad|actividades|calendario|cuórum|cuorum|élderes|elderes|sociedad|primaria|jóvenes|jovenes|fin de semana|mes|próximo|proximo)/)) {
      let filtroEventos = db.events.filter(e => e.date >= hoy);

      // Rango relativo: Fin de semana
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
        const org = db.organizations.find(o => Number(o.id) === Number(e.organizationId));
        return { titulo: e.title, fecha: e.date, organizacion: org ? org.name : 'General' };
      });

      contextoDinamico += "\n--- ACTIVIDADES ENCONTRADAS ---\n" + JSON.stringify(actividades);

      // Construir respuesta para Fallback Offline (Punto 16)
      if (actividades.length > 0) {
        respuestaLocalFallback = "📅 **Actividades encontradas en el calendario:**\n\n" + 
          actividades.map(a => `• **${a.titulo}** (${a.organizacion}) - Fecha: **${a.fecha}**`).join("\n");
      } else {
        respuestaLocalFallback = "📅 No encontré actividades agendadas para el periodo consultado.";
      }
    }

    // --- PUNTO 9: BÚSQUEDA DE ASEO POR FAMILIA O TURNO ---
    if (mensajeMinusculas.match(/(aseo|limpieza|limpiar|edificio|capilla|turno|familia)/)) {
      const turnosAseo = db.cleaningShifts
        .filter(t => t.date >= hoy)
        .map(t => {
           const fam = db.families.find(f => Number(f.id) === Number(t.familyId));
           return { fecha: t.date, familia: fam ? fam.name : 'Sin asignar' };
        });

      contextoDinamico += "\n--- TURNOS DE ASEO ---\n" + JSON.stringify(turnosAseo);

      if (turnosAseo.length > 0) {
        respuestaLocalFallback = "🧹 **Próximos turnos de aseo del edificio:**\n\n" + 
          turnosAseo.map(t => `• Fecha: **${t.fecha}** - Familia: **${t.familia}**`).join("\n");
      }
    }

    // --- PUNTO 12 y 13: MÉTRICAS DE RECOMENDACIÓN Y GRUPOS DE EDAD / DIRECTORIO ---
    if (mensajeMinusculas.match(/(recomendación|recomendacion|templo|porcentaje|cuántos|cuantos|jóvenes|jovenes|adultos|cumpleaños|miembros)/)) {
      const totalMiembros = db.directoryMembers.length;
      const conRecomendacion = db.directoryMembers.filter(m => m.templeRecommend).length;
      const porcentajeVigente = totalMiembros > 0 ? Math.round((conRecomendacion / totalMiembros) * 100) : 0;

      const metricas = {
        totalMiembros,
        porcentajeConRecomendacionVigente: `${porcentajeVigente}%`,
        miembrosDetalle: db.directoryMembers.map(m => ({
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
      contextoDinamico = "El usuario está saludando o haciendo una consulta general. Invítalo a consultar sobre actividades, aseo o información del barrio.";
      respuestaLocalFallback = "🐝 ¡Hola! Puedo ayudarte a consultar las actividades del calendario, los turnos de aseo del edificio o las recomendaciones del templo. ¿Qué te gustaría saber?";
    }

    // --- INTENTO CON LA API DE GOOGLE GEMINI ---
    if (apiKey) {
      try {
        const ai = new GoogleGenAI({ apiKey });

        const systemInstruction = `Eres Deseret, la abeja asistente de OrganizaSion.
Aquí tienes la información extraída de la base de datos:
${contextoDinamico}

REGLAS DE COMPORTAMIENTO:
1. Responde preguntas de CONSULTA E INFORMACIÓN directamente. NUNCA menciones restricciones de permisos.
2. NUNCA respondas en un solo párrafo gigante. Usa listas ordenadas con viñetas.
3. Pon en **negrita** los títulos de actividades, nombres de familias y fechas.
4. Usa emojis amigables (🐝, 📅, 🧹, 🏛️).`;

        const response = await ai.models.generateContent({
          model: 'gemini-3.6-flash',
          contents: mensaje,
          config: { systemInstruction }
        });

        if (response && response.text) {
          const resultadoIA = response.text;
          // Guardar en caché para futuras consultas idénticas (Punto 15)
          cacheRespuestas.set(mensajeMinusculas, resultadoIA);
          return resultadoIA;
        }
      } catch (errGoogle) {
        console.warn("⚠️ API de Google no disponible o saturada. Usando Fallback Offline (Punto 16)...");
      }
    }

    // --- PUNTO 16: FALLBACK OFFLINE / RESPUESTA DESDE DB.JSON EN CASO DE ERROR ---
    if (respuestaLocalFallback) {
      return respuestaLocalFallback;
    }

    return "🐝 No pude procesar tu solicitud en este momento. Por favor intenta de nuevo.";

  } catch (error) {
    console.error("DETALLE DEL ERROR EN GEMINI CHAT:", error);
    return "🐝 Ocurrió un inconveniente al consultar la información. Por favor reintenta en unos instantes.";
  }
}
