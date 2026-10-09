// Service worker de OrganizaSion — Punto 39 (notificaciones push del
// navegador). Solo maneja los dos eventos que hacen falta para el push (no
// es un service worker "offline-first": no intercepta fetch ni cachea nada,
// eso queda fuera del alcance de este punto).
//
// El registro (navigator.serviceWorker.register('/sw.js')) lo hace
// registerServiceWorker() en app.js, apenas arranca la app — hace falta
// tener el service worker activo ANTES de poder suscribirse con
// pushManager.subscribe().

// ---------------- A2: funcionar sin internet ----------------
// Estrategia "red primero": con conexión todo funciona igual que siempre
// (siempre la versión más nueva); sin conexión, se muestra lo último que se
// guardó en este dispositivo — la app misma y las consultas GET a /api
// (agenda, actas, entrevistas...). Las escrituras (guardar, editar, borrar)
// NO se guardan para después: la app avisa que no hay conexión.
// Al cerrar sesión, app.js borra la caché de datos (CACHE_DATOS).
const CACHE_APP = 'organizasion-app-v1';
const CACHE_DATOS = 'organizasion-datos-v1';
const APP_SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/chatWidget.js', '/escucha.js', '/atras.js', '/afiche.js', '/organizar.js', '/agenda.js', '/deseret.svg', '/logo-bee.png', '/manifest.json', '/icon-192.png', '/vendor/qrcode.js'];
// Nunca se guardan: el chat, la voz, la sesión, datos públicos del enlace y archivos.
// (/api/auth/me sí se guarda: sin él, la app no sabría quién eres al abrirla sin internet.)
const SIN_CACHE = /^\/api\/(chat|tts|escucha|afiches|version|pendientes|recordatorios|auth\/(?!me$)|push|public|deseret|backups|admin-backup)|\/(export|download|pdf|ics)\b/;

self.addEventListener('install', (event) => {
  // activa esta versión de inmediato, sin esperar a que se cierren las
  // demás pestañas abiertas.
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_APP).then((c) => Promise.all(APP_SHELL.map((u) => c.add(u).catch(() => {})))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const vigentes = [CACHE_APP, CACHE_DATOS];
    for (const k of await caches.keys()) if (!vigentes.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'limpiar-datos') event.waitUntil(caches.delete(CACHE_DATOS));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || SIN_CACHE.test(url.pathname) || url.pathname.startsWith('/agendar')) return;
  const esApi = url.pathname.startsWith('/api/');
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copia = res.clone();
        caches.open(esApi ? CACHE_DATOS : CACHE_APP).then((c) => c.put(req, copia)).catch(() => {});
      }
      return res;
    } catch (err) {
      const guardada = await caches.match(req, { ignoreVary: true });
      if (guardada) {
        // Se marca para que la app sepa que está viendo datos guardados.
        const h = new Headers(guardada.headers); h.set('X-Sin-Conexion', '1');
        return new Response(await guardada.blob(), { status: guardada.status, statusText: guardada.statusText, headers: h });
      }
      if (req.mode === 'navigate') {
        const inicio = await caches.match('/', { ignoreSearch: true }) || await caches.match('/index.html');
        if (inicio) return inicio;
      }
      throw err;
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = { title: 'OrganizaSion', body: '', url: '/' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (err) {
    // el payload no era JSON válido — se muestra igual con el texto por defecto
  }
  // Avisos agrupados: si todavía hay avisos sin abrir de la app, se juntan
  // en uno solo ("3 novedades") en vez de llenar la barra de notificaciones.
  event.waitUntil((async () => {
    const nuevo = { title: data.title || 'OrganizaSion', body: data.body || '', url: data.url || '/', acciones: Array.isArray(data.acciones) ? data.acciones : null };
    let previos = [];
    try {
      const abiertas = await self.registration.getNotifications({ tag: 'organizasion' });
      abiertas.forEach((n) => { previos = previos.concat((n.data && n.data.items) || []); });
    } catch (err) { /* navegador sin getNotifications */ }
    const items = [nuevo, ...previos].slice(0, 20);
    const varios = items.length > 1;
    await self.registration.showNotification(varios ? `${items.length} novedades en OrganizaSion` : nuevo.title, {
      body: varios ? items.slice(0, 4).map((x) => `• ${x.title}`).join('\n') + (items.length > 4 ? `\n…y ${items.length - 4} más` : '') : nuevo.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'organizasion',
      renotify: true,
      // 27: "Hecho" directo desde la notificación (solo cuando es un aviso suelto).
      ...(!varios && nuevo.acciones ? { actions: nuevo.acciones.slice(0, 2).map((a) => ({ action: a.action, title: a.title })) } : {}),
      data: { url: varios ? '/' : nuevo.url, items: items.map((x) => ({ title: x.title, body: x.body, url: x.url })), acciones: !varios ? nuevo.acciones : null },
    });
  })());
});

// Al tocar la notificación: si ya hay una pestaña de la app abierta, la
// enfoca (y la navega a la URL del aviso); si no, abre una nueva.
self.addEventListener('notificationclick', (event) => {
  const acc = event.action && event.notification.data && Array.isArray(event.notification.data.acciones)
    ? event.notification.data.acciones.find((a) => a.action === event.action) : null;
  if (acc) {
    event.notification.close();
    event.waitUntil(fetch('/api/push-accion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: acc.t }) })
      .then((r) => self.registration.showNotification(r.ok ? 'Listo, quedó marcado como hecho' : 'No se pudo marcar (quizás ya estaba hecho)', { icon: '/icon-192.png', badge: '/icon-192.png', tag: 'organizasion-ok' }))
      .then(() => setTimeout(() => self.registration.getNotifications({ tag: 'organizasion-ok' }).then((l) => l.forEach((n) => n.close())), 4000))
      .catch(() => {}));
    return;
  }
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(targetUrl);
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
