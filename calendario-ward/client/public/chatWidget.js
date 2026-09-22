export function initChatWidget() {
  // 1. Inyectamos el widget si no existe en el DOM
  if (!document.getElementById('organiza-chat-widget')) {
    const chatHTML = `
      <div id="organiza-chat-widget">
        <div id="chat-window" style="display: none;">
          <div id="chat-header">
            <span>🐝 Deseret (IA)</span>
            <button id="chat-close-btn">✕</button>
          </div>
          <div id="chat-messages">
            <div class="msg bot">¡Hola! Soy Deseret, la abeja asistente de OrganizaSion. ¿En qué te puedo ayudar hoy?</div>
          </div>
          
          <!-- Chips de sugerencias rápidas -->
          <div id="chat-suggestions" style="padding: 6px 10px; display: flex; gap: 6px; overflow-x: auto; background: #f0f2f5; border-top: 1px solid #e4e6eb;">
            <button class="chat-chip" data-query="¿Qué actividades hay esta semana?" style="white-space: nowrap; background: #ffffff; border: 1px solid #0056b3; color: #0056b3; border-radius: 16px; padding: 4px 10px; font-size: 11.5px; cursor: pointer; font-weight: 500;">📅 Actividades esta semana</button>
            <button class="chat-chip" data-query="¿A quién le toca el turno de aseo de la capilla?" style="white-space: nowrap; background: #ffffff; border: 1px solid #0056b3; color: #0056b3; border-radius: 16px; padding: 4px 10px; font-size: 11.5px; cursor: pointer; font-weight: 500;">🧹 Turnos de aseo</button>
            <button class="chat-chip" data-query="¿Quiénes tienen recomendación del templo vigente?" style="white-space: nowrap; background: #ffffff; border: 1px solid #0056b3; color: #0056b3; border-radius: 16px; padding: 4px 10px; font-size: 11.5px; cursor: pointer; font-weight: 500;">🏛️ Recomendaciones templo</button>
          </div>

          <div id="chat-input-area">
            <input type="text" id="chat-input" placeholder="Pregunta algo..." />
            <button id="chat-send-btn">Enviar</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', chatHTML);

    const chatWindow = document.getElementById('chat-window');
    const closeBtn = document.getElementById('chat-close-btn');

    const toggleChat = () => {
      chatWindow.style.display = chatWindow.style.display === 'none' ? 'flex' : 'none';
    };

    closeBtn.addEventListener('click', toggleChat);

    // Lógica para enviar mensajes
    const sendMessage = async (textoPersonalizado = null) => {
      const input = document.getElementById('chat-input');
      const text = textoPersonalizado || input.value.trim();
      if (!text) return;

      const messagesDiv = document.getElementById('chat-messages');
      messagesDiv.innerHTML += `<div class="msg user">${text}</div>`;
      if (!textoPersonalizado) input.value = '';

      // Ocultar sugerencias rápidas tras la primera pregunta para ahorrar espacio
      const suggestionsDiv = document.getElementById('chat-suggestions');
      if (suggestionsDiv) suggestionsDiv.style.display = 'none';

      const loadingId = 'loading-' + Date.now();
      messagesDiv.innerHTML += `<div id="${loadingId}" class="msg bot">Pensando... 🐝</div>`;
      messagesDiv.scrollTop = messagesDiv.scrollHeight;

      try {
        const response = await fetch('/api/chat', { 
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mensaje: text })
        });
        const data = await response.json();
        
        const loadingEl = document.getElementById(loadingId);
        if (loadingEl) loadingEl.remove();

        const respuestaTexto = data.respuesta || data.error || 'No pude procesar la respuesta.';

        // Parser con soporte de negritas, saltos de línea y viñetas
        const respuestaFormatted = respuestaTexto
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/^\*\s(.*)/gm, '• $1')
          .replace(/\n/g, '<br>');

        messagesDiv.innerHTML += `<div class="msg bot">${respuestaFormatted}</div>`;
      } catch (error) {
        const loadingEl = document.getElementById(loadingId);
        if (loadingEl) loadingEl.remove();
        messagesDiv.innerHTML += `<div class="msg bot error">Error de conexión.</div>`;
      }
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    };

    // Evento para los botones de sugerencias rápidas (Chips)
    document.querySelectorAll('.chat-chip').forEach(button => {
      button.addEventListener('click', (e) => {
        const query = e.target.getAttribute('data-query');
        sendMessage(query);
      });
    });

    document.getElementById('chat-send-btn').addEventListener('click', () => sendMessage());
    document.getElementById('chat-input').addEventListener('keypress', (e) => { 
      if (e.key === 'Enter') sendMessage(); 
    });
  }

  // 2. Observer para mantener la abeja del header conectada
  const asociarBotonHeader = () => {
    const toggleChat = () => {
      const windowEl = document.getElementById('chat-window');
      if (windowEl) {
        windowEl.style.display = windowEl.style.display === 'none' ? 'flex' : 'none';
      }
    };

    const logoOriginal = document.querySelector('header img') || 
                         document.querySelector('.logo img') || 
                         document.querySelector('img[src*="logo"]');

    if (logoOriginal && !document.getElementById('deseret-header-btn')) {
      const btnDeseret = document.createElement('button');
      btnDeseret.id = 'deseret-header-btn';
      btnDeseret.title = 'Hablar con Deseret (IA)';
      btnDeseret.innerHTML = `<img src="./logo-bee.png" alt="Deseret IA" />`;
      btnDeseret.addEventListener('click', toggleChat);

      logoOriginal.parentNode.replaceChild(btnDeseret, logoOriginal);
    }
  };

  asociarBotonHeader();

  const observer = new MutationObserver(() => {
    asociarBotonHeader();
  });

  observer.observe(document.body, { childList: true, subtree: true });
}
