export function initChatWidget() {
  if (!document.getElementById('organiza-chat-widget')) {

    // 1. Detectar rol del usuario desde localStorage o JWT
    const obtenerRolUsuario = () => {
      try {
        const userJson = localStorage.getItem('user');
        if (userJson) {
          const user = JSON.parse(userJson);
          return (user.role || user.cargo || '').toLowerCase();
        }
        // Si el rol viene codificado dentro del token JWT
        const token = localStorage.getItem('token');
        if (token) {
          const payload = JSON.parse(atob(token.split('.')[1]));
          return (payload.role || payload.cargo || '').toLowerCase();
        }
      } catch (e) {
        console.warn('No se pudo leer el rol del usuario:', e);
      }
      return '';
    };

    const rol = obtenerRolUsuario();

    // Verificamos si el rol incluye permisos para ver recomendaciones
    const esAutorizadoRecomendaciones = 
      rol.includes('obispo') || 
      rol.includes('obispado') || 
      rol.includes('presidente_cuorum') || 
      rol.includes('presidente cuorum') || 
      rol.includes('quorum') || 
      rol.includes('presidenta_soc_soc') || 
      rol.includes('sociedad de socorro') ||
      rol.includes('soc_soc') ||
      rol.includes('admin');

    // 2. Construir la lista de sugerencias dinámicamente
    let chipsHTML = `
      <button class="chat-chip-btn" data-query="¿Qué actividades hay esta semana?" style="text-align: left; background: #f0f7ff; border: 1px solid #0056b3; color: #0056b3; border-radius: 8px; padding: 8px 12px; font-size: 12px; cursor: pointer; font-weight: 500; transition: background 0.2s;">📅 ¿Qué actividades hay esta semana?</button>
      <button class="chat-chip-btn" data-query="¿A quién le toca el turno de aseo de la capilla?" style="text-align: left; background: #f0f7ff; border: 1px solid #0056b3; color: #0056b3; border-radius: 8px; padding: 8px 12px; font-size: 12px; cursor: pointer; font-weight: 500; transition: background 0.2s;">🧹 ¿A quién le toca el turno de aseo?</button>
    `;

    // SOLO agregamos la sugerencia de recomendaciones si el usuario tiene el rol permitido
    if (esAutorizadoRecomendaciones) {
      chipsHTML += `
        <button class="chat-chip-btn" data-query="¿Quiénes tienen recomendación del templo vigente?" style="text-align: left; background: #f0f7ff; border: 1px solid #0056b3; color: #0056b3; border-radius: 8px; padding: 8px 12px; font-size: 12px; cursor: pointer; font-weight: 500; transition: background 0.2s;">🏛️ ¿Quiénes tienen recomendación vigente?</button>
      `;
    }

    const chatHTML = `
      <div id="organiza-chat-widget">
        <div id="chat-window" style="display: none;">
          <div id="chat-header">
            <span>🐝 Deseret (IA)</span>
            <button id="chat-close-btn">✕</button>
          </div>
          <div id="chat-messages">
            <div class="msg bot">¡Hola! Soy Deseret, la abeja asistente de OrganizaSion. ¿En qué te puedo ayudar hoy?</div>
            
            <!-- Listado dinámico de sugerencias -->
            <div id="chat-suggestions-list" style="display: flex; flex-direction: column; gap: 6px; margin: 8px 0; padding-left: 4px;">
              ${chipsHTML}
            </div>
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

    const sendMessage = async (textoPersonalizado = null) => {
      const input = document.getElementById('chat-input');
      const text = textoPersonalizado || input.value.trim();
      if (!text) return;

      const messagesDiv = document.getElementById('chat-messages');
      messagesDiv.innerHTML += `<div class="msg user">${text}</div>`;
      if (!textoPersonalizado) input.value = '';

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

        const respuestaTexto = data.respuesta || data.error || 'No pude procesar la respuesta.';

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

    document.addEventListener('click', (e) => {
      if (e.target && e.target.classList.contains('chat-chip-btn')) {
        const query = e.target.getAttribute('data-query');
        sendMessage(query);
      }
    });

    document.getElementById('chat-send-btn').addEventListener('click', () => sendMessage());
    document.getElementById('chat-input').addEventListener('keypress', (e) => { 
      if (e.key === 'Enter') sendMessage(); 
    });
  }

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
