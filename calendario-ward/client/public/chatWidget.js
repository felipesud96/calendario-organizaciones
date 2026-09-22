export function initChatWidget() {
  // 1. Inyectamos la ventana desplegable del chat (inicialmente oculta)
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

  // 2. Reemplazamos el logo original del header por nuestro botón circular interactivo
  const reemplazarLogoPorBoton = () => {
    const logoOriginal = document.querySelector('header img') || 
                         document.querySelector('.logo img') || 
                         document.querySelector('img[src*="logo"]');

    if (logoOriginal && !document.getElementById('deseret-header-btn')) {
      // Creamos el botón circular
      const btnDeseret = document.createElement('button');
      btnDeseret.id = 'deseret-header-btn';
      btnDeseret.title = 'Hablar con Deseret (IA)';
      btnDeseret.innerHTML = `<img src="./logo-bee.png" alt="Deseret IA" />`;
      btnDeseret.addEventListener('click', toggleChat);

      // Reemplazamos la imagen vieja por el nuevo botón en el mismo lugar
      logoOriginal.parentNode.replaceChild(btnDeseret, logoOriginal);
    }
  };

  // Intentamos reemplazarlo inmediatamente y también tras medio segundo por si la app tarda en cargar
  reemplazarLogoPorBoton();
  setTimeout(reemplazarLogoPorBoton, 600);

  // 3. Lógica para responder mensajes
  const sendMessage = async () => {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    const messagesDiv = document.getElementById('chat-messages');
    messagesDiv.innerHTML += `<div class="msg user">${text}</div>`;
    input.value = '';
    
    const loadingId = 'loading-' + Date.now();
    messagesDiv.innerHTML += `<div id="${loadingId}" class="msg bot">Pensando...</div>`;
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
      messagesDiv.innerHTML += `<div class="msg bot">${respuestaTexto}</div>`;
    } catch (error) {
      document.getElementById(loadingId).remove();
      messagesDiv.innerHTML += `<div class="msg bot error">Error de conexión.</div>`;
    }
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  };

  document.getElementById('chat-send-btn').addEventListener('click', sendMessage);
  document.getElementById('chat-input').addEventListener('keypress', (e) => { 
    if (e.key === 'Enter') sendMessage(); 
  });
}
