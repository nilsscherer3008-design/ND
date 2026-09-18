// Cloudflare Worker: speichert die Anmeldungen für Handy-Mitteilungen.
// Er verschickt nichts – das macht GitHub Actions. Er ist nur der Briefkasten.
export default {
  async fetch(anfrage, umgebung) {
    const url = new URL(anfrage.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type,authorization",
      "Access-Control-Allow-Methods": "POST,GET,OPTIONS"
    };
    if (anfrage.method === "OPTIONS") return new Response(null, { headers: cors });

    // 1. Anmelden (aus der App)
    if (url.pathname === "/abo" && anfrage.method === "POST") {
      const daten = await anfrage.json().catch(() => null);
      if (!daten?.abo?.endpoint) return new Response("ungültig", { status: 400, headers: cors });
      const id = await hash(daten.abo.endpoint);
      await umgebung.ABOS.put(id, JSON.stringify({ abo: daten.abo, rubriken: daten.rubriken || [], zeit: Date.now() }));
      return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, "content-type": "application/json" } });
    }

    // 2. Abmelden (aus der App)
    if (url.pathname === "/abmelden" && anfrage.method === "POST") {
      const daten = await anfrage.json().catch(() => null);
      if (daten?.endpoint) await umgebung.ABOS.delete(await hash(daten.endpoint));
      return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, "content-type": "application/json" } });
    }

    // 3. Liste holen (nur GitHub Actions, mit Geheimwort)
    if (url.pathname === "/liste" && anfrage.headers.get("authorization") === `Bearer ${umgebung.TOKEN}`) {
      const liste = await umgebung.ABOS.list({ limit: 1000 });
      const abos = [];
      for (const k of liste.keys) {
        const w = await umgebung.ABOS.get(k.name);
        if (w) abos.push({ id: k.name, ...JSON.parse(w) });
      }
      return new Response(JSON.stringify(abos), { headers: { "content-type": "application/json" } });
    }

    // 4. Kaputte Anmeldungen löschen (nur GitHub Actions)
    if (url.pathname === "/loeschen" && anfrage.method === "POST" && anfrage.headers.get("authorization") === `Bearer ${umgebung.TOKEN}`) {
      const { ids } = await anfrage.json().catch(() => ({ ids: [] }));
      for (const id of ids || []) await umgebung.ABOS.delete(id);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }

    return new Response("Nachrichten-Heft Push-Briefkasten", { status: 200, headers: cors });
  }
};

async function hash(text) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
