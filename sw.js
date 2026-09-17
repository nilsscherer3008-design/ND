// Offline-Unterstützung für das Nachrichten-Heft
const VERSION = "heft-v3";
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
  if (url.hostname.includes("fonts.googleapis.com") || url.hostname.includes("fonts.gstatic.com")) return e.respondWith(speicherZuerst(req));
  if (url.origin === self.location.origin) return e.respondWith(speicherUndAktualisieren(req));
});
