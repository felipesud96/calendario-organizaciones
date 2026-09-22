export function initChatWidget() {
  if (document.getElementById('organiza-chat-widget')) return;

  const obtenerRolUsuario = () => {
    try {
      const userJson = localStorage.getItem('user');
      if (userJson) return (JSON.parse(userJson).role || '').toLowerCase();
      const token = localStorage.getItem('token');
      if (token) return (JSON.parse(atob(token.split('.')[1])).role || '').toLowerCase();
    } catch (e) {}
    return '';
  };

  const rol = obtenerRolUsuario();
  const esAutorizado = /(obispo|cuorum|sociedad|admin)/.test(rol);

  let chipsHTML = `
    <button class="chat-chip-btn" data-query="¿Qué actividades hay esta semana?">📅 ¿Qué actividades hay esta semana?</button>
    <button class="chat-chip-btn" data-query="¿A quién le toca el turno de aseo?">🧹 ¿A quién le toca el turno de aseo?</button>
  `;
  if (esAutorizado) {
    chipsHTML += `<button class="chat-chip-btn" data-query="¿Quiénes tienen recomendación vigente?">🏛️ ¿Quiénes tienen recomendación vigente?</button>`;
  }

  const chatHTML = `
    <div id="organiza-chat-widget">
      <div id="chat-window" style="display: none;">
        <div id="chat-header">
          <span>🐝 Deseret (IA)</span>
          <button id="chat-close-btn">✕</button>
        </div>
        <div id="chat-messages">
          <div class="msg bot">¡Hola! Soy Deseret. Puedes hablarme por micrófono o escribir tu consulta. ¿En qué te ayudo?</div>
          <div id="chat-suggestions-list">${chipsHTML}</div>
        </div>

        <div id="chat-input-area" style="display: flex; gap: 6px; padding: 8px; background: #fff;">
          <button id="chat-mic-btn" title="Hablar con Deseret" style="background: #f0f2f5; border: 1px solid #ccc; border-radius: 50%; width: 36px; height: 36px; cursor: pointer;">🎤</button>
          <input type="text" id="chat-input" placeholder="Escribe o agenda una reunión..." style="flex: 1; padding: 8px; border-radius: 20px; border: 1px solid #ccc;" />
          <button id="chat-send-btn" style="background: #0056b3; color: white; border: none; border-radius: 18px; padding: 0 14px; cursor: pointer;">Enviar</button>
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

  // --- RECONOCIMIENTO DE VOZ (STT) ---
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = 'es-ES';

    micBtn.addEventListener('click', () => {
      micBtn.style.background = '#ff4d4d';
      micBtn.textContent = '🎙️';
      recognition.start();
    });

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      inputEl.value = transcript;
      micBtn.style.background = '#f0f2f5';
      micBtn.textContent = '🎤';
      sendMessage(transcript);
    };

    recognition.onerror = () => {
      micBtn.style.background = '#f0f2f5';
      micBtn.textContent = '🎤';
    };
  } else {
    micBtn.style.display = 'none';
  }

  // --- ENVÍO DE MENSAJES Y ACCIONES ---
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

      document.getElementById(loadingId)?.remove();

      const respuestaTexto = data.respuesta || 'Sin respuesta.';
      const msgId = 'msg-' + Date.now();

      const respuestaFormatted = respuestaTexto
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/^\*\s(.*)/gm, '• $1')
        .replace(/\n/g, '<br>');

      // Incluye Botón de Copiar (Punto UX 2)
      messagesDiv.innerHTML += `
        <div class="msg bot" id="${msgId}">
          ${respuestaFormatted}
          <button onclick="navigator.clipboard.writeText(\`${respuestaTexto.replace(/`/g, '')}\`)" style="display:block; margin-top:5px; background:none; border:none; color:#0056b3; cursor:pointer; font-size:11px;">📋 Copiar respuesta</button>
        </div>
      `;
    } catch (error) {
      document.getElementById(loadingId)?.remove();
      messagesDiv.innerHTML += `<div class="msg bot error">⚠️ Error de conexión. <button onclick="location.reload()">Reintentar 🔄</button></div>`;
    }
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  };

  document.addEventListener('click', (e) => {
    if (e.target?.classList.contains('chat-chip-btn')) {
      sendMessage(e.target.getAttribute('data-query'));
    }
  });

  document.getElementById('chat-send-btn').addEventListener('click', () => sendMessage());
  inputEl.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });

  // Vínculo con el Header
  const asociarBotonHeader = () => {
    const logoOriginal = document.querySelector('header img') || document.querySelector('.logo img') || document.querySelector('img[src*="logo"]');
    if (logoOriginal && !document.getElementById('deseret-header-btn')) {
      const btn = document.createElement('button');
      btn.id = 'deseret-header-btn';
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
