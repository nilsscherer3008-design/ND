// Offline-Unterstützung für das Nachrichten-Heft
const VERSION = "heft-v9";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const ohneQuery = url => { const u = new URL(url); return u.origin + u.pathname; };

// Nachrichten-Daten: immer zuerst frisch aus dem Netz, sonst gespeicherte Fassung
async function netzZuerst(req) {
  const cache = await caches.open(VERSION);
  const key = ohneQuery(req.url);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch {
    const alt = await cache.match(key);
    if (!alt) return Response.error();
    const h = new Headers(alt.headers); h.set("x-aus-cache", "1");
    return new Response(await alt.blob(), { status: 200, headers: h });
  }
}

// Schriften: einmal laden, dann aus dem Speicher
async function speicherZuerst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}

// App-Dateien: sofort aus dem Speicher, im Hintergrund aktualisieren
async function speicherUndAktualisieren(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req, { ignoreSearch: true });
  const netz = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || netz;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname.endsWith(".json")) return e.respondWith(netzZuerst(req));
  // Tonaufnahmen tragen den Inhalt im Namen und ändern sich nie: einmal laden, dann aus dem Speicher
  if (url.pathname.endsWith(".mp3")) return e.respondWith(speicherZuerst(req));
  if (url.hostname.includes("fonts.googleapis.com") || url.hostname.includes("fonts.gstatic.com") || url.hostname.endsWith("wikimedia.org")) return e.respondWith(speicherZuerst(req));
  if (url.origin === self.location.origin) return e.respondWith(speicherUndAktualisieren(req));
});

// ---------- Handy-Mitteilungen ----------
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { titel: "Neue Nachricht", text: e.data ? e.data.text() : "" }; }
  const titel = d.titel || "Nachrichten-Heft";
  e.waitUntil(self.registration.showNotification(titel, {
    body: d.text || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: d.id || "heft",
    renotify: !!d.eil,
    requireInteraction: !!d.eil,
    data: { url: d.url || "./" }
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const ziel = e.notification.data?.url || "./";
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(liste => {
    for (const c of liste) if ("focus" in c) { c.navigate(ziel); return c.focus(); }
    return clients.openWindow(ziel);
  }));
});
