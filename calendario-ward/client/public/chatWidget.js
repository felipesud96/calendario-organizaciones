document.addEventListener('DOMContentLoaded', () => {
  // 1. Buscamos el logo de la abeja en la parte superior izquierda
  const logoBee = document.querySelector('img[src*="logo-bee"], .logo-bee, header img');

  if (!logoBee) {
    console.warn('No se encontró la imagen del logo para convertir en botón de chat.');
    return;
  }

  // Convertimos el logo en un botón interactivo
  logoBee.style.cursor = 'pointer';
  logoBee.title = 'Haz clic para hablar con Deseret (IA)';

  // 2. Creamos la ventana emergente del chat
  const chatHTML = `
    <div id="deseret-chat-window" style="display: none; position: fixed; top: 70px; left: 20px; width: 340px; height: 480px; background: #ffffff; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.2); z-index: 9999; flex-direction: column; overflow: hidden; font-family: system-ui, -apple-system, sans-serif; border: 1px solid #e0e0e0;">
      <!-- Cabecera -->
      <div style="background: #0056b3; color: white; padding: 12px 16px; font-weight: bold; display: flex; justify-content: space-between; align-items: center;">
        <span style="display: flex; align-items: center; gap: 8px;">🐝 Deseret (IA)</span>
        <button id="close-deseret-chat" style="background: none; border: none; color: white; font-size: 18px; cursor: pointer;">✖</button>
      </div>
      
      <!-- Contenedor de Mensajes -->
      <div id="deseret-messages" style="flex: 1; padding: 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; background: #f8f9fa;">
        <div style="background: #e9ecef; color: #212529; padding: 10px 12px; border-radius: 12px; align-self: flex-start; max-width: 85%; font-size: 13.5px; line-height: 1.4;">
          ¡Hola! 🐝 Soy Deseret, la abeja asistente de OrganizaSion. ¿En qué te puedo ayudar hoy?
        </div>
      </div>
      
      <!-- Input de Texto -->
      <div style="padding: 10px; background: #ffffff; border-top: 1px solid #eee; display: flex; gap: 6px;">
        <input type="text" id="deseret-input" placeholder="Pregunta algo..." style="flex: 1; padding: 8px 12px; border: 1px solid #ccc; border-radius: 20px; outline: none; font-size: 13.5px;">
        <button id="deseret-send" style="background: #0056b3; color: white; border: none; border-radius: 20px; padding: 0 14px; font-weight: bold; cursor: pointer; font-size: 13.5px;">Enviar</button>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', chatHTML);

  const chatWindow = document.getElementById('deseret-chat-window');
  const closeBtn = document.getElementById('close-deseret-chat');
  const sendBtn = document.getElementById('deseret-send');
  const chatInput = document.getElementById('deseret-input');
  const messagesDiv = document.getElementById('deseret-messages');

  // Abrir / Cerrar al hacer clic en el logo de la abeja
  logoBee.addEventListener('click', () => {
    const isHidden = chatWindow.style.display === 'none';
    chatWindow.style.display = isHidden ? 'flex' : 'none';
    if (isHidden) chatInput.focus();
  });

  closeBtn.addEventListener('click', () => {
    chatWindow.style.display = 'none';
  });

  // Enviar mensaje
  const sendMessage = async () => {
    const text = chatInput.value.trim();
    if (!text) return;

    // Mensaje del usuario
    messagesDiv.innerHTML += `
      <div style="background: #0056b3; color: white; padding: 10px 12px; border-radius: 12px; align-self: flex-end; max-width: 85%; font-size: 13.5px; line-height: 1.4;">
        ${text}
      </div>
    `;
    chatInput.value = '';

    // Indicador de pensando
    const loadingId = 'loading-' + Date.now();
    messagesDiv.innerHTML += `
      <div id="${loadingId}" style="background: #e9ecef; color: #6c757d; padding: 10px 12px; border-radius: 12px; align-self: flex-start; max-width: 85%; font-size: 13.5px;">
        Pensando... 🐝
      </div>
    `;
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mensaje: text })
      });
      const data = await response.json();

      document.getElementById(loadingId).remove();
      const respuestaTexto = data.respuesta || data.error || 'No pude procesar la respuesta.';

      // FORMATO BONITO: Convierte **negrita** en HTML real y saltos de línea en espacios
      const textoHermoso = respuestaTexto
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');

      messagesDiv.innerHTML += `
        <div style="background: #e9ecef; color: #212529; padding: 10px 12px; border-radius: 12px; align-self: flex-start; max-width: 85%; font-size: 13.5px; line-height: 1.4;">
          ${textoHermoso}
        </div>
      `;
    } catch (error) {
      document.getElementById(loadingId).remove();
      messagesDiv.innerHTML += `
        <div style="background: #f8d7da; color: #721c24; padding: 10px 12px; border-radius: 12px; align-self: flex-start; max-width: 85%; font-size: 13.5px;">
          Error de conexión. Intenta nuevamente.
        </div>
      `;
    }
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  };

  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
});
