export function initChatWidget() {
  if (document.getElementById('organiza-chat-widget')) return;

  const obtenerRolUsuario = () => {
    try {
      const userJson = localStorage.getItem('user');
      if (userJson) return (JSON.parse(userJson).role || JSON.parse(userJson).cargo || '').toLowerCase();
      const token = localStorage.getItem('token');
      if (token) return (JSON.parse(atob(token.split('.')[1])).role || '').toLowerCase();
    } catch (e) {}
    return '';
  };

  const rol = obtenerRolUsuario();
  const esAutorizado = /(obispo|cuorum|quorum|sociedad|soc_soc|admin|presidente|consejero|secretario|elderes)/.test(rol);

  let chipsHTML = `
    <button class="chat-chip-btn" data-query="¿Qué actividades hay esta semana?">📅 ¿Qué actividades hay esta semana?</button>
    <button class="chat-chip-btn" data-query="¿A quién le toca el turno de aseo?">🧹 ¿A quién le toca el turno de aseo?</button>
  `;
  if (esAutorizado) {
    chipsHTML += `<button class="chat-chip-btn" data-query="¿Quiénes tienen recomendación vigente?">🏛️ ¿Quiénes tienen recomendación vigente?</button>`;
  }

  // Estilos inyectados: elimina borde celeste (outline) y añade la animación del micrófono en rojo
  const styles = `
    <style>
      #deseret-header-btn, .chat-chip-btn, .option-btn, #chat-mic-btn, #chat-send-btn {
        outline: none !important;
        -webkit-tap-highlight-color: transparent !important;
      }
      #deseret-header-btn:focus, #deseret-header-btn:active {
        outline: none !important;
        border: none !important;
        box-shadow: none !important;
      }
      .mic-recording {
        background-color: #ff3b30 !important;
        color: white !important;
        animation: pulse-mic 1.2s infinite;
      }
      @keyframes pulse-mic {
        0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(255, 59, 48, 0.7); }
        70% { transform: scale(1.1); box-shadow: 0 0 0 10px rgba(255, 59, 48, 0); }
        100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(255, 59, 48, 0); }
      }
    </style>
  `;
  document.head.insertAdjacentHTML('beforeend', styles);

  const chatHTML = `
    <div id="organiza-chat-widget">
      <div id="chat-window" style="display: none;">
        <div id="chat-header">
          <span>🐝 Deseret (IA)</span>
          <button id="chat-close-btn">✕</button>
        </div>
        <div id="chat-messages">
          <div class="msg bot">¡Hola! Soy Deseret. ¿En qué te puedo ayudar hoy?</div>
          <div id="chat-suggestions-list">${chipsHTML}</div>
        </div>

        <div id="chat-input-area" style="display: flex; gap: 6px; padding: 8px; background: #fff; align-items: center;">
          <button id="chat-mic-btn" title="Dictar por micrófono" style="background: #f0f2f5; border: 1px solid #ccc; border-radius: 50%; width: 38px; height: 38px; cursor: pointer; flex-shrink: 0; font-size: 16px;">🎤</button>
          <input type="text" id="chat-input" placeholder="Pregunta algo o agenda una actividad..." style="flex: 1; padding: 8px 12px; border-radius: 20px; border: 1px solid #ccc;" />
          <button id="chat-send-btn" style="background: #0056b3; color: white; border: none; border-radius: 18px; padding: 0 14px; height: 36px; cursor: pointer; font-weight: 500;">Enviar</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', chatHTML);

  const chatWindow = document.getElementById('chat-window');
  const closeBtn = document.getElementById('chat-close-btn');
  const inputEl = document.getElementById('chat-input');
  const micBtn = document.getElementById('chat-mic-btn');

  closeBtn.addEventListener('click', () => chatWindow.style.display = 'none');

  // RECONOCIMIENTO DE VOZ CON ESTADO VISUAL CLARO
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = 'es-ES';

    micBtn.addEventListener('click', () => {
      micBtn.classList.add('mic-recording');
      inputEl.placeholder = "Escuchando tu voz... 🎙️";
      recognition.start();
    });

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      inputEl.value = transcript;
      micBtn.classList.remove('mic-recording');
      inputEl.placeholder = "Pregunta algo o agenda una actividad...";
      sendMessage(transcript);
    };

    recognition.onerror = () => {
      micBtn.classList.remove('mic-recording');
      inputEl.placeholder = "Pregunta algo o agenda una actividad...";
    };

    recognition.onend = () => {
      micBtn.classList.remove('mic-recording');
      inputEl.placeholder = "Pregunta algo o agenda una actividad...";
    };
  } else {
    micBtn.style.display = 'none';
  }

  // ENVÍO DE MENSAJES Y MANEJO DE OPCIONES INTERACTIVAS
  const sendMessage = async (textoPersonalizado = null) => {
    const text = textoPersonalizado || inputEl.value.trim();
    if (!text) return;

    const messagesDiv = document.getElementById('chat-messages');
    messagesDiv.innerHTML += `<div class="msg user">${text}</div>`;
    if (!textoPersonalizado) inputEl.value = '';

    const suggestionsList = document.getElementById('chat-suggestions-list');
    if (suggestionsList) suggestionsList.style.display = 'none';

    const loadingId = 'loading-' + Date.now();
    messagesDiv.innerHTML += `<div id="${loadingId}" class="msg bot">Pensando... 🐝</div>`;
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    try {
      const token = localStorage.getItem('token') || '';
      const response = await fetch('/api/chat', { 
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': token ? `Bearer ${token}` : ''
        },
        body: JSON.stringify({ mensaje: text })
      });
      const data = await response.json();
      
      const loadingEl = document.getElementById(loadingId);
      if (loadingEl) loadingEl.remove();

      const respuestaRaw = data.respuesta;
      let respuestaTexto = typeof respuestaRaw === 'object' ? respuestaRaw.texto : respuestaRaw;
      let opciones = typeof respuestaRaw === 'object' ? respuestaRaw.opciones : null;

      const respuestaFormatted = respuestaTexto
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');

      let opcionesHTML = '';
      if (opciones && Array.isArray(opciones)) {
        opcionesHTML = `<div class="options-container" style="display:flex; flex-direction:column; gap:5px; margin-top:8px;">`;
        opciones.forEach(op => {
          opcionesHTML += `<button class="option-btn" data-val="${op}" style="text-align:left; background:#ffffff; border:1px solid #0056b3; color:#0056b3; padding:6px 10px; border-radius:6px; font-size:12px; cursor:pointer; font-weight:500;">🔹 ${op}</button>`;
        });
        opcionesHTML += `</div>`;
      }

      const msgId = 'msg-' + Date.now();
      messagesDiv.innerHTML += `
        <div class="msg bot" id="${msgId}">
          ${respuestaFormatted}${opcionesHTML}
          <button onclick="navigator.clipboard.writeText(\`${respuestaTexto.replace(/`/g, '')}\`)" style="display:block; margin-top:5px; background:none; border:none; color:#0056b3; cursor:pointer; font-size:11px;">📋 Copiar respuesta</button>
        </div>
      `;

    } catch (error) {
      const loadingEl = document.getElementById(loadingId);
      if (loadingEl) loadingEl.remove();
      messagesDiv.innerHTML += `<div class="msg bot error">⚠️ Error de conexión. <button onclick="location.reload()">Reintentar 🔄</button></div>`;
    }
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  };

  document.addEventListener('click', (e) => {
    if (e.target && e.target.classList.contains('chat-chip-btn')) {
      sendMessage(e.target.getAttribute('data-query'));
    }

    if (e.target && e.target.classList.contains('option-btn')) {
      const valorSeleccionado = e.target.getAttribute('data-val');
      const parentContainer = e.target.closest('.options-container');
      if (parentContainer) parentContainer.style.display = 'none';
      sendMessage(valorSeleccionado);
    }
  });

  document.getElementById('chat-send-btn').addEventListener('click', () => sendMessage());
  inputEl.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });

  const asociarBotonHeader = () => {
    const logoOriginal = document.querySelector('header img') || document.querySelector('.logo img') || document.querySelector('img[src*="logo"]');
    if (logoOriginal && !document.getElementById('deseret-header-btn')) {
      const btn = document.createElement('button');
      btn.id = 'deseret-header-btn';
      btn.style.cssText = "outline: none; border: none; background: transparent; padding: 0; cursor: pointer;";
      btn.innerHTML = `<img src="./logo-bee.png" alt="Deseret IA" />`;
      btn.addEventListener('click', () => {
        chatWindow.style.display = chatWindow.style.display === 'none' ? 'flex' : 'none';
      });
      logoOriginal.parentNode.replaceChild(btn, logoOriginal);
    }
  };
  asociarBotonHeader();
  new MutationObserver(asociarBotonHeader).observe(document.body, { childList: true, subtree: true });
}
