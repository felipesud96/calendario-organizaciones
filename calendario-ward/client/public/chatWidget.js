export function initChatWidget() {
  // 1. Inyectamos la ventana desplegable del chat si no existe
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
    const sendMessage = async () => {
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      if (!text) return;

      const messagesDiv = document.getElementById('chat-messages');
      messagesDiv.innerHTML += `<div class="msg user">${text}</div>`;
      input.value = '';
      
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

        // Formato visual: negritas y saltos de línea
        const respuestaFormatted = respuestaTexto
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/\n/g, '<br>');

        messagesDiv.innerHTML += `<div class="msg bot">${respuestaFormatted}</div>`;
      } catch (error) {
        const loadingEl = document.getElementById(loadingId);
        if (loadingEl) loadingEl.remove();
        messagesDiv.innerHTML += `<div class="msg bot error">Error de conexión.</div>`;
      }
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    };

    document.getElementById('chat-send-btn').addEventListener('click', sendMessage);
    document.getElementById('chat-input').addEventListener('keypress', (e) => { 
      if (e.key === 'Enter') sendMessage(); 
    });
  }

  // 2. Vinculación robusta mediante MutationObserver
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
// En chatWidget.js: enviar array 'historial'
const payload = { mensaje: text, historial: mensajesAnteriores };
  // Ejecución inmediata
  asociarBotonHeader();

  // Escuchar cambios en el DOM para cuando la vista cambie dinámicamente
  const observer = new MutationObserver(() => {
    asociarBotonHeader();
  });

  observer.observe(document.body, { childList: true, subtree: true });
}
