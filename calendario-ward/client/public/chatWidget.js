document.addEventListener('DOMContentLoaded', () => {
  // 1. Inyectamos el HTML del botón flotante y la ventana de chat
  if (!document.getElementById('deseret-chat-widget')) {
    const widgetHTML = `
      <div id="deseret-chat-widget">
        <!-- Botón flotante -->
        <button id="chat-trigger" style="position: fixed; bottom: 20px; right: 20px; width: 60px; height: 60px; border-radius: 50%; background-color: #0056b3; color: white; border: none; box-shadow: 0 4px 10px rgba(0,0,0,0.3); font-size: 28px; cursor: pointer; z-index: 9999; display: flex; align-items: center; justify-content: center;">
          🐝
        </button>

        <!-- Ventana de chat -->
        <div id="chat-window" style="display: none; position: fixed; bottom: 90px; right: 20px; width: 350px; height: 500px; background: white; border-radius: 12px; box-shadow: 0 5px 20px rgba(0,0,0,0.2); z-index: 10000; flex-direction: column; overflow: hidden; font-family: sans-serif;">
          <!-- Cabecera -->
          <div style="background: #0056b3; color: white; padding: 15px; font-weight: bold; display: flex; justify-content: space-between; align-items: center;">
            <span style="display: flex; align-items: center; gap: 8px;">🐝 Deseret (IA)</span>
            <button id="close-chat" style="background: none; border: none; color: white; font-size: 18px; cursor: pointer;">✖</button>
          </div>
          
          <!-- Mensajes -->
          <div id="chat-messages" style="flex: 1; padding: 15px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; background: #f9f9f9;">
            <div class="msg bot" style="background: #e9ecef; color: #333; padding: 10px 14px; border-radius: 15px; align-self: flex-start; max-width: 85%; font-size: 14px; line-height: 1.4;">
              ¡Hola! Soy Deseret, la abeja asistente de OrganizaSion. ¿En qué te puedo ayudar hoy?
            </div>
          </div>
          
          <!-- Input -->
          <div style="padding: 12px; background: white; border-top: 1px solid #ddd; display: flex; gap: 8px;">
            <input type="text" id="chat-input" placeholder="Pregunta algo..." style="flex: 1; padding: 10px 15px; border: 1px solid #ccc; border-radius: 20px; outline: none; font-size: 14px;">
            <button id="send-btn" style="background: #0056b3; color: white; border: none; border-radius: 20px; padding: 0 16px; font-weight: bold; cursor: pointer; font-size: 14px;">Enviar</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', widgetHTML);
  }

  // 2. Referencias a los elementos
  const chatTrigger = document.getElementById('chat-trigger');
  const chatWindow = document.getElementById('chat-window');
  const closeChat = document.getElementById('close-chat');
  const chatInput = document.getElementById('chat-input');
  const sendBtn = document.getElementById('send-btn');
  const messagesDiv = document.getElementById('chat-messages');

  // 3. Lógica para Abrir / Cerrar el chat
  chatTrigger.addEventListener('click', () => {
    chatWindow.style.display = chatWindow.style.display === 'none' ? 'flex' : 'none';
    if (chatWindow.style.display === 'flex') chatInput.focus();
  });

  closeChat.addEventListener('click', () => {
    chatWindow.style.display = 'none';
  });

  // 4. Lógica de enviar mensaje con formateo visual
  const sendMessage = async () => {
    const text = chatInput.value.trim();
    if (!text) return;

    // Dibujar mensaje del usuario
    messagesDiv.innerHTML += `
      <div class="msg user" style="background: #0056b3; color: white; padding: 10px 14px; border-radius: 15px; align-self: flex-end; max-width: 85%; font-size: 14px; line-height: 1.4;">
        ${text}
      </div>
    `;
    chatInput.value = '';
    
    // Indicador de "Pensando..."
    const loadingId = 'loading-' + Date.now();
    messagesDiv.innerHTML += `
      <div id="${loadingId}" class="msg bot" style="background: #e9ecef; color: #333; padding: 10px 14px; border-radius: 15px; align-self: flex-start; max-width: 85%; font-size: 14px;">
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

      // MAGIA DE DISEÑO: Convertir asteriscos a negritas y saltos a <br>
      const textoHermoso = respuestaTexto
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');

      messagesDiv.innerHTML += `
        <div class="msg bot" style="background: #e9ecef; color: #333; padding: 10px 14px; border-radius: 15px; align-self: flex-start; max-width: 85%; font-size: 14px; line-height: 1.4;">
          ${textoHermoso}
        </div>
      `;
    } catch (error) {
      document.getElementById(loadingId).remove();
      messagesDiv.innerHTML += `
        <div class="msg bot error" style="background: #ffebee; color: #c62828; padding: 10px 14px; border-radius: 15px; align-self: flex-start; max-width: 85%; font-size: 14px;">
          Error de conexión. Intenta nuevamente.
        </div>
      `;
    }
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  };

  // 5. Escuchar clic y botón Enter
  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
});
