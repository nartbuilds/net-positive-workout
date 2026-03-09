// Install: take over immediately, clear any old caches
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', () => self.clients.claim());

// Fetch: always go to network — no caching
self.addEventListener('fetch', (event) => {
  if (!event.request.url.startsWith('http')) return;
  event.respondWith(fetch(event.request));
});

// Push notification handler
self.addEventListener('push', (event) => {
  let raw = {};
  try {
    raw = event.data.json();
  } catch (e) {
    raw = { _text: event.data?.text() };
  }
  console.log('[SW] push raw payload:', JSON.stringify(raw));

  // Handle multiple possible FCM payload structures
  const title = raw.title || raw.notification?.title || raw.data?.title || 'Net +VE';
  const body  = raw.body  || raw.notification?.body  || raw.data?.body  || 'Workout update!';
  const url   = raw.url   || raw.notification?.url   || raw.data?.url   || '/';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-notification.png',
      badge: '/icons/icon-notification.png',
      vibrate: [200, 100, 200],
      data: { url },
      tag: 'workout-update',
      renotify: true,
    })
  );
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
