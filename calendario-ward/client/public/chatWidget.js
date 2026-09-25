// Deseret — widget del asistente de IA de OrganizaSion.
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
const CLAVE_VOZ_TIPO = 'deseret_voz_tipo'; // localStorage: 'femenina' (por defecto) | 'masculina'
const CLAVE_HEY = 'deseret_hey';        // localStorage: ¿escuchar "Hey Deseret"?
const CLAVE_INTRO = 'deseret_intro_v1'; // localStorage: ¿ya se mostró la presentación?
const CLAVE_AUTO = 'deseret_conduccion'; // localStorage: ¿modo conducción?
const CLAVE_AVISOS = 'deseret_avisos_dia'; // localStorage: día en que ya se mostraron los avisos

// Imagen de Deseret (abeja en un panal) y los íconos de línea de la ventana.
const AVATAR = '/deseret.svg';
const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
const ICONOS = {
  vozOn: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>'),
  vozOff: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>'),
  reiniciar: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  cerrar: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  mic: svg('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><path d="M12 18v4"/>'),
  enviar: svg('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>'),
  copiar: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', ' width="14" height="14"'),
  ok: svg('<path d="M20 6 9 17l-5-5"/>', ' width="14" height="14"'),
  arriba: svg('<path d="M7 10v12"/><path d="M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.4 22H7V10l4.3-8a3 3 0 0 1 3.7 3.9z"/>', ' width="14" height="14"'),
  oido: svg('<path d="M6 8.5a6 6 0 0 1 12 0c0 3.5-3 4.5-3.5 7a3.5 3.5 0 0 1-6.5 1"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-1.5 2-1.5 3"/>'),
  auto: svg('<path d="M5 17h14v-5l-2-5H7l-2 5z"/><circle cx="8" cy="17" r="2"/><circle cx="16" cy="17" r="2"/><path d="M5 12h14"/>'),
  abajo: svg('<path d="M17 14V2"/><path d="M9 18.1 10 14H4.2a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 5.6 2H17v12l-4.3 8a3 3 0 0 1-3.7-3.9z"/>', ' width="14" height="14"'),
};
// Sugerencias de la pantalla de bienvenida.
const SUGERENCIAS = ['¿Qué tengo esta semana?', 'Agendar una entrevista', '¿Cómo vamos en ministración?'];

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

  /* Botón flotante de Deseret (para que se note que hay un asistente) */
  #deseret-fab {
    position: fixed; right: 24px; bottom: 24px; z-index: 95;
    display: flex; align-items: center; gap: 8px; height: 52px; padding: 0 18px 0 7px;
    border: 0; border-radius: 999px; cursor: pointer; font: inherit; font-weight: 700; font-size: 14px;
    background: linear-gradient(135deg, #075985, #0284c7); color: #fff;
    box-shadow: 0 6px 18px rgba(3,105,161,.35); transition: transform .15s ease, box-shadow .15s ease;
  }
  #deseret-fab:hover { transform: translateY(-2px); box-shadow: 0 10px 24px rgba(3,105,161,.4); }
  #deseret-fab img { width: 40px; height: 40px; flex: none; }
  #deseret-fab .escuchando { position: absolute; left: 36px; top: 6px; width: 11px; height: 11px; border-radius: 50%; background: #4ade80; border: 2px solid #fff; display: none; animation: deseret-latido 1.6s infinite; }
  #deseret-fab.hey .escuchando { display: block; background: #94a3b8; animation: none; }
  #deseret-fab.hey.vigilando .escuchando { background: #4ade80; animation: none; }
  #deseret-fab.hey.escuchando-ahora .escuchando { background: #4ade80; animation: deseret-latido 1.6s infinite; }
  @keyframes deseret-latido { 0%,100% { box-shadow: 0 0 0 0 rgba(74,222,128,.7); } 50% { box-shadow: 0 0 0 6px rgba(74,222,128,0); } }
  body:has(.add-event-fab) #deseret-fab { bottom: 90px; }
  body:has(.modal-backdrop) #deseret-fab, body:has(.modal-backdrop) #deseret-intro { display: none !important; }
  #deseret-intro {
    position: fixed; right: 24px; bottom: 88px; z-index: 96; max-width: 280px;
    background: var(--white, #fff); color: var(--ink, #0f172a); border: 1px solid var(--border, #dbeafe);
    border-radius: 14px; padding: 12px 14px; font-size: 13.5px; line-height: 1.45; box-shadow: 0 10px 30px rgba(3,105,161,.22);
  }
  #deseret-intro::after { content: ''; position: absolute; right: 34px; bottom: -7px; width: 12px; height: 12px; background: inherit; border-right: 1px solid var(--border, #dbeafe); border-bottom: 1px solid var(--border, #dbeafe); transform: rotate(45deg); }
  #deseret-intro b { display: block; margin-bottom: 2px; }
  #deseret-intro .x { position: absolute; top: 4px; right: 8px; border: 0; background: none; font-size: 16px; color: var(--ink-soft, #64748b); cursor: pointer; }
  body:has(.add-event-fab) #deseret-intro { bottom: 154px; }
  @media (max-width: 640px) {
    #deseret-fab { right: 16px; width: 52px; padding: 0; justify-content: center; bottom: calc(80px + env(safe-area-inset-bottom)); }
    #deseret-fab .txt { display: none; }
    #deseret-fab .escuchando { left: 34px; top: 4px; }
    body:has(.mobile-fab) #deseret-fab { bottom: calc(80px + 56px + 12px + env(safe-area-inset-bottom)); }
    #deseret-intro { right: 16px; left: 16px; max-width: none; bottom: calc(144px + env(safe-area-inset-bottom)); }
    body:has(.mobile-fab) #deseret-intro { bottom: calc(212px + env(safe-area-inset-bottom)); }
    #deseret-intro::after { right: 36px; }
  }
  .deseret-hey-aviso { font-size: 12px; background: #ecfdf5; color: #065f46; border-bottom: 1px solid #a7f3d0; padding: 6px 12px; display: none; }
  #chat-header button.hey-on { background: rgba(74,222,128,.3); opacity: 1; }
  #chat-header button.auto-on { background: rgba(250,204,21,.35); opacity: 1; }
  /* Modo conducción: letra grande, sin botones secundarios, micrófono enorme */
  #chat-window.conduccion #chat-messages .msg { font-size: 18px; line-height: 1.5; }
  #chat-window.conduccion .msg-actions, #chat-window.conduccion .deseret-items { display: none; }
  #chat-window.conduccion .deseret-chip { font-size: 16px; padding: 9px 14px; }
  #chat-window.conduccion #chat-mic-btn { width: 64px; height: 64px; }
  #chat-window.conduccion #chat-mic-btn svg { width: 30px; height: 30px; }
  .deseret-auto-aviso { display: none; font-size: 13px; background: #fef9c3; color: #713f12; border-bottom: 1px solid #fde68a; padding: 6px 12px; }
  #chat-window.conduccion .deseret-auto-aviso { display: block; }
  /* Elegir voz femenina o masculina (visible cuando la voz está activada) */
  .deseret-voz-barra { display: none; align-items: center; gap: 8px; font-size: 13px; padding: 6px 12px; border-bottom: 1px solid var(--border, #e2e8f0); background: var(--bg-soft, #f8fafc); }
  #chat-window.voz-on .deseret-voz-barra, #chat-window.conduccion .deseret-voz-barra { display: flex; }
  .deseret-voz-barra .lbl { color: var(--ink-soft, #64748b); }
  .deseret-voz-op { display: inline-flex; border: 1px solid var(--celeste, #0ea5e9); border-radius: 999px; overflow: hidden; }
  .deseret-voz-op button { border: 0; background: transparent; color: var(--celeste-dark, #0369a1); font-size: 13px; padding: 4px 12px; cursor: pointer; }
  .deseret-voz-op button.activa { background: #0284c7; color: #fff; }

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
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 10px 10px 10px 14px;
    background: linear-gradient(135deg, #075985, #0284c7); color: #fff;
  }
  .deseret-id { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .deseret-id img { width: 38px; height: 38px; flex: none; filter: drop-shadow(0 1px 2px rgba(0,0,0,.25)); }
  .deseret-id .nombre { font-weight: 700; font-size: 15px; line-height: 1.2; }
  .deseret-id .estado { font-size: 12px; opacity: .9; display: flex; align-items: center; gap: 5px; }
  .deseret-id .estado::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 0 2px rgba(255,255,255,.35); }
  .deseret-botones { display: flex; gap: 2px; flex: none; }
  #chat-header button { background: transparent; border: 0; color: #fff; cursor: pointer; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; }
  #chat-header button:hover { background: rgba(255,255,255,.18); }
  #chat-header button[aria-pressed="false"] { opacity: .7; }
  #chat-messages {
    flex: 1; overflow-y: auto; padding: 12px;
    display: flex; flex-direction: column; gap: 8px;
    background: var(--celeste-lighter, #f0f9ff);
  }
  #chat-messages .msg { max-width: 88%; padding: 8px 11px; border-radius: 12px; font-size: 14px; line-height: 1.45; word-wrap: break-word; }
  #chat-messages .msg.bot {
    align-self: flex-start; position: relative; margin-left: 34px; max-width: calc(88% - 34px);
    background: var(--white, #fff); border: 1px solid var(--border, #dbeafe); border-top-left-radius: 4px;
    box-shadow: 0 1px 2px rgba(15,23,42,.05);
  }
  #chat-messages .msg.bot::before {
    content: ''; position: absolute; left: -34px; top: 0; width: 26px; height: 26px;
    background: url('/deseret.svg') center / contain no-repeat;
  }
  #chat-messages .msg.bot + .msg.bot::before { display: none; }
  #chat-messages .msg.user { border-top-right-radius: 4px; }

  /* Bienvenida */
  .deseret-bienvenida { text-align: center; padding: 14px 8px 4px; color: var(--ink-soft, #475569); }
  .deseret-bienvenida img { width: 72px; height: 72px; filter: drop-shadow(0 4px 10px rgba(240,165,0,.35)); }
  .deseret-bienvenida .t { font-weight: 700; font-size: 17px; color: var(--ink, #0f172a); margin-top: 6px; }
  .deseret-bienvenida .s { font-size: 13px; margin-top: 2px; }
  .deseret-bienvenida .deseret-chips { justify-content: center; margin-top: 12px; }
  #chat-messages .msg.user { align-self: flex-end; background: #0284c7; color: #fff; }
  #chat-messages .msg.error { border-color: var(--danger, #ef4444); color: var(--danger, #ef4444); }

  /* Punto 14: indicador de "escribiendo" */
  .deseret-typing { display: inline-flex; gap: 4px; align-items: center; padding: 4px 2px; }
  .deseret-typing span { width: 7px; height: 7px; border-radius: 50%; background: var(--celeste, #0ea5e9); animation: deseret-bounce 1.2s infinite ease-in-out; }
  .deseret-typing span:nth-child(2) { animation-delay: .15s; }
  .deseret-typing span:nth-child(3) { animation-delay: .3s; }
  @keyframes deseret-bounce { 0%, 80%, 100% { transform: translateY(0); opacity: .4; } 40% { transform: translateY(-5px); opacity: 1; } }

  /* Cuadros comparativos */
  #chat-messages .msg.con-tabla { max-width: 100%; width: 100%; box-sizing: border-box; }
  .deseret-tabla-wrap { overflow-x: auto; margin-top: 8px; border: 1px solid var(--border, #e2e8f0); border-radius: 10px; -webkit-overflow-scrolling: touch; }
  .deseret-tabla { border-collapse: collapse; font-size: 12.5px; min-width: 100%; }
  .deseret-tabla th, .deseret-tabla td { padding: 6px 8px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border, #e2e8f0); }
  .deseret-tabla thead th { background: #075985; color: #fff; font-weight: 600; white-space: nowrap; position: sticky; top: 0; }
  .deseret-tabla tbody tr:last-child td, .deseret-tabla tbody tr:last-child th { border-bottom: 0; }
  .deseret-tabla tbody th { font-weight: 600; min-width: 96px; color: var(--text-muted, #475569); }
  .deseret-tabla.lista td:first-child { min-width: 120px; font-weight: 600; }
  .deseret-tabla.lista td:last-child { min-width: 190px; }
  .deseret-tabla td.distinto { background: rgba(250, 204, 21, .18); }
  .deseret-tabla td { min-width: 90px; }

  /* Punto 7: botones de respuesta rápida */
  .deseret-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .deseret-chip {
    border: 1px solid var(--celeste, #0ea5e9); background: var(--white, #fff); color: var(--celeste-dark, #0369a1);
    border-radius: 999px; padding: 5px 11px; font-size: 13px; cursor: pointer; text-align: left;
  }
  .deseret-chip:hover { background: var(--celeste-light, #e0f2fe); }
  .deseret-chip.primario { background: #0284c7; border-color: #0284c7; color: #fff; font-weight: 600; }

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
  .btn-action { display: inline-flex; align-items: center; gap: 4px; background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 3px 6px; cursor: pointer; color: var(--ink-soft, #64748b); font-size: 11px; }
  .btn-action:hover:not(:disabled) { background: var(--celeste-lighter, #f0f9ff); border-color: var(--border, #dbeafe); color: var(--ink, #0f172a); }
  .btn-action.activo { color: var(--celeste-dark, #0369a1); background: var(--celeste-light, #e0f2fe); }
  .btn-action:disabled:not(.activo) { opacity: .45; cursor: default; }

  #chat-input-area { display: flex; gap: 6px; align-items: center; padding: 10px; border-top: 1px solid var(--border, #dbeafe); background: var(--white, #fff); }
  #chat-input {
    flex: 1; min-width: 0; height: 40px; padding: 0 14px; font-size: 16px;
    border: 1px solid var(--border, #dbeafe); border-radius: 999px;
    background: var(--celeste-lighter, #f8fafc); color: var(--ink, #0f172a);
  }
  #chat-input:focus { outline: none; border-color: var(--celeste, #0ea5e9); box-shadow: 0 0 0 3px rgba(14,165,233,.15); }
  #chat-send-btn, #chat-mic-btn { flex: none; width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--border, #dbeafe); border-radius: 50%; cursor: pointer; background: var(--white, #fff); color: var(--ink-soft, #475569); }
  #chat-mic-btn:hover { color: var(--ink, #0f172a); background: var(--celeste-lighter, #f0f9ff); }
  #chat-send-btn { background: #0284c7; color: #fff; border-color: #0284c7; }
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

const SALUDO = '¡Hola! Soy **Deseret**, la asistente de OrganizaSion. Puedo agendar, reprogramar, buscar a alguien o contarte cómo va el barrio. ¿En qué te ayudo?';

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
        <button id="deseret-fab" type="button" style="display:none" title="Pregúntale a Deseret (asistente IA)" aria-label="Abrir a Deseret, asistente IA">
          <img src="${AVATAR}" alt="" /><span class="escuchando"></span><span class="txt">Pregúntale a Deseret</span>
        </button>
        <div id="chat-window" style="display: none;" role="dialog" aria-label="Deseret, asistente de IA">
          <div id="chat-header">
            <div class="deseret-id">
              <img src="${AVATAR}" alt="" />
              <div><div class="nombre">Deseret</div><div class="estado">Asistente IA</div></div>
            </div>
            <div class="deseret-botones">
              <button id="chat-hey-btn" title='Activar "Hey Deseret"' aria-label='Activar "Hey Deseret"' aria-pressed="false" style="display:none">${ICONOS.oido}</button>
              <button id="chat-auto-btn" title="Modo conducción (solo voz, respuestas cortas)" aria-label="Modo conducción" aria-pressed="false">${ICONOS.auto}</button>
              <button id="chat-voice-btn" title="Leer respuestas en voz alta" aria-label="Leer respuestas en voz alta" aria-pressed="false">${ICONOS.vozOff}</button>
              <button id="chat-reset-btn" title="Reiniciar conversación" aria-label="Reiniciar conversación">${ICONOS.reiniciar}</button>
              <button id="chat-close-btn" title="Cerrar" aria-label="Cerrar">${ICONOS.cerrar}</button>
            </div>
          </div>
          <div class="deseret-voz-barra" role="radiogroup" aria-label="Voz de Deseret"><span class="lbl">Voz:</span><span class="deseret-voz-op"><button type="button" role="radio" data-voz="femenina">👩 Femenina</button><button type="button" role="radio" data-voz="masculina">👨 Masculina</button></span></div>
          <div class="deseret-auto-aviso">🚗 Modo conducción: háblame y te respondo en voz, corto. No mires la pantalla mientras manejas.</div>
          <div id="chat-messages" aria-live="polite"></div>
          <div id="chat-input-area">
            <button id="chat-mic-btn" title="Dictar por voz" aria-label="Dictar por voz">${ICONOS.mic}</button>
            <input type="text" id="chat-input" placeholder="Pregunta o pide agendar algo..." enterkeyhint="send" />
            <button id="chat-send-btn" title="Enviar" aria-label="Enviar">${ICONOS.enviar}</button>
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

  // Cuadro: en los comparativos (voz 'columnas') la primera columna es la
  // etiqueta de cada fila y se destacan las filas donde las personas difieren.
  function htmlTabla(t) {
    const cols = t.columnas || [];
    const comparativo = t.voz === 'columnas';
    const cabeza = `<thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>`;
    const cuerpo = (t.filas || []).map((f) => {
      const distinto = comparativo && !t.sinResaltar?.includes(f[0]) && new Set(f.slice(1)).size > 1;
      return `<tr>${f.map((v, i) => (i === 0 && comparativo
        ? `<th scope="row">${escapeHtml(v)}</th>`
        : `<td${distinto && i > 0 ? ' class="distinto"' : ''}>${escapeHtml(v)}</td>`)).join('')}</tr>`;
    }).join('');
    return `<div class="deseret-tabla-wrap"><table class="deseret-tabla${comparativo ? '' : ' lista'}">${cabeza}<tbody>${cuerpo}</tbody></table></div>`;
  }
  const tablaComoTexto = (t) => [t.columnas || [], ...(t.filas || [])].map((f) => f.join('\t')).join('\n');

  function htmlItems(items) {
    return `<div class="deseret-items">${items.map((it) => {
      const icono = { entrevista: '🙋 ', aseo: '🧹 ', recordatorio: '⏰ ', acta: '📋 ', compromiso: '🎯 ' }[it.tipo] || '';
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
        + (Array.isArray(extra.items) && extra.items.length ? htmlItems(extra.items) : '')
        + (extra.tabla?.filas?.length ? htmlTabla(extra.tabla) : '');
      if (extra.tabla?.filas?.length) div.classList.add('con-tabla');
      if (Array.isArray(extra.opciones) && extra.opciones.length) {
        const chips = document.createElement('div');
        chips.className = 'deseret-chips';
        extra.opciones.forEach((o) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = `deseret-chip${/confirmar/i.test(o.value) ? ' primario' : ''}`;
          b.textContent = o.label;
          // Botones especiales: "📇 Ver ficha completa" abre la Ficha 360° de la app.
          // Se cierra el chat antes de abrirla: la ficha es un modal de la app
          // (z-index 100) y quedaba DETRÁS de la ventana de Deseret (1000) —
          // en el celular, donde el chat ocupa toda la pantalla, no se veía.
          // La conversación no se pierde: al volver a tocar la abeja sigue ahí.
          if (o.ficha && typeof window.abrirFichaPersona === 'function') {
            b.addEventListener('click', () => {
              chatWindow.style.display = 'none';
              callar();
              window.abrirFichaPersona(o.ficha);
            });
          }
          else b.addEventListener('click', () => enviar(o.value, o.label));
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
        copiar.innerHTML = `${ICONOS.copiar}<span>Copiar</span>`;
        copiar.title = 'Copiar respuesta';
        copiar.addEventListener('click', () => {
          // Con cuadro, se copia también (separado por tabulaciones: se pega
          // directo como tabla en Excel, Google Sheets o Word).
          const texto = (div.querySelector('.cuerpo')?.innerText || '') + (m.extra?.tabla?.filas?.length ? `\n\n${tablaComoTexto(m.extra.tabla)}` : '');
          navigator.clipboard?.writeText(texto).then(() => {
            copiar.innerHTML = `${ICONOS.ok}<span>Copiado</span>`;
            setTimeout(() => { copiar.innerHTML = `${ICONOS.copiar}<span>Copiar</span>`; }, 1500);
          });
        });
        acciones.appendChild(copiar);
        // Punto 10: 👍/👎 para saber qué respuestas sirven (se guarda sin nombre).
        if (m.pregunta) {
          for (const [icono, valor] of [[ICONOS.arriba, 1], [ICONOS.abajo, -1]]) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'btn-action';
            b.innerHTML = icono;
            b.setAttribute('aria-label', valor === 1 ? 'Me sirvió' : 'No me sirvió');
            b.title = valor === 1 ? 'Me sirvió' : 'No me sirvió';
            if (m.valorado) { b.disabled = true; if (m.valorado === valor) b.classList.add('activo'); }
            b.addEventListener('click', async () => {
              m.valorado = valor;
              guardar();
              acciones.querySelectorAll('.btn-valor').forEach((x) => { x.disabled = true; });
              b.classList.add('activo');
              try {
                let token = null;
                try { token = localStorage.getItem('cow_token'); } catch { token = null; }
                await fetch('/api/chat/feedback', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                  body: JSON.stringify({ mensaje: m.pregunta, respuesta: m.texto, valor }),
                });
              } catch { /* sin conexión: no importa */ }
            });
            b.classList.add('btn-valor');
            acciones.appendChild(b);
          }
        }
        div.appendChild(acciones);
      }
    }
    messagesDiv.appendChild(div);
    scrollAbajo();
  }

  // Bienvenida: la abeja en grande + sugerencias, mientras no se haya escrito nada.
  function pintarBienvenida() {
    const w = document.createElement('div');
    w.className = 'deseret-bienvenida';
    w.innerHTML = `<img src="${AVATAR}" alt="" /><div class="t">Deseret</div><div class="s">Tu asistente para organizar el barrio</div>`;
    const chips = document.createElement('div');
    chips.className = 'deseret-chips';
    SUGERENCIAS.forEach((q) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'deseret-chip';
      b.textContent = q;
      b.addEventListener('click', () => { w.remove(); enviar(q); });
      chips.appendChild(b);
    });
    w.appendChild(chips);
    messagesDiv.appendChild(w);
  }

  function repintarTodo() {
    messagesDiv.innerHTML = '';
    if (!estado.msgs.length) estado.msgs.push({ role: 'bot', texto: SALUDO });
    if (!estado.msgs.some((m) => m.role === 'user')) pintarBienvenida();
    estado.msgs.forEach(pintarMensaje);
  }
  repintarTodo();

  // ---------------- Punto 15: leer respuestas en voz alta ----------------
  let vozActiva = store.get('localStorage', CLAVE_VOZ) === true;
  let ultimaFueDictada = false;
  const puedeHablar = 'speechSynthesis' in window;
  const pintarBotonVoz = () => {
    chatWindow.classList.toggle('voz-on', vozActiva);
    const tipo = store.get('localStorage', CLAVE_VOZ_TIPO) === 'masculina' ? 'masculina' : 'femenina';
    chatWindow.querySelectorAll('.deseret-voz-barra [data-voz]').forEach((b) => { const on = b.dataset.voz === tipo; b.classList.toggle('activa', on); b.setAttribute('aria-checked', String(on)); });
    voiceBtn.innerHTML = vozActiva ? ICONOS.vozOn : ICONOS.vozOff;
    voiceBtn.setAttribute('aria-pressed', String(vozActiva));
    voiceBtn.title = vozActiva ? 'Leer respuestas en voz alta: activado' : 'Leer respuestas en voz alta: desactivado';
  };
  if (!puedeHablar) estadoVozServidor().then((ok) => { if (!ok) voiceBtn.style.display = 'none'; });
  pintarBotonVoz();
  voiceBtn.addEventListener('click', () => {
    vozActiva = !vozActiva;
    store.set('localStorage', CLAVE_VOZ, vozActiva);
    pintarBotonVoz();
    if (!vozActiva) callar();
  });

  chatWindow.querySelectorAll('.deseret-voz-barra [data-voz]').forEach((b) => b.addEventListener('click', () => {
    store.set('localStorage', CLAVE_VOZ_TIPO, b.dataset.voz);
    pintarBotonVoz();
    window.deseretVoz?.probar();
  }));

  // Voz: primero la voz neuronal chilena del servidor (Azure, si está
  // configurada); si no está o falla, la mejor voz en español del
  // navegador, prefiriendo Chile y Latinoamérica antes que España.
  let vozServidor = null; // null = sin consultar; true/false = respuesta del servidor
  const tokenSesion = () => { try { return localStorage.getItem('cow_token'); } catch { return null; } };
  const estadoVozServidor = async () => {
    if (vozServidor !== null) return vozServidor;
    try {
      const token = tokenSesion();
      const r = await fetch('/api/tts/estado', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      vozServidor = r.ok && (await r.json()).disponible === true;
    } catch { vozServidor = false; }
    return vozServidor;
  };
  // Un solo <audio> reutilizado. En iPhone (y algunos Android) el audio que
  // llega después de una espera solo suena si ese mismo elemento ya se
  // reprodujo con un toque: por eso se "desbloquea" con el primer toque en
  // el chat, reproduciéndolo en silencio.
  const audio = new Audio();
  audio.preload = 'auto';
  let audioDesbloqueado = false;
  chatWindow.addEventListener('pointerdown', () => {
    if (audioDesbloqueado) return;
    audioDesbloqueado = true;
    audio.muted = true;
    audio.play().catch(() => {}).finally(() => { audio.pause(); audio.muted = false; });
  }, { capture: true });
  let turnoVoz = 0; // para descartar un audio que llega después de "callar"
  function callar() {
    turnoVoz++;
    try { audio.pause(); } catch { /* no había nada sonando */ }
    if (puedeHablar) window.speechSynthesis.cancel();
  }
  // Voz femenina o masculina (la elige cada persona: "usa voz masculina", o
  // en Accesibilidad). Se guarda en este dispositivo.
  const tipoVoz = () => (store.get('localStorage', CLAVE_VOZ_TIPO) === 'masculina' ? 'masculina' : 'femenina');
  const VOCES_HOMBRE = /lorenzo|jorge|pablo|raul|ra[uú]l|alvaro|[aá]lvaro|diego|tom[aá]s|gonzalo|carlos|enrique|juan|miguel|andr[eé]s|dario|dar[ií]o|gerardo|liberto|hombre|male|masculin/i;
  const VOCES_MUJER = /catalina|helena|laura|sabina|paulina|m[oó]nica|elvira|dalia|elena|luc[ií]a|paloma|isabel|mar[ií]a|francisca|camila|ximena|mujer|female|femenin/i;
  function mejorVozNavegador() {
    const voces = puedeHablar ? window.speechSynthesis.getVoices().filter((v) => /^es[-_]/i.test(v.lang)) : [];
    const quiere = tipoVoz();
    const puntaje = (v) => {
      const genero = VOCES_HOMBRE.test(v.name) ? 'masculina' : VOCES_MUJER.test(v.name) ? 'femenina' : null;
      const lang = v.lang.replace('_', '-').toLowerCase();
      let p = { 'es-cl': 60, 'es-419': 45, 'es-us': 42, 'es-mx': 40, 'es-ar': 40, 'es-co': 38, 'es-pe': 38 }[lang] ?? (lang === 'es-es' ? 5 : 25);
      if (/natural|online|neural|premium|enhanced|google/i.test(v.name)) p += 30; // voces más naturales
      if (/catalina|lorenzo/i.test(v.name)) p += 20; // voces chilenas de Microsoft (Edge)
      if (genero === quiere) p += 100; else if (genero) p -= 50; // primero el tipo de voz elegido
      return p;
    };
    return voces.sort((a, b) => puntaje(b) - puntaje(a))[0] || null;
  }
  // Texto → frases para hablar, con PAUSAS naturales: cada línea, viñeta o
  // dato de una lista ("Edad: 38", "• Asistencia alta") queda como frase
  // aparte terminada en punto — antes todo se juntaba en una sola tirada sin
  // respirar. Se quitan emojis y marcas de formato.
  const MESES_L = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  function frasesParaVoz(texto) {
    return String(texto || '')
      .replace(/\*\*([^*]+)\*\*\s*:/g, '$1:')
      .split(/\n+/)
      .map((l) => l
        .replace(/[*_`#>«»]/g, '')
        .replace(/\p{Extended_Pictographic}|\uFE0F/gu, '')
        .replace(/^\s*(?:[•\-–]|\d+\.)\s*/, '')
        .replace(/\s*[·|]\s*/g, '. ')
        .replace(/\s+[—–→]\s+/g, ', ')
        // "2026-08-10" → "10 de agosto" (si no, lo lee como números sueltos).
        .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (x, y, m, d) => `${Number(d)} de ${MESES_L[Number(m) - 1] || m}`)
        .trim()
        // "Aracena Gajardo, Gabriel" (así viene del Directorio) → "Gabriel Aracena Gajardo".
        .replace(/^([\p{Lu}][\p{L}'-]+(?: [\p{Lu}][\p{L}'-]+)?), ([\p{Lu}][\p{L}'-]+(?: [\p{L}'-]+){0,3})$/u, '$2 $1')
        .replace(/\s+/g, ' ')
        .trim())
      .filter((l) => /[\p{L}\p{N}]/u.test(l))
      .map((l) => (/[.!?¿¡:;,]$/.test(l) ? l.replace(/[:;,]$/, '.') : `${l}.`));
  }
  function hablarNavegador(frases, alTerminar) {
    if (!puedeHablar) { if (alTerminar) alTerminar(); return; }
    window.speechSynthesis.cancel();
    const voz = mejorVozNavegador();
    // Una frase por "utterance": el navegador hace una pausa real entre cada una.
    frases.forEach((f, i) => {
      const u = new SpeechSynthesisUtterance(f);
      u.voice = voz;
      u.lang = voz?.lang || 'es-CL';
      u.rate = 0.95;
      if (i === frases.length - 1 && alTerminar) u.onend = alTerminar;
      window.speechSynthesis.speak(u);
    });
  }
  window.deseretVoz = {
    tipo: tipoVoz,
    elegir(t) { store.set('localStorage', CLAVE_VOZ_TIPO, t === 'masculina' ? 'masculina' : 'femenina'); pintarBotonVoz(); },
    probar() { hablar(tipoVoz() === 'masculina' ? 'Hola, soy Deseret. Así sueno con voz masculina.' : 'Hola, soy Deseret. Así sueno con voz femenina.'); },
  };
  async function hablar(texto, alTerminar = null) {
    if (!texto) return;
    const frases = frasesParaVoz(texto);
    const limpio = frases.join('\n');
    if (!limpio) return;
    callar();
    const turno = turnoVoz;
    if (await estadoVozServidor()) {
      try {
        const token = tokenSesion();
        const r = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ texto: limpio, voz: tipoVoz() }),
        });
        if (!r.ok) throw new Error(String(r.status));
        const blob = await r.blob();
        if (turno !== turnoVoz) return; // se pidió callar mientras llegaba
        if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
        audio.src = URL.createObjectURL(blob);
        audio.onended = alTerminar || null;
        await audio.play();
        return;
      } catch {
        if (turno !== turnoVoz) return;
        // Falló la voz del servidor (sin internet, cuota agotada, audio
        // bloqueado): se usa la del navegador para no quedar en silencio.
      }
    }
    hablarNavegador(frases, alTerminar);
  }

  // Lo que se LEE en voz alta: el texto + la tarjeta de confirmación + las
  // opciones (si no venían ya numeradas en el texto) — sin esto, quien usa
  // solo la voz escucha "¿Lo registro así?" sin saber qué se va a registrar.
  const DIAS_L = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const diaHablado = (iso) => { const [y, mm, d] = String(iso).split('-').map(Number); return y ? `el ${DIAS_L[new Date(y, mm - 1, d, 12).getDay()]} ${d}` : ''; };
  const sinEmoji = (t) => String(t || '').replace(/\p{Extended_Pictographic}/gu, '').replace(/^\s*\d+\.\s*/, '').trim();
  function textoParaVoz(m) {
    // Las aclaraciones entre paréntesis ("puedes cambiar la fecha…") se
    // omiten al leer: alargan la frase y en voz no aportan.
    const partes = [String(m.texto || '').replace(/\s*\((puedes|queda|ej\.)[^)]*\)/gi, '')];
    const t = m.extra?.tarjeta;
    if (t) partes.push([t.titulo, ...(t.filas || []).map((f) => f[1])].filter(Boolean).join('\n'));
    // Las tarjetas de la agenda también se leen ("¿qué tengo hoy?").
    const items = (m.extra?.items || []).filter((it) => it.tipo !== 'acta');
    if (items.length) {
      const max = conduccion ? 3 : 6;
      const unDia = items.every((it) => it.fecha === items[0].fecha);
      const que = { entrevista: 'Entrevista con', actividad: '', compromiso: 'Compromiso:', recordatorio: 'Recordatorio:', aseo: 'Aseo:', solicitud: 'Solicitud de' };
      partes.push(items.slice(0, max).map((it) => `${unDia ? '' : `${diaHablado(it.fecha)}, `}${it.hora ? `a las ${it.hora}, ` : ''}${que[it.tipo] ?? ''} ${it.titulo}`.replace(/\s+/g, ' ').trim()).join('\n') + (items.length > max ? `\nY ${items.length - max} más.` : ''));
    }
    // Cuadros: comparativo = fila por fila ("Asistencia: Gabriel, alto; Jaime,
    // bajo"), solo donde difieren; lista = una persona por línea.
    const tb = m.extra?.tabla;
    if (tb?.filas?.length) {
      const max = conduccion ? 3 : 6;
      if (tb.voz === 'columnas') {
        const nombres = tb.columnas.slice(1).map((c) => String(c).split(/\s+/)[0]);
        const difieren = tb.filas.filter((f) => new Set(f.slice(1)).size > 1);
        const leer = (difieren.length ? difieren : tb.filas).slice(0, max);
        partes.push(leer.map((f) => `${f[0]}: ${nombres.map((n, i) => `${n}, ${f[i + 1]}`).join('; ')}.`).join('\n'));
      } else {
        partes.push(tb.filas.slice(0, max).map((f) => `${f[0]}: ${f.slice(1).join(', ')}.`).join('\n') + (tb.filas.length > max ? `\nY ${tb.filas.length - max} más.` : ''));
      }
    }
    const ops = m.extra?.opciones || [];
    if (ops.length && !/\*\*1\.\*\*/.test(m.texto)) {
      const esConfirmar = ops.some((o) => /confirmar/i.test(o.value));
      partes.push(esConfirmar ? 'Di sí para confirmar, o no para cancelar.' : `Puedes decir: ${ops.slice(0, 4).map((o) => sinEmoji(o.label)).join(', o ')}.`);
    }
    return partes.join('\n');
  }
  // ¿Deseret quedó esperando una respuesta? (para volver a abrir el micrófono)
  const esperaRespuesta = (m) => !m.error && ((m.extra?.opciones || []).length > 0 || /\?\s*$/.test(String(m.texto || '').trim()));

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

    store.set('localStorage', 'deseret_usado', true); // A17: "Pregúntale algo a Deseret" ✓
    // Comandos que se resuelven aquí mismo (sin ir al servidor).
    const tn = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const cambioVoz = /\b(voz|habla\w*|hablame)\b.*\b(masculin\w*|de hombre|hombre|varon)\b/.test(tn) ? 'masculina'
      : /\b(voz|habla\w*|hablame)\b.*\b(femenin\w*|de mujer|mujer)\b/.test(tn) ? 'femenina' : null;
    const escucharReunion = /^(deseret,?\s*)?(escucha|graba|grabar|escuchar|toma (nota|notas|el acta) de)\s+(la|esta|mi|una)?\s*reunion\b|\bmodo oyente\b/.test(tn);
    // "Deseret, comienza la reunión (de presidencia)" / "termina la reunión".
    const comienza = tn.match(/^(deseret,?\s*)?(comienza|comenzamos|comencemos|empieza|empezamos|empecemos|inicia|iniciamos|iniciemos|partamos|partimos|arranca|arrancamos|da inicio a)\s+(con\s+)?(la|una|nuestra|esta)?\s*reunion\b\s*(.*)$/);
    const termina = /^(deseret,?\s*)?(termina|terminamos|terminemos|finaliza|finalizamos|cierra|cerramos|concluye|da por terminada|fin de)\s+(la\s+|esta\s+)?reunion\b/.test(tn);
    if ((comienza || termina) && typeof window.escucharYa === 'function') {
      enviando = false; sendBtn.disabled = false; chatInput.value = '';
      messagesDiv.querySelector('.deseret-bienvenida')?.remove();
      estado.msgs.push({ role: 'user', texto: text }); pintarMensaje(estado.msgs.at(-1));
      const decir = (t) => { estado.msgs.push({ role: 'bot', texto: t }); pintarMensaje(estado.msgs.at(-1)); guardar(); if (vozActiva || dictada || conduccion) hablar(t); };
      const dictada = ultimaFueDictada; ultimaFueDictada = false;
      if (termina) {
        if (window.terminarEscucha()) { chatWindow.style.display = 'none'; decir('✅ Terminé de escuchar. Te muestro dónde guardar el acta para que la revises.'); }
        else decir('No estoy escuchando ninguna reunión en este momento. Para empezar, dime **"comienza la reunión"**.');
        return;
      }
      // Lo que viene después de "reunión" es el nombre: "…de presidencia del cuórum".
      const resto = text.replace(/^.*?reuni[oó]n\b\s*/i, '').replace(/[.!?¿¡]+$/, '').trim();
      const titulo = resto ? `Reunión ${resto}`.slice(0, 100) : '';
      const r = await window.escucharYa({ titulo, onGuardado: () => { if (typeof window.renderMeetingsView === 'function') window.renderMeetingsView(); } });
      if (r === 'empezo') { chatWindow.style.display = 'none'; decir(`🎙️ Empiezo a escuchar${titulo ? ` la **${titulo}**` : ' la reunión'}. Recuerda avisar a los presentes. Cuando terminen, dime **"Deseret, termina la reunión"** o toca el aviso de abajo.`); }
      else if (r === 'ya') decir('Ya estoy escuchando la reunión. Para terminar, dime **"termina la reunión"**.');
      else { chatWindow.style.display = 'none'; }
      return;
    }
    if (cambioVoz || (escucharReunion && typeof window.abrirEscuchaReunion === 'function')) {
      enviando = false; sendBtn.disabled = false; chatInput.value = '';
      messagesDiv.querySelector('.deseret-bienvenida')?.remove();
      estado.msgs.push({ role: 'user', texto: text }); pintarMensaje(estado.msgs.at(-1));
      if (cambioVoz) {
        window.deseretVoz.elegir(cambioVoz);
        estado.msgs.push({ role: 'bot', texto: `🔊 Listo, desde ahora te hablo con **voz ${cambioVoz}** en este dispositivo.${vozActiva ? '' : ' (Activa la lectura en voz alta con el botón del parlante para escucharme.)'}` });
        pintarMensaje(estado.msgs.at(-1)); guardar();
        window.deseretVoz.probar();
      } else {
        estado.msgs.push({ role: 'bot', texto: '🎙️ Abro el modo **"Deseret escucha la reunión"**: grabo, transcribo y al final te propongo el acta para que la revises.' });
        pintarMensaje(estado.msgs.at(-1)); guardar();
        chatWindow.style.display = 'none'; callar();
        window.abrirEscuchaReunion({ onGuardado: () => { if (typeof window.renderMeetingsView === 'function') window.renderMeetingsView(); } });
      }
      return;
    }
    const dictada = ultimaFueDictada;
    ultimaFueDictada = false;
    quitarChipsViejos();
    messagesDiv.querySelector('.deseret-bienvenida')?.remove();
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
        body: JSON.stringify({ mensaje: text, historial: estado.historial, breve: conduccion }),
      });
      const data = await response.json();
      const { respuesta, error, ...extra } = data || {};
      const texto = respuesta || error || 'No pude procesar la respuesta.';
      msgBot = { role: 'bot', texto, extra, error: !respuesta, pregunta: text };
      // Lo que se mostró como tarjetas también queda en el historial, para
      // que Deseret entienda "cámbiala", "cancélala"… en el mensaje siguiente.
      const vistos = [extra.tarjeta?.filas?.map((f) => f[1]).join(' · '), ...(extra.items || []).slice(0, 8).map((it) => `${it.titulo} (${it.fecha}${it.hora ? ` ${it.hora}` : ''})`)].filter(Boolean);
      estado.historial.push({ user: text, bot: vistos.length ? `${texto}\n[${vistos.join('; ')}]` : texto });
    } catch (e) {
      msgBot = { role: 'bot', texto: 'Error de conexión. Revisa tu internet e intenta de nuevo.', error: true };
    }
    typing.remove();
    estado.msgs.push(msgBot);
    pintarMensaje(msgBot);
    guardar();
    if (vozActiva || dictada || conduccion) {
      // Conversación por voz: si se habló y Deseret hizo una pregunta, al
      // terminar de leerla se vuelve a abrir el micrófono (manos libres).
      // En modo conducción se vuelve a abrir SIEMPRE (si no dices nada, se
      // apaga solo a los pocos segundos).
      const seguir = (dictada && esperaRespuesta(msgBot)) || conduccion
        ? () => setTimeout(() => {
          if (chatWindow.style.display !== 'none' && !micBtn.classList.contains('mic-listening') && micBtn.style.display !== 'none') micBtn.click();
        }, 300)
        : null;
      hablar(textoParaVoz(msgBot), seguir);
    }
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
    if (abrir) {
      scrollAbajo(); chatInput.focus();
      mostrarAvisos();
      if (conduccion) setTimeout(() => { if (!micBtn.classList.contains('mic-listening') && micBtn.style.display !== 'none') micBtn.click(); }, 400);
    } else callar();
  };
  document.getElementById('chat-close-btn').addEventListener('click', toggleChat);

  // ---------------- D6: avisos al abrir el chat (una vez al día) ----------------
  async function mostrarAvisos() {
    const hoy = new Date().toLocaleDateString('en-CA');
    if (store.get('localStorage', CLAVE_AVISOS) === hoy) return;
    store.set('localStorage', CLAVE_AVISOS, hoy);
    try {
      let token = null;
      try { token = localStorage.getItem('cow_token'); } catch { token = null; }
      const r = await fetch('/api/deseret/avisos', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const a = r.ok ? await r.json() : null;
      if (!a?.texto) return;
      quitarChipsViejos();
      messagesDiv.querySelector('.deseret-bienvenida')?.remove();
      const m = { role: 'bot', texto: a.texto, extra: { opciones: a.opciones || [] } };
      estado.msgs.push(m);
      pintarMensaje(m);
      guardar();
    } catch { /* sin conexión: no pasa nada */ }
  }

  // ---------------- D13: modo conducción ----------------
  let conduccion = store.get('localStorage', CLAVE_AUTO) === true;
  const autoBtn = document.getElementById('chat-auto-btn');
  const pintarAuto = () => {
    chatWindow.classList.toggle('conduccion', conduccion);
    autoBtn.classList.toggle('auto-on', conduccion);
    autoBtn.setAttribute('aria-pressed', String(conduccion));
    autoBtn.title = conduccion ? 'Modo conducción activado — toca para salir' : 'Modo conducción (solo voz, respuestas cortas)';
  };
  pintarAuto();
  autoBtn.addEventListener('click', () => {
    conduccion = !conduccion;
    store.set('localStorage', CLAVE_AUTO, conduccion);
    pintarAuto();
    if (conduccion) {
      hablar('Modo conducción activado. Te escucho.', () => { if (!micBtn.classList.contains('mic-listening') && micBtn.style.display !== 'none') micBtn.click(); });
    } else callar();
  });

  // ---------------- Botón flotante + presentación ----------------
  const fab = document.getElementById('deseret-fab');
  let hayApp = false; // ¿estamos dentro de la app (no en el login)?
  fab.addEventListener('click', () => { cerrarIntro(); if (chatWindow.style.display === 'none') toggleChat(); });
  const cerrarIntro = () => {
    document.getElementById('deseret-intro')?.remove();
    store.set('localStorage', CLAVE_INTRO, true);
  };
  function mostrarIntro() {
    if (store.get('localStorage', CLAVE_INTRO) || document.getElementById('deseret-intro') || !hayApp) return;
    // Si está abierto el tour de bienvenida u otro modal, esperar a que se cierre.
    if (document.querySelector('.modal-backdrop')) { setTimeout(mostrarIntro, 3000); return; }
    const d = document.createElement('div');
    d.id = 'deseret-intro';
    d.setAttribute('role', 'status');
    d.innerHTML = `<button class="x" type="button" aria-label="Cerrar">×</button><b>¡Hola! Soy Deseret 👋</b>Tu asistente con IA. Pregúntame lo que necesites o pídeme agendar una entrevista o actividad.${heySoportado ? ' También puedes activar <b style="display:inline">“Hey Deseret”</b> para llamarme con la voz.' : ''}`;
    d.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); cerrarIntro(); });
    d.addEventListener('click', () => { cerrarIntro(); if (chatWindow.style.display === 'none') toggleChat(); });
    document.getElementById('organiza-chat-widget').appendChild(d);
    setTimeout(() => { if (document.getElementById('deseret-intro')) cerrarIntro(); }, 15000);
  }
  // El botón y la escucha siguen el estado de la ventana, sin importar
  // quién la abrió o cerró (logo, botón, chip de ficha, cierre de sesión).
  const sincronizar = () => {
    const abierta = chatWindow.style.display !== 'none';
    fab.style.display = hayApp && !abierta ? 'flex' : 'none';
    if (abierta) { cerrarIntro(); hey.pausar(); } else hey.reanudar();
  };
  new MutationObserver(sincronizar).observe(chatWindow, { attributes: true, attributeFilter: ['style'] });

  // ---------------- "Hey Deseret": abrir el chat con la voz ----------------
  // Escucha continua con el reconocimiento de voz del navegador (Chrome /
  // Edge). Es OPCIONAL (apagado por defecto, se activa por dispositivo) y
  // solo escucha mientras la pestaña de la app está visible y el chat
  // cerrado. Al oír "Hey Deseret" abre el chat; si la frase ya trae la
  // pregunta ("Hey Deseret, ¿qué tengo esta semana?") la envía de una.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const heySoportado = !!SR;
  const modoSilenciosoGlobal = /Android/i.test(navigator.userAgent);
  const heyBtn = document.getElementById('chat-hey-btn');
  const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // ¿Dijo "Hey Deseret"? El reconocimiento de voz escribe el nombre de mil
  // formas ("deseret", "desert", "de seret", "desiré", "the seret"...), así
  // que se compara "parecido" (distancia de edición), no exacto: una palabra
  // (o dos juntas) que se parezca a "deseret", al inicio de la frase o justo
  // después de un saludo. Devuelve lo que se dijo DESPUÉS (la pregunta), o
  // null si no lo llamaron.
  const SALUDOS = new Set(['hey', 'hei', 'ey', 'ei', 'e', 'oye', 'oiga', 'hola', 'ok', 'okey', 'okay', 'ay', 'hay', 'a']);
  function distancia(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return d[a.length][b.length];
  }
  const pareceDeseret = (w) => w.length >= 5 && w.length <= 9 && /^[dt]/.test(w) && distancia(w.replace(/^th/, 'd'), 'deseret') <= 2;
  function buscarLlamado(original) {
    const orig = String(original || '').trim().split(/\s+/).filter(Boolean);
    const pal = orig.map((w) => norm(w).replace(/[^a-z0-9ñ]/g, ''));
    for (let k = 0; k < pal.length; k++) {
      const antes = pal[k - 1];
      const alInicio = k === 0 || (k === 1 && SALUDOS.has(antes)) || SALUDOS.has(antes);
      if (!alInicio) continue;
      let largo = 0;
      if (pareceDeseret(pal[k])) largo = 1;
      else if (pal[k + 1] && pareceDeseret(pal[k] + pal[k + 1])) largo = 2; // "de seret", "the seret"
      if (largo) return orig.slice(k + largo).join(' ').replace(/^[,.\s!¡?¿]+/, '');
    }
    return null;
  }
  const hey = (() => {
    let activo = heySoportado && store.get('localStorage', CLAVE_HEY) === true;
    let rec = null; let corriendo = false; let pausado = false; let fallosSeguidos = 0;
    let inicioSesion = 0; let pendiente = null; let timerPendiente = null; let errorAvisado = false;
    const puedeCorrer = () => activo && !pausado && hayApp && !document.hidden;
    const marcarEscuchando = (on) => fab.classList.toggle('escuchando-ahora', on);
    // ANDROID: cada vez que se enciende el reconocimiento de voz, Android hace
    // un "bip" que una página web no puede silenciar, y como corta la escucha
    // cada pocos segundos, el bip sonaba todo el rato. Por eso en Android el
    // micrófono queda abierto en SILENCIO midiendo solo el volumen (esto no
    // suena ni envía audio a nadie) y el reconocimiento, con su bip, se
    // enciende solo cuando detecta que alguien habla.
    const modoSilencioso = /Android/i.test(navigator.userAgent) && !!navigator.mediaDevices?.getUserMedia;
    let despierto = false; let vig = null; let ctxAudio = null; let sesionesVacias = 0; let llamadoEnSesion = false;
    if (modoSilencioso) {
      // Android crea el audio "suspendido" hasta que la persona toca la pantalla.
      document.addEventListener('pointerdown', () => { if (ctxAudio && ctxAudio.state === 'suspended') ctxAudio.resume().catch(() => {}); }, { capture: true, passive: true });
    }
    function soltarVigilancia() {
      if (!vig) return;
      vig.parado = true;
      clearInterval(vig.timer);
      try { vig.src?.disconnect(); } catch { /* ya estaba desconectado */ }
      vig.stream?.getTracks().forEach((t) => t.stop());
      vig = null;
      fab.classList.remove('vigilando');
    }
    function vigilar() {
      if (vig || !puedeCorrer()) return;
      const v = { parado: false };
      vig = v;
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then((stream) => {
        if (v.parado || vig !== v) { stream.getTracks().forEach((t) => t.stop()); return; }
        v.stream = stream;
        ctxAudio = ctxAudio || new (window.AudioContext || window.webkitAudioContext)();
        if (ctxAudio.state === 'suspended') ctxAudio.resume().catch(() => {});
        v.src = ctxAudio.createMediaStreamSource(stream);
        const an = ctxAudio.createAnalyser();
        an.fftSize = 1024;
        v.src.connect(an);
        const buf = new Float32Array(an.fftSize);
        let piso = 0.008; let seguidos = 0;
        fab.classList.add('vigilando');
        v.timer = setInterval(() => {
          if (ctxAudio.state !== 'running') return;
          an.getFloatTimeDomainData(buf);
          let suma = 0;
          for (let i = 0; i < buf.length; i++) suma += buf[i] * buf[i];
          const rms = Math.sqrt(suma / buf.length);
          // Voz = bastante más fuerte que el ruido de fondo (que se va
          // aprendiendo), sostenida por ~1/4 de segundo.
          if (rms > Math.max(piso * 3, 0.015)) {
            if (++seguidos >= 3) { soltarVigilancia(); despierto = true; arrancar(); }
          } else {
            seguidos = 0;
            piso = piso * 0.95 + rms * 0.05;
          }
        }, 80);
      }).catch((err) => {
        if (vig === v) vig = null;
        if (err && err.name === 'NotAllowedError') { sinPermiso(); return; }
        if (puedeCorrer()) setTimeout(arrancar, 3000);
      });
    }
    function sinPermiso() {
      activo = false; store.set('localStorage', CLAVE_HEY, false); pintar();
      estado.msgs.push({ role: 'bot', texto: 'No tengo permiso para usar el micrófono, así que desactivé **“Hey Deseret”**. Puedes darle permiso en el candado de la barra de direcciones (o en los permisos de la app) y volver a activarlo.', error: true });
      guardar(); repintarTodo();
    }
    function arrancar() {
      if (corriendo || !puedeCorrer()) return;
      if (modoSilencioso && !despierto) { vigilar(); return; }
      llamadoEnSesion = false;
      rec = new SR();
      // Resultados parciales: en Android la escucha "continua" se corta sola
      // cada pocos segundos, y con los parciales se alcanza a detectar el
      // llamado antes del corte.
      rec.lang = 'es-CL'; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 3;
      rec.onstart = () => { marcarEscuchando(true); };
      rec.onresult = (ev) => {
        // Se revisa lo escuchado en esta sesión (todas las alternativas).
        let final = false; let resto = null;
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          for (let a = 0; a < r.length && resto === null; a++) resto = buscarLlamado(r[a].transcript);
          if (r.isFinal) final = true;
          if (resto !== null) break;
        }
        if (resto === null && pendiente === null) return;
        if (resto !== null) pendiente = resto;
        clearTimeout(timerPendiente);
        // Si la frase terminó, se actúa ya; si no, se espera un momento por si
        // viene la pregunta completa ("Hey Deseret, ¿qué tengo hoy?").
        if (final) disparar(); else timerPendiente = setTimeout(disparar, 1300);
      };
      rec.onerror = (ev) => {
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
          sinPermiso();
        } else if ((ev.error === 'audio-capture' || ev.error === 'network') && !errorAvisado && fallosSeguidos >= 3) {
          errorAvisado = true;
          estado.msgs.push({ role: 'bot', texto: ev.error === 'network'
            ? '⚠️ “Hey Deseret” no puede escuchar: el reconocimiento de voz del teléfono necesita internet y no responde. Mientras tanto, toca la abeja para hablarme.'
            : '⚠️ “Hey Deseret” no puede usar el micrófono (quizás otra app lo está usando). Toca la abeja para hablarme.', error: true });
          guardar(); repintarTodo();
        }
      };
      rec.onend = () => {
        corriendo = false; marcarEscuchando(false);
        // El navegador corta la escucha cada tanto (en Android, cada pocos
        // segundos de silencio): se vuelve a encender al tiro. Solo si se
        // corta al instante una y otra vez (error), se espera un poco más.
        const duro = Date.now() - inicioSesion;
        fallosSeguidos = duro < 1500 ? fallosSeguidos + 1 : 0;
        let espera = fallosSeguidos ? Math.min(1000 * 2 ** (fallosSeguidos - 1), 8000) : 250;
        if (modoSilencioso) {
          // Vuelve a la escucha silenciosa. Si se despertó varias veces seguidas
          // sin que nadie dijera "Deseret" (una conversación, la tele), descansa
          // unos segundos para no pitar a cada rato.
          despierto = false;
          sesionesVacias = llamadoEnSesion ? 0 : sesionesVacias + 1;
          if (sesionesVacias >= 3) { sesionesVacias = 0; espera = Math.max(espera, 12000); } else espera = Math.max(espera, 600);
        }
        if (puedeCorrer()) setTimeout(arrancar, espera);
      };
      inicioSesion = Date.now();
      try { rec.start(); corriendo = true; } catch { corriendo = false; setTimeout(arrancar, 1000); }
    }
    function disparar() {
      clearTimeout(timerPendiente);
      if (pendiente === null) return;
      const resto = pendiente; pendiente = null;
      llamadoEnSesion = true;
      despertar(resto);
    }
    function detener() { soltarVigilancia(); despierto = false; clearTimeout(timerPendiente); pendiente = null; if (rec && corriendo) { try { rec.abort(); } catch { /* ya estaba detenido */ } } corriendo = false; marcarEscuchando(false); }
    function despertar(resto) {
      detener();
      if (chatWindow.style.display === 'none') toggleChat();
      const pregunta = resto.replace(/^[,.\s]+/, '');
      if (pregunta.split(/\s+/).filter(Boolean).length >= 2) {
        ultimaFueDictada = true; // la respuesta se lee en voz alta
        enviar(pregunta);
      } else {
        // Solo dijo "Hey Deseret": se abre el micrófono para la pregunta.
        setTimeout(() => { if (micBtn.style.display !== 'none') micBtn.click(); }, 350);
      }
    }
    function pintar() {
      heyBtn.classList.toggle('hey-on', activo);
      heyBtn.setAttribute('aria-pressed', String(activo));
      heyBtn.title = activo ? '“Hey Deseret” activado — toca para desactivar' : 'Activar “Hey Deseret” (llamarme con la voz)';
      fab.classList.toggle('hey', activo);
      fab.title = activo ? 'Deseret te escucha: di “Hey Deseret”' : 'Pregúntale a Deseret (asistente IA)';
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden) detener(); else arrancar(); });
    return {
      activo: () => activo,
      pintar,
      pausar() { pausado = true; detener(); },
      reanudar() { pausado = false; fallosSeguidos = 0; arrancar(); },
      alternar() {
        activo = !activo;
        store.set('localStorage', CLAVE_HEY, activo);
        pintar();
        if (!activo) detener();
        errorAvisado = false; fallosSeguidos = 0;
        return activo;
      },
    };
  })();
  if (heySoportado) {
    heyBtn.style.display = '';
    hey.pintar();
    heyBtn.addEventListener('click', () => {
      const on = hey.alternar();
      estado.msgs.push({ role: 'bot', texto: on
        ? '🎙️ **“Hey Deseret” activado** en este dispositivo. Cuando cierres el chat quedaré escuchando mientras la app esté abierta en pantalla: di **“Hey Deseret”** y me abro (o di de una vez tu pregunta, por ejemplo: “Hey Deseret, ¿qué tengo esta semana?”).\n\nEl navegador te pedirá permiso para el micrófono. Ojo: mientras escucho, el reconocimiento de voz del navegador procesa el audio (en Chrome, en los servidores de Google). Funciona mejor en computador con Chrome o Edge.' + (modoSilenciosoGlobal ? '\n\n📱 **En el teléfono:** para que no suene el “bip” todo el rato, espero en silencio y enciendo el reconocimiento solo cuando escucho a alguien hablar. Di **“Deseret”**, espera el bip y di tu pregunta (“Deseret, ¿qué tengo hoy?”).' : '') + '\n\nPuedes apagarlo cuando quieras con este mismo botón.'
        : '“Hey Deseret” desactivado. Ya no estoy escuchando.' });
      guardar(); repintarTodo();
      if (on) {
        // Pedir el permiso del micrófono ahora (con el clic), no más tarde.
        navigator.mediaDevices?.getUserMedia?.({ audio: true }).then((st) => st.getTracks().forEach((t) => t.stop())).catch(() => {});
      }
    });
  }
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
    const antes = hayApp;
    hayApp = !!logo;
    if (antes !== hayApp) { sincronizar(); if (hayApp) setTimeout(mostrarIntro, 1500); }
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
        callar();
        try { recognition.start(); } catch { /* ya estaba activo */ }
      } else {
        stopListeningState();
      }
    });

    recognition.onstart = () => {
      isListening = true;
      micBtn.classList.add('mic-listening');
      micBtn.title = 'Escuchando tu voz...';
      chatInput.placeholder = 'Escuchando…';
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
