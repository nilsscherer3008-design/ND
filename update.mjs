// Nachrichten-Heft · neutral – Aktualisierung
// Läuft in GitHub Actions. Liest Nachrichten-Feeds, findet Themen mit mehreren Quellen,
// lässt sie von einer KI (Gemini oder Claude) neutral zusammenfassen und schreibt data/news.json.
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ROOT = new URL("./", import.meta.url);
const DATA_FILE = new URL("data/news.json", ROOT);
const UA = "Mozilla/5.0 (compatible; NachrichtenHeft/1.0; Schulprojekt)";

// ---------- Hilfsfunktionen ----------
export function decode(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, " ").trim();
}

export function parseFeed(xml) {
  const items = [];
  for (const m of xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
    const b = m[0];
    const raw = t => { const r = new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`, "i").exec(b); return r ? r[1] : ""; };
    let link = decode(raw("link"));
    if (!link) { const l = /<link[^>]*href="([^"]+)"/i.exec(b); link = l ? l[1] : ""; }
    if (!link) link = decode(raw("guid"));
    const datum = decode(raw("pubDate") || raw("dc:date") || raw("updated") || raw("published"));
    items.push({
      titel: decode(raw("title")),
      teaser: decode(raw("description") || raw("summary") || raw("content:encoded")).slice(0, 400),
      link,
      datum: datum ? new Date(datum) : null
    });
  }
  return items.filter(i => i.titel && /^https?:\/\//.test(i.link));
}

export function berlinStunde(d = new Date()) {
  return +new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "numeric", hourCycle: "h23" }).format(d);
}
const berlinUhr = (d = new Date()) =>
  new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }).format(d);

export function sollLaufen({ jetzt = new Date(), letzterStand, cfg, force }) {
  if (force) return true;
  const h = berlinStunde(jetzt);
  if (h < cfg.zeitfenster.vonUhr || h > cfg.zeitfenster.bisUhr) return false;
  if (!letzterStand) return true;
  return (jetzt - new Date(letzterStand)) / 36e5 >= cfg.zeitfenster.mindestAbstandStunden;
}

async function holen(url, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal, redirect: "follow" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

export function artikelText(html) {
  const ohne = html.replace(/<(script|style|nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  const absaetze = [...ohne.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(m => decode(m[1])).filter(t => t.length > 60);
  return absaetze.join("\n").slice(0, 6000);
}

export const istVideo = url => /\/video|\/videos\/|mediathek|\/av\//i.test(url);

// ---------- KI-Anbieter (Gemini kostenlos oder Claude) ----------
const warte = ms => new Promise(res => setTimeout(res, ms));
function jsonAusText(text) {
  const t = text.replace(/```json|```/g, "").trim();
  return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
}

async function geminiAnfrage(system, user, maxTokens) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY fehlt (GitHub Secret anlegen).");
  const modell = CFG.modelle.gemini;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modell}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: maxTokens * 2, temperature: 0.2 }
    })
  });
  if (!r.ok) return { fehler: r.status, text: await r.text() };
  const data = await r.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  return { text };
}

async function anthropicAnfrage(system, user, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY fehlt (GitHub Secret anlegen).");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: CFG.modelle.anthropic, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] })
  });
  if (!r.ok) return { fehler: r.status, text: await r.text() };
  const data = await r.json();
  return { text: data.content.map(c => c.text || "").join("") };
}

let letzteAnfrage = 0;
async function ki(system, user, maxTokens = 4000) {
  const anfrage = CFG.anbieter === "anthropic" ? anthropicAnfrage : geminiAnfrage;
  for (let versuch = 1; versuch <= 4; versuch++) {
    const pause = (CFG.pauseZwischenKiAnfragenSekunden || 0) * 1000 - (Date.now() - letzteAnfrage);
    if (pause > 0) await warte(pause);
    letzteAnfrage = Date.now();
    const antwort = await anfrage(system, user, maxTokens);
    if (!antwort.fehler) {
      try { return jsonAusText(antwort.text); }
      catch { console.warn("Antwort war kein gültiges JSON, neuer Versuch …"); }
    } else {
      console.warn(`KI-Fehler ${antwort.fehler}: ${antwort.text.slice(0, 300)}`);
      if ([400, 401, 403, 404].includes(antwort.fehler)) throw new Error("Schlüssel, Modellname oder Anfrage ungültig (siehe Meldung oben).");
      if (antwort.fehler === 429) { console.warn("Kostenloses Limit erreicht – warte 60 Sekunden …"); await warte(60000); continue; }
    }
    await warte(5000 * versuch);
  }
  throw new Error("Die KI hat nach 4 Versuchen nicht geantwortet.");
}

const REGELN = `Du schreibst für eine neutrale Nachrichten-App für den Gemeinschaftskunde-Unterricht (Schülerinnen und Schüler).
Regeln:
- Neutral: keine Meinung, keine wertenden Wörter (z. B. „krachend“, „skandalös“, „dramatisch“).
- Nutze NUR die mitgelieferten Berichte. Erfinde nichts. Kein Wissen von außerhalb, außer ganz allgemeinen Erklärungen (z. B. was eine Institution ist).
- Unter "einig" nur Fakten, die mindestens ZWEI der mitgelieferten Quellen enthalten; nenne die Quellen exakt mit ihrem Namen.
- Aussagen von Politikern, Regierungen, Behörden, Parteien, Kriegsparteien immer als Aussage kennzeichnen („laut …“, „nach Angaben von …“).
- Bei Konflikten alle Seiten, die in den Berichten vorkommen, gleichberechtigt unter "positionen" nennen.
- Einfache, klare Sprache. Kurze Sätze. Keine direkten Zitate über 10 Wörter.
- Überschrift sachlich, ohne Zuspitzung. Wer etwas behauptet, wird genannt.
- Eilmeldung (eil=true) nur bei wichtigen, überraschenden Ereignissen: Wahlergebnisse, große Unglücke oder Anschläge, Rücktritte von Regierungsmitgliedern, Kriegsereignisse mit großer Tragweite.`;

async function themenFinden(artikel, bestehende) {
  const liste = artikel.map((a, i) => `[${i}] ${a.quelle} | ${a.datum ? a.datum.toISOString().slice(0, 16) : "?"} | ${a.titel} — ${a.teaser.slice(0, 180)}`).join("\n");
  const alt = bestehende.map(n => `${n.id}: ${n.titel}`).join("\n") || "(keine)";
  return ki(REGELN, `Hier sind aktuelle Meldungen verschiedener Medien:
${liste}

Bereits vorhandene Themen in der App (id: Titel):
${alt}

Aufgabe: Gruppiere Meldungen, die über DASSELBE Ereignis berichten.
- Nimm nur Themen, zu denen mindestens 2 VERSCHIEDENE Medien berichten.
- Pro Medium höchstens eine Meldung je Thema (die aussagekräftigste).
- Wenn ein Thema einem vorhandenen entspricht, verwende dessen id. Sonst neue id: kurzer Slug aus Kleinbuchstaben und Bindestrichen.
- Wähle die wichtigsten Themen, höchstens ${CFG.maxNeueThemenProLauf + bestehende.length}. Rubrik aus: ${CFG.rubriken.join(", ")}.
- Keine reinen Service-, Ratgeber-, Kommentar- oder Liveblog-Meldungen.
Antworte NUR mit JSON: {"themen":[{"id":"...","rubrik":"...","eil":false,"artikel":[0,5]}]}`, 2000);
}

async function themaSchreiben(thema, quellenTexte, altesThema) {
  const docs = quellenTexte.map(q => `### Quelle: ${q.name} (${q.typ})\nDatum: ${q.datum}\nTitel: ${q.titel}\nText:\n${q.text || q.teaser}`).join("\n\n");
  const hinweis = altesThema ? `\nEs gibt schon eine Fassung dieses Themas. Überschreibe sie vollständig mit dem neuen Stand:\n${JSON.stringify({ titel: altesThema.titel, vorspann: altesThema.vorspann })}\n` : "";
  const namen = quellenTexte.map(q => q.name).join(", ");
  return ki(REGELN, `${docs}
${hinweis}
Schreibe eine Nachricht zu diesem Thema (Rubrik: ${thema.rubrik}). Verfügbare Quellennamen: ${namen}.
Antworte NUR mit JSON in genau diesem Format:
{
 "titel": "sachliche Überschrift",
 "vorspann": "1–2 Sätze",
 "eil": ${thema.eil ? "true" : "false"},
 "zusammenfassung": ["3 bis 5 kurze Absätze in einfacher Sprache"],
 "einig": [["Fakt", ["Quellenname", "Quellenname"]]],
 "unklar": ["was noch nicht feststeht oder sich widerspricht, mit Angabe wer was sagt"],
 "positionen": [["Wer (Rolle)", "Aussage in eigenen Worten", "Quellenname(n)"]],
 "fehlend": "Welche Stimmen oder Seiten in den Berichten nicht vorkommen",
 "medien": [{"name": "Quellenname", "fokus": "Schwerpunkt in 2–5 Wörtern", "text": "2–3 Sätze: was dieser Bericht betont"}],
 "unterschiede": [["Stichwort (z. B. Ton, Stimmen, Weggelassenes)", "Erklärung"]]
}`, 5000);
}

// ---------- Prüfen & zusammenführen ----------
export function pruefen(entwurf, quellenTexte) {
  const namen = new Set(quellenTexte.map(q => q.name));
  const einig = (entwurf.einig || [])
    .map(([f, q]) => [String(f), [...new Set((q || []).filter(n => namen.has(n)))]])
    .filter(([, q]) => q.length >= 2);
  const medien = quellenTexte.map(q => {
    const m = (entwurf.medien || []).find(x => x.name === q.name) || {};
    return { name: q.name, typ: q.typ, art: q.art, stamm: q.stamm, datum: q.datumText,
      fokus: String(m.fokus || "–"), text: String(m.text || q.teaser), url: q.link, video: istVideo(q.link) };
  });
  const arr = x => Array.isArray(x) ? x.map(String) : [];
  return {
    titel: String(entwurf.titel || "").trim(),
    vorspann: String(entwurf.vorspann || "").trim(),
    eil: !!entwurf.eil,
    zusammenfassung: arr(entwurf.zusammenfassung).slice(0, 6),
    einig,
    unklar: arr(entwurf.unklar),
    positionen: (entwurf.positionen || []).filter(p => Array.isArray(p) && p.length >= 2).map(p => [String(p[0]), String(p[1]), String(p[2] || "")]),
    fehlend: String(entwurf.fehlend || "In den verglichenen Berichten wurden keine fehlenden Stimmen festgestellt."),
    medien,
    unterschiede: (entwurf.unterschiede || []).filter(u => Array.isArray(u) && u.length >= 2).map(u => [String(u[0]), String(u[1])])
  };
}

export function aufraeumen(nachrichten, jetzt, cfg) {
  const grenze = jetzt - cfg.nachrichtenBehaltenStunden * 36e5;
  return nachrichten
    .filter(n => new Date(n.zeit) >= grenze)
    .sort((a, b) => b.zeit.localeCompare(a.zeit))
    .slice(0, cfg.maxNachrichten);
}

async function pushSenden(n) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return console.log("Kein NTFY_TOPIC gesetzt – keine Push-Nachricht.");
  const headers = { "content-type": "application/json" };
  if (process.env.NTFY_TOKEN) headers.authorization = "Bearer " + process.env.NTFY_TOKEN;
  const seite = process.env.SITE_URL ? `${process.env.SITE_URL.replace(/\/$/, "")}/#/n/${n.id}` : undefined;
  const r = await fetch(CFG.ntfyServer, {
    method: "POST", headers,
    body: JSON.stringify({ topic, title: "EILMELDUNG: " + n.titel, message: n.vorspann, priority: 5, tags: ["rotating_light"], click: seite })
  });
  console.log(r.ok ? `Push gesendet: ${n.titel}` : `Push fehlgeschlagen (${r.status})`);
}

// ---------- Hauptprogramm ----------
let CFG;
async function main() {
  CFG = JSON.parse(await fs.readFile(new URL("config.json", ROOT), "utf8"));
  const alt = JSON.parse(await fs.readFile(DATA_FILE, "utf8").catch(() => '{"nachrichten":[],"notified":[]}'));
  const jetzt = new Date();

  if (!sollLaufen({ jetzt, letzterStand: alt.stand, cfg: CFG, force: !!process.env.FORCE })) {
    console.log(`Kein Lauf nötig (Berlin ${berlinUhr(jetzt)} Uhr).`);
    return;
  }

  // 1. Feeds lesen
  const artikel = [];
  for (const q of CFG.quellen) {
    try {
      const items = parseFeed(await holen(q.feed));
      const frisch = items.filter(i => !i.datum || isNaN(i.datum) || jetzt - i.datum < 30 * 36e5).slice(0, 25);
      frisch.forEach(i => artikel.push({ ...i, quelle: q.name, q }));
      console.log(`✓ ${q.name}: ${frisch.length} Meldungen`);
    } catch (e) { console.warn(`✗ ${q.name}: ${e.message}`); }
  }
  if (new Set(artikel.map(a => a.quelle)).size < 2) throw new Error("Zu wenige Quellen erreichbar.");

  // 2. Themen finden
  const bestehende = alt.nachrichten || [];
  const { themen = [] } = await themenFinden(artikel, bestehende);
  const ergebnis = new Map(bestehende.map(n => [n.id, n]));
  let neuGeschrieben = 0;

  for (const t of themen) {
    const auswahl = [];
    for (const i of t.artikel || []) {
      const a = artikel[i];
      if (a && !auswahl.some(x => x.quelle === a.quelle)) auswahl.push(a);
    }
    auswahl.splice(CFG.maxArtikelProThema);
    if (auswahl.length < 2) continue;
    const altesThema = ergebnis.get(t.id);
    const alteLinks = new Set((altesThema?.medien || []).map(m => m.url));
    if (altesThema && auswahl.every(a => alteLinks.has(a.link))) continue; // nichts Neues
    if (!altesThema && neuGeschrieben >= CFG.maxNeueThemenProLauf) continue;

    // 3. Artikeltexte holen
    const quellenTexte = [];
    for (const a of auswahl) {
      let text = "";
      try { text = artikelText(await holen(a.link)); } catch { /* dann nur Teaser */ }
      quellenTexte.push({ name: a.q.name, typ: a.q.typ, art: a.q.art, stamm: a.q.stamm, link: a.link, titel: a.titel, teaser: a.teaser, text,
        datum: a.datum && !isNaN(a.datum) ? a.datum.toISOString() : "unbekannt",
        datumText: a.datum && !isNaN(a.datum) ? new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" }).format(a.datum) : "" });
    }

    try {
      const entwurf = pruefen(await themaSchreiben(t, quellenTexte, altesThema), quellenTexte);
      if (!entwurf.titel || entwurf.einig.length === 0) { console.warn(`Übersprungen (keine belegten Fakten): ${t.id}`); continue; }
      const neuesteZeit = quellenTexte.map(q => q.datum).filter(d => d !== "unbekannt").sort().pop() || jetzt.toISOString();
      ergebnis.set(t.id, {
        id: t.id, rubrik: CFG.rubriken.includes(t.rubrik) ? t.rubrik : "Welt",
        zeit: neuesteZeit,
        aktualisiert: altesThema ? `aktualisiert um ${berlinUhr(jetzt)} Uhr` : undefined,
        ...entwurf
      });
      neuGeschrieben++;
      console.log(`${altesThema ? "↻" : "+"} ${entwurf.titel} (${quellenTexte.length} Quellen)`);
    } catch (e) { console.warn(`Fehler bei ${t.id}: ${e.message}`); }
  }

  const nachrichten = aufraeumen([...ergebnis.values()], jetzt, CFG);

  // 4. Eilmeldungen pushen (nur neue, höchstens 6 Stunden alt)
  const notified = new Set(alt.notified || []);
  for (const n of nachrichten.filter(n => n.eil && !notified.has(n.id) && jetzt - new Date(n.zeit) < 6 * 36e5)) {
    try { await pushSenden(n); } catch (e) { console.warn("Push-Fehler: " + e.message); }
    notified.add(n.id);
  }

  await fs.writeFile(DATA_FILE, JSON.stringify({
    stand: jetzt.toISOString(),
    ntfyTopic: process.env.NTFY_TOPIC || "",
    notified: [...notified].filter(id => nachrichten.some(n => n.id === id)),
    nachrichten
  }, null, 1));
  console.log(`Fertig: ${nachrichten.length} Nachrichten, ${neuGeschrieben} neu/aktualisiert.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error("Abbruch: " + e.message); process.exit(1); });
}
