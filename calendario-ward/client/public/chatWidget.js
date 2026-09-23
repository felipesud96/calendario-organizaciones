// Deseret 🐝 — widget del asistente de IA de OrganizaSion.
//
// Se abre tocando el logo de la abeja de la barra superior. Habla con
// POST /api/chat, que responde { respuesta, opciones?, tarjeta?, items? }:
//   - opciones: botones de respuesta rápida (se mandan como si se hubieran escrito)
//   - tarjeta:  resumen de lo que se va a agendar, para confirmar antes de guardar
//   - items:    actividades / entrevistas / turnos, mostrados como tarjetas
//
// Todo lo que viene del servidor (texto de la IA, títulos de actividades,
// nombres) se ESCAPA antes de insertarlo — sin esto, un título de actividad
// "<img src=x onerror=alert(1)>" se ejecutaría para cualquiera que lo viera.

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

// Negrita (**x**), cursiva (_x_) y saltos de línea, aplicados DESPUÉS de escapar.
function formatear(texto) {
  return escapeHtml(texto)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<em>$2</em>')
    .replace(/\n/g, '<br>');
}

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function fechaCorta(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return iso || '';
  const f = new Date(y, m - 1, d, 12);
  return `${DIAS[f.getDay()]} ${d} ${MESES[m - 1]}`;
}

// Color seguro para usar en style="" (solo #rgb / #rrggbb).
function colorSeguro(c) {
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(c || '')) ? c : 'var(--celeste, #0ea5e9)';
}

// Almacenamiento con try/catch: en modo incógnito o con el sitio bloqueado
// puede fallar, y el chat tiene que seguir funcionando igual.
const store = {
  get(area, key) { try { return JSON.parse(window[area].getItem(key)); } catch { return null; } },
  set(area, key, val) { try { window[area].setItem(key, JSON.stringify(val)); } catch { /* sin almacenamiento */ } },
  del(area, key) { try { window[area].removeItem(key); } catch { /* sin almacenamiento */ } },
};
const CLAVE_CHAT = 'deseret_chat_v2';   // sessionStorage: conversación de esta pestaña
const CLAVE_VOZ = 'deseret_voz';        // localStorage: ¿leer respuestas en voz alta?

const ESTILOS = `
  #organiza-chat-widget button, .chat-btn { outline: none; -webkit-tap-highlight-color: transparent; }

  /* Logo de la barra superior = botón de Deseret */
  .topbar-logo.deseret-trigger { cursor: pointer; border-radius: 50%; transition: transform .15s ease; }
  .topbar-logo.deseret-trigger:hover { transform: scale(1.08); }
  .topbar-logo.deseret-trigger:active { transform: scale(.95); }
  .deseret-logo-wrap { position: relative; display: inline-flex; }
  .deseret-logo-wrap::after {
    content: 'IA'; position: absolute; right: -6px; bottom: -4px;
    background: var(--celeste, #0ea5e9); color: #fff;
    font-size: 9px; font-weight: 700; line-height: 1;
    padding: 2px 4px; border-radius: 6px; pointer-events: none;
  }

  /* Ventana */
  #chat-window {
    position: fixed; right: 16px; bottom: 16px; z-index: 1000;
    width: 380px; max-width: calc(100vw - 32px);
    height: 560px; max-height: calc(100vh - 32px);
    flex-direction: column;
    background: var(--white, #fff); color: var(--ink, #0f172a);
    border: 1px solid var(--border, #dbeafe); border-radius: var(--radius, 12px);
    box-shadow: var(--shadow-lg, 0 10px 30px rgba(3,105,161,.18));
    overflow: hidden;
  }
  #chat-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px; font-weight: 700;
    background: var(--celeste, #0ea5e9); color: #fff;
  }
  #chat-header button { background: transparent; border: 0; color: #fff; font-size: 16px; cursor: pointer; padding: 4px 6px; border-radius: 6px; }
  #chat-header button:hover { background: rgba(255,255,255,.18); }
  #chat-header button[aria-pressed="false"] { opacity: .6; }
  #chat-messages {
    flex: 1; overflow-y: auto; padding: 12px;
    display: flex; flex-direction: column; gap: 8px;
    background: var(--celeste-lighter, #f0f9ff);
  }
  #chat-messages .msg { max-width: 88%; padding: 8px 11px; border-radius: 12px; font-size: 14px; line-height: 1.45; word-wrap: break-word; }
  #chat-messages .msg.bot { align-self: flex-start; background: var(--white, #fff); border: 1px solid var(--border, #dbeafe); }
  #chat-messages .msg.user { align-self: flex-end; background: var(--celeste, #0ea5e9); color: #fff; }
  #chat-messages .msg.error { border-color: var(--danger, #ef4444); color: var(--danger, #ef4444); }

  /* Punto 14: indicador de "escribiendo" */
  .deseret-typing { display: inline-flex; gap: 4px; align-items: center; padding: 4px 2px; }
  .deseret-typing span { width: 7px; height: 7px; border-radius: 50%; background: var(--celeste, #0ea5e9); animation: deseret-bounce 1.2s infinite ease-in-out; }
  .deseret-typing span:nth-child(2) { animation-delay: .15s; }
  .deseret-typing span:nth-child(3) { animation-delay: .3s; }
  @keyframes deseret-bounce { 0%, 80%, 100% { transform: translateY(0); opacity: .4; } 40% { transform: translateY(-5px); opacity: 1; } }

  /* Punto 7: botones de respuesta rápida */
  .deseret-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .deseret-chip {
    border: 1px solid var(--celeste, #0ea5e9); background: var(--white, #fff); color: var(--celeste-dark, #0369a1);
    border-radius: 999px; padding: 5px 11px; font-size: 13px; cursor: pointer; text-align: left;
  }
  .deseret-chip:hover { background: var(--celeste-light, #e0f2fe); }
  .deseret-chip.primario { background: var(--celeste, #0ea5e9); color: #fff; font-weight: 600; }

  /* Punto 6: tarjeta de confirmación */
  .deseret-confirm { margin-top: 8px; border: 1px solid var(--border, #dbeafe); border-left: 4px solid var(--c); border-radius: 10px; padding: 8px 10px; background: var(--celeste-lighter, #f0f9ff); }
  .deseret-confirm .t { font-weight: 700; margin-bottom: 4px; }
  .deseret-confirm .f { display: flex; gap: 8px; font-size: 13px; padding: 1px 0; }

  /* Punto 16: tarjetas de actividades / entrevistas */
  .deseret-items { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  .deseret-item { display: flex; gap: 10px; align-items: stretch; border: 1px solid var(--border, #dbeafe); border-radius: 10px; background: var(--white, #fff); overflow: hidden; }
  .deseret-item .barra { width: 5px; background: var(--c); flex: none; }
  .deseret-item .cuando { flex: none; width: 62px; padding: 6px 0; text-align: center; font-size: 11px; color: var(--ink-soft, #475569); line-height: 1.3; }
  .deseret-item .cuando b { display: block; font-size: 13px; color: var(--ink, #0f172a); }
  .deseret-item .que { padding: 6px 8px 6px 0; min-width: 0; }
  .deseret-item .que .titulo { font-weight: 600; font-size: 13px; }
  .deseret-item .que .org { font-size: 11px; color: var(--c); font-weight: 600; }

  .msg-actions { display: flex; gap: 8px; margin-top: 6px; font-size: 11px; }
  .btn-action { background: var(--celeste-lighter, #eef2f5); border: 1px solid var(--border, #cbd5e1); border-radius: 4px; padding: 3px 8px; cursor: pointer; color: var(--ink-soft, #334155); }

  #chat-input-area { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--border, #dbeafe); background: var(--white, #fff); }
  #chat-input {
    flex: 1; min-width: 0; padding: 8px 10px; font-size: 16px;
    border: 1px solid var(--border, #dbeafe); border-radius: 8px;
    background: var(--white, #fff); color: var(--ink, #0f172a);
  }
  #chat-send-btn, #chat-mic-btn { border: 1px solid var(--border, #dbeafe); border-radius: 8px; padding: 0 10px; cursor: pointer; background: var(--celeste-lighter, #f0f9ff); color: var(--ink, #0f172a); }
  #chat-send-btn { background: var(--celeste, #0ea5e9); color: #fff; border-color: var(--celeste, #0ea5e9); font-weight: 600; }
  #chat-send-btn:disabled { opacity: .6; cursor: default; }
  @keyframes pulse-wave {
    0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(220, 53, 69, 0.7); }
    50% { transform: scale(1.1); box-shadow: 0 0 0 10px rgba(220, 53, 69, 0); }
    100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(220, 53, 69, 0); }
  }
  .mic-listening { background-color: #dc3545 !important; color: white !important; border-color: #dc3545 !important; animation: pulse-wave 1s infinite ease-in-out; }

  /* Punto 13: en el celular, pantalla completa */
  @media (max-width: 600px) {
    #chat-window { right: 0; bottom: 0; width: 100vw; max-width: 100vw; height: 100dvh; max-height: 100dvh; border-radius: 0; border: 0; }
  }
`;

const SALUDO = '¡Hola! Soy Deseret, la abeja asistente de OrganizaSion. ¿En qué te puedo ayudar hoy?';

export function initChatWidget() {
  if (!document.getElementById('deseret-styles')) {
    const style = document.createElement('style');
    style.id = 'deseret-styles';
    style.textContent = ESTILOS;
    document.head.appendChild(style);
  }

  if (!document.getElementById('organiza-chat-widget')) {
    document.body.insertAdjacentHTML('beforeend', `
      <div id="organiza-chat-widget">
        <div id="chat-window" style="display: none;" role="dialog" aria-label="Deseret, asistente de IA">
          <div id="chat-header">
            <span>🐝 Deseret (IA)</span>
            <div>
              <button id="chat-voice-btn" title="Leer respuestas en voz alta" aria-pressed="false">🔈</button>
              <button id="chat-reset-btn" title="Reiniciar conversación">🔄</button>
              <button id="chat-close-btn" title="Cerrar">✕</button>
            </div>
          </div>
          <div id="chat-messages" aria-live="polite"></div>
          <div id="chat-input-area">
            <button id="chat-mic-btn" title="Dictar por voz">🎙️</button>
            <input type="text" id="chat-input" placeholder="Pregunta o pide agendar algo..." enterkeyhint="send" />
            <button id="chat-send-btn">Enviar</button>
          </div>
        </div>
      </div>`);
  }

  const chatWindow = document.getElementById('chat-window');
  const micBtn = document.getElementById('chat-mic-btn');
  const voiceBtn = document.getElementById('chat-voice-btn');
  const sendBtn = document.getElementById('chat-send-btn');
  const chatInput = document.getElementById('chat-input');
  const messagesDiv = document.getElementById('chat-messages');

  // ---------------- Punto 11: la conversación sobrevive a una recarga ----------------
  // Se guarda en sessionStorage (solo esta pestaña; se borra al cerrar sesión).
  let estado = store.get('sessionStorage', CLAVE_CHAT) || { msgs: [], historial: [] };
  const guardar = () => {
    estado.msgs = estado.msgs.slice(-40);
    estado.historial = estado.historial.slice(-3);
    store.set('sessionStorage', CLAVE_CHAT, estado);
  };

  const scrollAbajo = () => { messagesDiv.scrollTop = messagesDiv.scrollHeight; };

  // Los botones de respuesta rápida solo sirven en el ÚLTIMO mensaje.
  const quitarChipsViejos = () => {
    messagesDiv.querySelectorAll('.deseret-chips').forEach((el) => el.remove());
    estado.msgs.forEach((m) => { if (m.extra) delete m.extra.opciones; });
  };

  function htmlTarjeta(t) {
    const filas = (t.filas || []).filter((f) => f[1])
      .map(([ico, val]) => `<div class="f"><span>${escapeHtml(ico)}</span><span>${escapeHtml(val)}</span></div>`).join('');
    return `<div class="deseret-confirm" style="--c:${colorSeguro(t.color)}"><div class="t">${escapeHtml(t.titulo || '')}</div>${filas}</div>`;
  }

  function htmlItems(items) {
    return `<div class="deseret-items">${items.map((it) => {
      const icono = it.tipo === 'entrevista' ? '🙋 ' : it.tipo === 'aseo' ? '🧹 ' : '';
      return `<div class="deseret-item" style="--c:${colorSeguro(it.color)}">
        <div class="barra"></div>
        <div class="cuando"><b>${escapeHtml(fechaCorta(it.fecha))}</b>${escapeHtml(it.hora || '')}</div>
        <div class="que"><div class="titulo">${icono}${escapeHtml(it.titulo)}</div><div class="org">${escapeHtml(it.org || '')}</div></div>
      </div>`;
    }).join('')}</div>`;
  }

  function pintarMensaje(m) {
    const div = document.createElement('div');
    div.className = `msg ${m.role}${m.error ? ' error' : ''}`;
    if (m.role === 'user') {
      div.textContent = m.texto;
    } else {
      const extra = m.extra || {};
      div.innerHTML = `<div class="cuerpo">${formatear(m.texto)}</div>`
        + (extra.tarjeta ? htmlTarjeta(extra.tarjeta) : '')
        + (Array.isArray(extra.items) && extra.items.length ? htmlItems(extra.items) : '');
      if (Array.isArray(extra.opciones) && extra.opciones.length) {
        const chips = document.createElement('div');
        chips.className = 'deseret-chips';
        extra.opciones.forEach((o) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = `deseret-chip${/confirmar/i.test(o.value) ? ' primario' : ''}`;
          b.textContent = o.label;
          b.addEventListener('click', () => enviar(o.value, o.label));
          chips.appendChild(b);
        });
        div.appendChild(chips);
      }
      if (!m.error && m.texto) {
        const acciones = document.createElement('div');
        acciones.className = 'msg-actions';
        const copiar = document.createElement('button');
        copiar.type = 'button';
        copiar.className = 'btn-action';
        copiar.textContent = '📋 Copiar';
        copiar.addEventListener('click', () => {
          const texto = div.querySelector('.cuerpo')?.innerText || '';
          navigator.clipboard?.writeText(texto).then(() => {
            copiar.textContent = '✅ Copiado';
            setTimeout(() => { copiar.textContent = '📋 Copiar'; }, 1500);
          });
        });
        acciones.appendChild(copiar);
        div.appendChild(acciones);
      }
    }
    messagesDiv.appendChild(div);
    scrollAbajo();
  }

  function repintarTodo() {
    messagesDiv.innerHTML = '';
    if (!estado.msgs.length) estado.msgs.push({ role: 'bot', texto: SALUDO });
    estado.msgs.forEach(pintarMensaje);
  }
  repintarTodo();

  // ---------------- Punto 15: leer respuestas en voz alta ----------------
  let vozActiva = store.get('localStorage', CLAVE_VOZ) === true;
  let ultimaFueDictada = false;
  const puedeHablar = 'speechSynthesis' in window;
  const pintarBotonVoz = () => {
    voiceBtn.textContent = vozActiva ? '🔊' : '🔈';
    voiceBtn.setAttribute('aria-pressed', String(vozActiva));
    voiceBtn.title = vozActiva ? 'Leer respuestas en voz alta: activado' : 'Leer respuestas en voz alta: desactivado';
  };
  if (!puedeHablar) voiceBtn.style.display = 'none';
  pintarBotonVoz();
  voiceBtn.addEventListener('click', () => {
    vozActiva = !vozActiva;
    store.set('localStorage', CLAVE_VOZ, vozActiva);
    pintarBotonVoz();
    if (!vozActiva && puedeHablar) window.speechSynthesis.cancel();
  });

  function hablar(texto) {
    if (!puedeHablar || !texto) return;
    const limpio = String(texto)
      .replace(/[*_`#>]/g, '')
      .replace(/\p{Extended_Pictographic}/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!limpio) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(limpio);
    const voces = window.speechSynthesis.getVoices();
    u.voice = voces.find((v) => v.lang === 'es-CL') || voces.find((v) => /^es[-_]/i.test(v.lang)) || null;
    u.lang = u.voice?.lang || 'es-CL';
    window.speechSynthesis.speak(u);
  }

  // ---------------- Dictado por voz (es-CL) con auto-envío ----------------
  let autoSendTimer = null;
  let stopListeningState = () => {};

  // ---------------- Envío ----------------
  let enviando = false;
  async function enviar(textoAEnviar, textoVisible) {
    const text = String(textoAEnviar ?? chatInput.value).trim();
    if (!text || enviando) return;
    clearTimeout(autoSendTimer);
    stopListeningState();
    enviando = true;
    sendBtn.disabled = true;

    const dictada = ultimaFueDictada;
    ultimaFueDictada = false;
    quitarChipsViejos();
    const msgUser = { role: 'user', texto: textoVisible || text };
    estado.msgs.push(msgUser);
    pintarMensaje(msgUser);
    chatInput.value = '';

    const typing = document.createElement('div');
    typing.className = 'msg bot';
    typing.innerHTML = '<span class="deseret-typing" aria-label="Deseret está escribiendo"><span></span><span></span><span></span></span>';
    messagesDiv.appendChild(typing);
    scrollAbajo();

    let msgBot;
    try {
      // Misma clave de sesión que usa app.js ('cow_token').
      let token = null;
      try { token = localStorage.getItem('cow_token'); } catch { token = null; }
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ mensaje: text, historial: estado.historial }),
      });
      const data = await response.json();
      const { respuesta, error, ...extra } = data || {};
      const texto = respuesta || error || 'No pude procesar la respuesta.';
      msgBot = { role: 'bot', texto, extra, error: !respuesta };
      estado.historial.push({ user: text, bot: texto });
    } catch (e) {
      msgBot = { role: 'bot', texto: 'Error de conexión. Revisa tu internet e intenta de nuevo.', error: true };
    }
    typing.remove();
    estado.msgs.push(msgBot);
    pintarMensaje(msgBot);
    guardar();
    if (vozActiva || dictada) hablar(msgBot.texto);
    enviando = false;
    sendBtn.disabled = false;
    chatInput.focus();
  }

  sendBtn.addEventListener('click', () => enviar());
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); enviar(); }
  });

  // ---------------- Abrir / cerrar / reiniciar ----------------
  const toggleChat = () => {
    const abrir = chatWindow.style.display === 'none';
    chatWindow.style.display = abrir ? 'flex' : 'none';
    if (abrir) { scrollAbajo(); chatInput.focus(); } else if (puedeHablar) window.speechSynthesis.cancel();
  };
  document.getElementById('chat-close-btn').addEventListener('click', toggleChat);
  document.getElementById('chat-reset-btn').addEventListener('click', () => {
    estado = { msgs: [{ role: 'bot', texto: '¡Hola! Conversación reiniciada. ¿Qué necesitas?' }], historial: [] };
    guardar();
    repintarTodo();
    chatInput.value = '';
  });

  // El logo de la abeja de la barra superior abre a Deseret. app.js vuelve a
  // dibujar la barra en cada cambio de vista, así que: 1) el clic se escucha
  // en el documento (delegación) y 2) un MutationObserver marca el logo
  // cada vez que la barra se redibuja.
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.topbar-logo, #deseret-header-btn')) {
      e.preventDefault();
      toggleChat();
    }
  });

  const marcarLogo = () => {
    const logo = document.querySelector('.topbar-logo');
    if (!logo) {
      // Sin barra superior = pantalla de login (o se cerró sesión): se cierra
      // el chat y se borra la conversación, para que la próxima persona que
      // use este mismo navegador no la vea.
      // (Mientras la app todavía está cargando tampoco hay barra, pero ahí
      // NO se borra nada: solo en la pantalla de login, que tiene .login-logo.)
      if (chatWindow.style.display !== 'none') chatWindow.style.display = 'none';
      if (document.querySelector('.login-logo') && estado.msgs.length > 1) {
        store.del('sessionStorage', CLAVE_CHAT);
        estado = { msgs: [], historial: [] };
        repintarTodo();
      }
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

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = 'es-CL';
    recognition.continuous = false;
    recognition.interimResults = false;
    let isListening = false;

    stopListeningState = () => {
      isListening = false;
      micBtn.classList.remove('mic-listening');
      micBtn.title = 'Dictar por voz';
      chatInput.placeholder = 'Pregunta o pide agendar algo...';
      try { recognition.stop(); } catch { /* ya estaba detenido */ }
    };

    micBtn.addEventListener('click', () => {
      if (!isListening) {
        if (puedeHablar) window.speechSynthesis.cancel();
        try { recognition.start(); } catch { /* ya estaba activo */ }
      } else {
        stopListeningState();
      }
    });

    recognition.onstart = () => {
      isListening = true;
      micBtn.classList.add('mic-listening');
      micBtn.title = 'Escuchando tu voz...';
      chatInput.placeholder = 'Escuchando tu voz... 🎙️';
    };
    recognition.onresult = (event) => {
      chatInput.value = event.results[0][0].transcript;
      ultimaFueDictada = true; // si se dictó, la respuesta se lee en voz alta
      clearTimeout(autoSendTimer);
      autoSendTimer = setTimeout(() => enviar(), 1500);
    };
    recognition.onerror = () => stopListeningState();
    recognition.onend = () => stopListeningState();
  } else {
    micBtn.style.display = 'none';
  }
}
