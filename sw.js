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
  let data = { title: 'Net Positive', body: 'Workout update!' };
  try {
    data = event.data.json();
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      vibrate: [200, 100, 200],
      data: { url: data.url || '/' },
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
