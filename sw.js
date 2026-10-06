const CACHE_NAME = "checklist-furnace-v2";
const APP_SCOPE = "/Checklist-record/";
const PRECACHE = [
  APP_SCOPE,
  APP_SCOPE + "index.html",
  APP_SCOPE + "manifest.json",
  APP_SCOPE + "pwa.js",
  APP_SCOPE + "sw.js",
  APP_SCOPE + "icons/icon-192.png",
  APP_SCOPE + "icons/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  if(event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).then(response => {
      if(response && response.ok){
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match(event.request).then(cached => cached || caches.match(APP_SCOPE)))
  );
});

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) { data = {body: event.data ? event.data.text() : "Notifikasi baru"}; }
  const title = data.title || "Checklist Furnace";
  const options = {
    body: data.body || "Ada notifikasi baru.",
    icon: data.icon || APP_SCOPE + "icons/icon-192.png",
    badge: data.badge || APP_SCOPE + "icons/icon-192.png",
    tag: data.tag || "checklist-furnace",
    data: {url: data.url || APP_SCOPE}
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || APP_SCOPE;
  event.waitUntil(clients.matchAll({type:"window", includeUncontrolled:true}).then(list => {
    for(const client of list){
      if("focus" in client){
        client.navigate(url);
        return client.focus();
      }
    }
    return clients.openWindow(url);
  }));
});
