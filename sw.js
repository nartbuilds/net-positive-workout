const CACHE = "netpve-v93";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.json", "/alan/alan_neutral.png", "/alan/alan_cheer.png", "/alan/alan_heart.png", "/alan/alan_scared.png", "/alan/alan_tired.png"];

// Install: cache app shell, take over immediately
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)),
  );
  self.skipWaiting();
});

// Activate: delete old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      ),
  );
  self.clients.claim();
});

// Fetch: serve shell from cache, pass Firestore/Netlify through to network
self.addEventListener("fetch", (event) => {
  if (!event.request.url.startsWith("http")) return;
  if (
    event.request.url.includes("firestore") ||
    event.request.url.includes("googleapis") ||
    event.request.url.includes("netlify") ||
    event.request.url.includes("gstatic")
  ) {
    return; // network-only for API calls
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});

// Push notification handler
self.addEventListener("push", (event) => {
  let raw = {};
  try {
    raw = event.data.json();
  } catch (e) {
    raw = { _text: event.data?.text() };
  }
  console.log("[SW] push raw payload:", JSON.stringify(raw));

  // Handle multiple possible FCM payload structures
  const title =
    raw.title || raw.notification?.title || raw.data?.title || "Net +VE";
  const body =
    raw.body || raw.notification?.body || raw.data?.body || "Workout update!";
  const url = raw.url || raw.notification?.url || raw.data?.url || "/";
  const tag = raw.tag || raw.data?.tag || `workout-${Date.now()}`;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icons/icon-96.png",
      badge: "/icons/icon-notification.png",
      vibrate: [200, 100, 200],
      tag,
      data: { url },
    }),
  );
});

// Notification click handler
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((list) => {
        for (const client of list) {
          if (client.url === url && "focus" in client) return client.focus();
        }
        if (clients.openWindow) return clients.openWindow(url);
      }),
  );
});
