const sendMessage = async () => {
    // 1. Detener el micrófono si seguía activo
    if (typeof stopListeningState === 'function') {
      stopListeningState();
    }

    const text = chatInput.value.trim();
    if (!text) return;

    // 2. Pintar mensaje en pantalla
    messagesDiv.innerHTML += `<div class="msg user">${text}</div>`;
    
    // 3. LIMPIEZA INMEDIATA: Vaciar la casilla para que no quede el audio escrito
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
