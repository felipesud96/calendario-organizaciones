// Botón "atrás" del celular (Android / navegador).
// Antes, como la app no usa el historial del navegador, "atrás" sacaba de la
// app. Ahora, en orden:
//   1) si hay una ventana abierta (modal, hoja inferior, Deseret escuchando),
//      la cierra usando su propio botón de cerrar (así respeta los avisos de
//      "tienes cambios sin guardar");
//   2) si el chat de Deseret está abierto, lo cierra;
//   3) si estás en cualquier pestaña que no sea Inicio, vuelve a Inicio;
//   4) en Inicio sin nada abierto, "atrás" funciona normal (sale de la app).
// Técnica: se mantiene UNA sola entrada "centinela" en el historial mientras
// haya algo a lo que volver, y se quita cuando ya no hace falta.
(function () {
  if (!window.history || !history.pushState) return;
  let armado = false;
  let ignorarPop = false;

  const vista = () => { try { return state.view; } catch (e) { return 'home'; } };
  const modalAbierto = () => {
    const mr = document.getElementById('modal-root');
    return !!(mr && mr.querySelector('.modal-backdrop'));
  };
  const escuchaAbierta = () => {
    const er = document.getElementById('escucha-root');
    return !!(er && er.querySelector('.modal-backdrop'));
  };
  const chatAbierto = () => {
    const cw = document.getElementById('chat-window');
    return !!(cw && cw.style.display !== 'none');
  };
  const conSesion = () => { try { return !!state.user; } catch (e) { return false; } };
  const hayAlgoAtras = () => conSesion() && (escuchaAbierta() || modalAbierto() || chatAbierto() || (vista() && vista() !== 'home'));

  function cerrarVentana(root) {
    const fondos = root.querySelectorAll('.modal-backdrop');
    const bd = fondos[fondos.length - 1];
    if (!bd) return;
    const x = bd.querySelector('.modal-close');
    if (x) x.click();
    else bd.click(); // las hojas inferiores se cierran tocando el fondo
  }

  function sincronizar() {
    const falta = hayAlgoAtras();
    if (falta && !armado) {
      history.pushState({ organizasionAtras: 1 }, '');
      armado = true;
    } else if (!falta && armado && history.state && history.state.organizasionAtras) {
      // ya no hay nada a lo que volver: se quita la centinela sin que se note
      ignorarPop = true;
      armado = false;
      history.back();
    }
  }

  window.addEventListener('popstate', () => {
    if (ignorarPop) { ignorarPop = false; return; }
    armado = false;
    if (escuchaAbierta()) cerrarVentana(document.getElementById('escucha-root'));
    else if (modalAbierto()) cerrarVentana(document.getElementById('modal-root'));
    else if (chatAbierto()) { const b = document.getElementById('chat-close-btn'); if (b) b.click(); }
    else if (conSesion() && vista() !== 'home') {
      try { state.view = 'home'; renderCurrentView(); window.scrollTo(0, 0); } catch (e) { /* nada */ }
    }
    setTimeout(sincronizar, 60);
  });

  // Cada toque puede abrir una ventana o cambiar de pestaña: se revisa justo después.
  document.addEventListener('click', () => setTimeout(sincronizar, 60), true);
  document.addEventListener('keyup', () => setTimeout(sincronizar, 60), true);
  // Ventanas que se abren solas un poco después (al terminar de cargar datos).
  let pendiente = null;
  const revisarLuego = () => { if (!pendiente) pendiente = setTimeout(() => { pendiente = null; sincronizar(); }, 120); };
  const vigilar = () => {
    try { new MutationObserver(revisarLuego).observe(document.body, { childList: true, subtree: true }); } catch (e) { /* nada */ }
  };
  if (document.body) vigilar(); else document.addEventListener('DOMContentLoaded', vigilar);
})();
