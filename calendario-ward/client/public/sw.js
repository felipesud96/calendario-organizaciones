// Service worker de OrganizaSion — Punto 39 (notificaciones push del
// navegador). Solo maneja los dos eventos que hacen falta para el push (no
// es un service worker "offline-first": no intercepta fetch ni cachea nada,
// eso queda fuera del alcance de este punto).
//
// El registro (navigator.serviceWorker.register('/sw.js')) lo hace
// registerServiceWorker() en app.js, apenas arranca la app — hace falta
// tener el service worker activo ANTES de poder suscribirse con
// pushManager.subscribe().

self.addEventListener('install', () => {
  // activa esta versión de inmediato, sin esperar a que se cierren las
  // demás pestañas abiertas — no hay nada que migrar entre versiones acá.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'OrganizaSion', body: '', url: '/' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (err) {
    // el payload no era JSON válido — se muestra igual con el texto por defecto
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'OrganizaSion', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' },
    })
  );
});

// Al tocar la notificación: si ya hay una pestaña de la app abierta, la
// enfoca (y la navega a la URL del aviso); si no, abre una nueva.
self.addEventListener('notificationclick', (event) => {
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
