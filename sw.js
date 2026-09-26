// Offline-Unterstützung für das Nachrichten-Heft
const VERSION = "heft-v13";
const SHELL = ["./", "./index.html", "./manifest.webmanifest",
  "./manifest-wissen.webmanifest", "./manifest-wetter.webmanifest", "./manifest-podcast.webmanifest",
  "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

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

// App-Dateien: erst das Netz fragen, der Speicher ist nur fürs Offline-Sein.
//
// Vorher kam hier zuerst die gespeicherte Fassung und erst im Hintergrund die
// neue. Das hieß: Änderungen wurden frühestens beim übernächsten Öffnen sichtbar
// - und an den Manifesten nie, weil die schon beim Einrichten abgelegt werden
// und erst bei einer neuen Speicher-Nummer wieder geholt wurden. Tagelang lief
// so die alte App weiter, obwohl auf dem Server längst die neue lag.
async function netzDannSpeicher(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res && res.ok) { cache.put(req, res.clone()); return res; }
    const alt = await cache.match(req, { ignoreSearch: true });
    return alt || res;
  } catch {
    const alt = await cache.match(req, { ignoreSearch: true });
    return alt || Response.error();
  }
}

// Die Seite selbst kommt zuerst aus dem Netz. Sonst bekommt man tagelang die
// gespeicherte alte Fassung zu sehen, auch wenn längst eine neue da ist -
// und Adressen wie ?app=wetter werden von der alten gar nicht verstanden.
async function seiteHolen(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res && res.ok) { cache.put("./index.html", res.clone()); return res; }
  } catch { /* offline */ }
  return (await cache.match(req, { ignoreSearch: true }))
      || (await cache.match("./index.html"))
      || Response.error();
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (req.mode === "navigate") return e.respondWith(seiteHolen(req));
  if (url.pathname.endsWith(".json")) return e.respondWith(netzZuerst(req));
  // Tonaufnahmen tragen den Inhalt im Namen und ändern sich nie: einmal laden, dann aus dem Speicher
  if (url.pathname.endsWith(".mp3")) return e.respondWith(speicherZuerst(req));
  if (url.hostname.includes("fonts.googleapis.com") || url.hostname.includes("fonts.gstatic.com") || url.hostname.endsWith("wikimedia.org")) return e.respondWith(speicherZuerst(req));
  if (url.origin === self.location.origin) return e.respondWith(netzDannSpeicher(req));
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
