// Escapa HTML antes de insertarlo con innerHTML — sin esto, tanto lo que
// escribe el usuario como lo que responde la IA (que puede citar texto
// libre de la base de datos, ej. el título de una actividad) se insertaban
// tal cual en el DOM, permitiendo XSS almacenado (ej. un título de
// actividad "<img src=x onerror=alert(1)>" se habría ejecutado para
// cualquiera que viera esa respuesta). Se usa textContent -> innerHTML, el
// truco estándar del navegador para escapar sin depender de una librería.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

export function initChatWidget() {
  // 1. Estilos CSS (Eliminación de contorno azul, pulso de micrófono y tarjetas)
  const style = document.createElement('style');
  style.id = 'deseret-styles';
  style.innerHTML = `
    /* Logo de la barra superior = botón de Deseret */
    .topbar-logo.deseret-trigger {
      cursor: pointer;
      border-radius: 50%;
      transition: transform .15s ease;
    }
    .topbar-logo.deseret-trigger:hover { transform: scale(1.08); }
    .topbar-logo.deseret-trigger:active { transform: scale(.95); }
    .deseret-logo-wrap { position: relative; display: inline-flex; }
    .deseret-logo-wrap::after {
      content: 'IA';
      position: absolute; right: -6px; bottom: -4px;
      background: var(--celeste, #0ea5e9); color: #fff;
      font-size: 9px; font-weight: 700; line-height: 1;
      padding: 2px 4px; border-radius: 6px;
      pointer-events: none;
    }

    /* Ventana del chat */
    #chat-window {
      position: fixed; right: 16px; bottom: 16px; z-index: 1000;
      width: 370px; max-width: calc(100vw - 32px);
      height: 540px; max-height: calc(100vh - 32px);
      flex-direction: column;
      background: var(--white, #fff); color: var(--ink, #0f172a);
      border: 1px solid var(--border, #dbeafe);
      border-radius: var(--radius, 12px);
      box-shadow: var(--shadow-lg, 0 10px 30px rgba(3,105,161,.18));
      overflow: hidden;
    }
    #chat-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 12px; font-weight: 700;
      background: var(--celeste, #0ea5e9); color: #fff;
    }
    #chat-header button {
      background: transparent; border: 0; color: #fff;
      font-size: 16px; cursor: pointer; padding: 4px 6px;
    }
    #chat-messages {
      flex: 1; overflow-y: auto; padding: 12px;
      display: flex; flex-direction: column; gap: 8px;
      background: var(--celeste-lighter, #f0f9ff);
    }
    #chat-messages .msg {
      max-width: 85%; padding: 8px 11px; border-radius: 12px;
      font-size: 14px; line-height: 1.4; word-wrap: break-word;
    }
    #chat-messages .msg.bot {
      align-self: flex-start;
      background: var(--white, #fff); border: 1px solid var(--border, #dbeafe);
    }
    #chat-messages .msg.user {
      align-self: flex-end; background: var(--celeste, #0ea5e9); color: #fff;
    }
    #chat-messages .msg.error { border-color: var(--danger, #ef4444); color: var(--danger, #ef4444); }
    #chat-input-area {
      display: flex; gap: 6px; padding: 8px;
      border-top: 1px solid var(--border, #dbeafe);
      background: var(--white, #fff);
    }
    #chat-input {
      flex: 1; min-width: 0; padding: 8px 10px; font-size: 16px;
      border: 1px solid var(--border, #dbeafe); border-radius: 8px;
      background: var(--white, #fff); color: var(--ink, #0f172a);
    }
    #chat-send-btn, #chat-mic-btn {
      border: 1px solid var(--border, #dbeafe); border-radius: 8px;
      padding: 0 10px; cursor: pointer;
      background: var(--celeste-lighter, #f0f9ff); color: var(--ink, #0f172a);
    }
    #chat-send-btn { background: var(--celeste, #0ea5e9); color: #fff; border-color: var(--celeste, #0ea5e9); font-weight: 600; }
    @media (max-width: 600px) {
      #chat-window {
        right: 0; bottom: 0; width: 100vw; max-width: 100vw;
        height: 100dvh; max-height: 100dvh; border-radius: 0; border: 0;
      }
    }

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

  // El logo de la abeja de la barra superior abre a Deseret.
  // app.js vuelve a dibujar la barra (innerHTML) en cada cambio de vista y
  // después de iniciar sesión, así que reemplazar el <img> una sola vez al
  // cargar (como se hacía antes) no servía: el logo nuevo llegaba sin el
  // botón. Ahora: 1) el clic se escucha en el documento (delegación), y
  // 2) un MutationObserver marca el logo cada vez que la barra se redibuja.
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.topbar-logo, #deseret-header-btn')) {
      e.preventDefault();
      toggleChat();
    }
  });

  const marcarLogo = () => {
    const logo = document.querySelector('.topbar-logo');
    if (!logo) {
      // Sin barra superior = pantalla de login: se cierra el chat.
      if (chatWindow.style.display !== 'none') chatWindow.style.display = 'none';
      return;
    }
    if (logo.classList.contains('deseret-trigger')) return;
    logo.classList.add('deseret-trigger');
    logo.setAttribute('title', 'Hablar con Deseret (IA)');
    logo.setAttribute('role', 'button');
    logo.setAttribute('tabindex', '0');
    logo.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleChat(); }
    });
    if (!logo.parentElement.classList.contains('deseret-logo-wrap')) {
      const wrap = document.createElement('span');
      wrap.className = 'deseret-logo-wrap';
      logo.parentNode.insertBefore(wrap, logo);
      wrap.appendChild(logo);
    }
  };
  marcarLogo();
  new MutationObserver(marcarLogo).observe(document.getElementById('app') || document.body, { childList: true, subtree: true });

  // 3. Reconocimiento de Voz con Auto-Envío e Indicador Visual (Puntos 1 y 4)
  let autoSendTimer = null;
  let stopListeningState = () => {};

  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.lang = 'es-CL';
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

    messagesDiv.innerHTML += `<div class="msg user">${escapeHtml(text)}</div>`;
    chatInput.value = '';

    const loadingId = 'loading-' + Date.now();
    messagesDiv.innerHTML += `<div id="${loadingId}" class="msg bot">Pensando... 🐝</div>`;
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    try {
      // Mismo storage/clave que usa app.js ('cow_token') para guardar la
      // sesión — antes este fetch no mandaba el header Authorization (un
      // commit lo había agregado pero quedó pisado por una actualización
      // posterior del widget), así que /api/chat rechazaba todo con 401
      // apenas se exigió login para usar a Deseret.
      const token = localStorage.getItem('cow_token');
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
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

      // Se escapa PRIMERO y recién después se aplican los reemplazos de
      // negrita/salto de línea — así "**" y "\n" se siguen viendo bien, pero
      // cualquier HTML que venga en la respuesta (de la IA o de datos de la
      // base de datos) queda como texto plano, no como markup ejecutable.
      const respuestaFormatted = escapeHtml(respuestaTexto)
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<em>$2</em>')
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
      const btn = el.querySelector('.btn-action');
      if (!btn) return;
      const original = btn.textContent;
      btn.textContent = '✅ Copiado';
      setTimeout(() => { btn.textContent = original; }, 1500);
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
