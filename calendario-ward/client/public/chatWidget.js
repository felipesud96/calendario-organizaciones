export function initChatWidget() {
  const chatHTML = `
    <div id="organiza-chat-widget">
      <button id="chat-toggle-btn">💬 Asistente IA</button>
      <div id="chat-window" style="display: none;">
        <div id="chat-header">
          <span>IA OrganizaSion</span>
          <button id="chat-close-btn">✕</button>
        </div>
        <div id="chat-messages">
          <div class="msg bot">¡Hola! Soy el asistente de OrganizaSion. ¿Qué deseas saber sobre el calendario?</div>
        </div>
        <div id="chat-input-area">
          <input type="text" id="chat-input" placeholder="Escribe tu pregunta..." />
          <button id="chat-send-btn">Enviar</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', chatHTML);

  const toggleBtn = document.getElementById('chat-toggle-btn');
  const chatWindow = document.getElementById('chat-window');
  
  const toggleChat = () => {
    chatWindow.style.display = chatWindow.style.display === 'none' ? 'flex' : 'none';
    toggleBtn.style.display = chatWindow.style.display === 'none' ? 'block' : 'none';
  };

  toggleBtn.addEventListener('click', toggleChat);
  document.getElementById('chat-close-btn').addEventListener('click', toggleChat);

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
      // Llamamos a tu servidor que acabas de desplegar
      const response = await fetch('/api/chat', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mensaje: text })
      });
      const data = await response.json();
      
      document.getElementById(loadingId).remove();
      messagesDiv.innerHTML += `<div class="msg bot">${data.respuesta}</div>`;
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
