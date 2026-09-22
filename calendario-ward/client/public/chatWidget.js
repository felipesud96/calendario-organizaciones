export function initChatWidget() {
  // 1. Estilos CSS (Eliminación de contorno azul, pulso de micrófono y tarjetas)
  const style = document.createElement('style');
  style.innerHTML = `
    #organiza-chat-widget button, #deseret-header-btn, .chat-btn, #chat-reset-btn, #chat-mic-btn {
      outline: none !important;
      -webkit-tap-highlight-color: transparent !important;
      box-shadow: none !important;
    }
    @keyframes pulse-wave {
      0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(220, 53, 69, 0.7); }
      50% { transform: scale(1.1); box-shadow: 0 0 0 10px rgba(220, 53, 69, 0); }
      100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(220, 53, 69, 0); }
    }
    .mic-listening {
      background-color: #dc3545 !important;
      color: white !important;
      border-color: #dc3545 !important;
      animation: pulse-wave 1s infinite ease-in-out;
    }
    .msg-actions {
      display: flex;
      gap: 8px;
      margin-top: 6px;
      font-size: 11px;
    }
    .btn-action {
      background: #eef2f5;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      padding: 3px 8px;
      cursor: pointer;
      color: #334155;
    }
    .btn-action:hover {
      background: #e2e8f0;
    }
  `;
  document.head.appendChild(style);

  // 2. Inyección del Widget en la página
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

  let historialSesion = []; // Memoria de contexto corto (Punto 17)

  const toggleChat = () => {
    chatWindow.style.display = chatWindow.style.display === 'none' ? 'flex' : 'none';
    if (chatWindow.style.display === 'flex') chatInput.focus();
  };

  if (closeBtn) closeBtn.addEventListener('click', toggleChat);

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      historialSesion = [];
      messagesDiv.innerHTML = `<div class="msg bot">¡Hola! Conversación reiniciada. ¿Qué necesitas saber?</div>`;
      chatInput.value = '';
    });
  }

  // Reemplazar logo del Header
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

  // 3. Reconocimiento de Voz con Auto-Envío e Indicador Visual (Puntos 1 y 4)
  let autoSendTimer = null;
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
        micBtn.title = 'Escuchando tu voz...';
      }
      chatInput.placeholder = 'Escuchando tu voz... 🎙️';
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      chatInput.value = transcript;

      // PUNTO 1: Auto-envío automático tras 1.5 segundos de silencio
      clearTimeout(autoSendTimer);
      autoSendTimer = setTimeout(() => {
        sendMessage();
      }, 1500);
    };

    recognition.onerror = () => stopListeningState();
    recognition.onend = () => stopListeningState();
  } else if (micBtn) {
    micBtn.style.display = 'none';
  }

  // 4. Lógica para enviar mensaje con historial integrado (Punto 17)
  const sendMessage = async () => {
    clearTimeout(autoSendTimer);
    stopListeningState();

    const text = chatInput.value.trim();
    if (!text) return;

    messagesDiv.innerHTML += `<div class="msg user">${text}</div>`;
    chatInput.value = '';

    const loadingId = 'loading-' + Date.now();
    messagesDiv.innerHTML += `<div id="${loadingId}" class="msg bot">Pensando... 🐝</div>`;
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    try {
      const response = await fetch('/api/chat', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          mensaje: text,
          historial: historialSesion 
        })
      });
      const data = await response.json();
      
      const loadingEl = document.getElementById(loadingId);
      if (loadingEl) loadingEl.remove();

      const respuestaTexto = data.respuesta || data.error || 'No pude procesar la respuesta.';

      // Guardar en historial de contexto corto (Punto 17)
      historialSesion.push({ user: text, bot: respuestaTexto });
      if (historialSesion.length > 3) historialSesion.shift(); // Conservar últimas 3 interacciones

      const respuestaFormatted = respuestaTexto
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');

      const msgId = 'bot-msg-' + Date.now();

      messagesDiv.innerHTML += `
        <div class="msg bot" id="${msgId}">
          <div>${respuestaFormatted}</div>
          <div class="msg-actions">
            <button class="btn-action" onclick="window.deseretCopy('${msgId}')">📋 Copiar respuesta</button>
          </div>
        </div>
      `;

    } catch (error) {
      const loadingEl = document.getElementById(loadingId);
      if (loadingEl) loadingEl.remove();
      messagesDiv.innerHTML += `<div class="msg bot error">Error de conexión.</div>`;
    }
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  };

  window.deseretCopy = (msgId) => {
    const el = document.getElementById(msgId);
    if (!el) return;
    const textToCopy = el.querySelector('div').innerText;
    navigator.clipboard.writeText(textToCopy).then(() => {
      alert('¡Respuesta copiada al portapapeles!');
    });
  };

  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) sendBtn.addEventListener('click', sendMessage);

  if (chatInput) {
    chatInput.addEventListener('keypress', (e) => { 
      if (e.key === 'Enter') sendMessage(); 
    });
  }
}
