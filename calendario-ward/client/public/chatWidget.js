export function initChatWidget() {
  // 1. Estilos CSS para animación del micrófono y eliminar recuadros celestes (focus outline)
  const style = document.createElement('style');
  style.innerHTML = `
    #organiza-chat-widget button, #deseret-header-btn, .chat-btn, #chat-reset-btn, #chat-mic-btn {
      outline: none !important;
      -webkit-tap-highlight-color: transparent !important;
      box-shadow: none !important;
    }
    #organiza-chat-widget button:focus, #deseret-header-btn:focus, #chat-reset-btn:focus, #chat-mic-btn:focus {
      outline: none !important;
      box-shadow: none !important;
    }
    @keyframes pulse-red {
      0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(220, 53, 69, 0.7); }
      70% { transform: scale(1.08); box-shadow: 0 0 0 8px rgba(220, 53, 69, 0); }
      100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(220, 53, 69, 0); }
    }
    .mic-listening {
      background-color: #dc3545 !important;
      color: white !important;
      border-color: #dc3545 !important;
      animation: pulse-red 1.2s infinite;
    }
  `;
  document.head.appendChild(style);

  // 2. Inyectamos la ventana desplegable del chat
  if (!document.getElementById('organiza-chat-widget')) {
    const chatHTML = `
      <div id="organiza-chat-widget">
        <div id="chat-window" style="display: none;">
          <div id="chat-header">
            <span>🐝 Deseret (IA)</span>
            <div>
              <button id="chat-reset-btn" title="Reiniciar conversación">🔄</button>
              <button id="chat-close-btn" title="Cerrar">✕</button>
            </div>
          </div>
          <div id="chat-messages">
            <div class="msg bot">¡Hola! Soy Deseret, la abeja asistente de OrganizaSion. ¿En qué te puedo ayudar hoy?</div>
          </div>
          <div id="chat-input-area">
            <button id="chat-mic-btn" title="Dictar por voz">🎙️</button>
            <input type="text" id="chat-input" placeholder="Pregunta algo..." />
            <button id="chat-send-btn">Enviar</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', chatHTML);
  }

  const chatWindow = document.getElementById('chat-window');
  const closeBtn = document.getElementById('chat-close-btn');
  const resetBtn = document.getElementById('chat-reset-btn');
  const micBtn = document.getElementById('chat-mic-btn');
  const chatInput = document.getElementById('chat-input');
  const messagesDiv = document.getElementById('chat-messages');

  const toggleChat = () => {
    chatWindow.style.display = chatWindow.style.display === 'none' ? 'flex' : 'none';
    if (chatWindow.style.display === 'flex') chatInput.focus();
  };

  if (closeBtn) closeBtn.addEventListener('click', toggleChat);

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      messagesDiv.innerHTML = `<div class="msg bot">¡Hola! Conversación reiniciada. ¿Qué necesitas saber?</div>`;
      chatInput.value = '';
    });
  }

  // 3. Reemplazar logo del header
  const reemplazarLogoPorBoton = () => {
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

  reemplazarLogoPorBoton();
  setTimeout(reemplazarLogoPorBoton, 600);

  // 4. Reconocimiento de Voz
  let stopListeningState = () => {};

  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.lang = 'es-ES';
    recognition.continuous = false;
    recognition.interimResults = false;

    let isListening = false;

    stopListeningState = () => {
      isListening = false;
      if (micBtn) {
        micBtn.classList.remove('mic-listening');
        micBtn.title = 'Dictar por voz';
      }
      chatInput.placeholder = 'Pregunta algo...';
      try { recognition.stop(); } catch(e) {}
    };

    if (micBtn) {
      micBtn.addEventListener('click', () => {
        if (!isListening) {
          try {
            recognition.start();
          } catch (e) {
            console.warn('El reconocimiento ya estaba activo');
          }
        } else {
          stopListeningState();
        }
      });
    }

    recognition.onstart = () => {
      isListening = true;
      if (micBtn) {
        micBtn.classList.add('mic-listening');
        micBtn.title = 'Escuchando... Haz clic para detener';
      }
      chatInput.placeholder = 'Escuchando tu voz... 🎙️';
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      chatInput.value = transcript;
    };

    recognition.onerror = () => stopListeningState();
    recognition.onend = () => stopListeningState();
  } else if (micBtn) {
    micBtn.style.display = 'none';
  }

  // 5. Lógica para enviar mensajes y limpiar la caja
  const sendMessage = async () => {
    // Apagamos la escucha si estaba activa
    stopListeningState();

    const text = chatInput.value.trim();
    if (!text) return;

    // Pintar mensaje
    messagesDiv.innerHTML += `<div class="msg user">${text}</div>`;
    
    // LIMPIEZA INMEDIATA: Vaciar la casilla para que no quede el texto dictado
    chatInput.value = '';

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

  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) sendBtn.addEventListener('click', sendMessage);

  if (chatInput) {
    chatInput.addEventListener('keypress', (e) => { 
      if (e.key === 'Enter') sendMessage(); 
    });
  }
}
