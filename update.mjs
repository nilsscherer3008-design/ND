// Nachrichten-Heft · neutral – Aktualisierung
// Läuft in GitHub Actions. Liest Nachrichten-Feeds, findet Themen mit mehreren Quellen,
// lässt sie von einer KI (Gemini oder Claude) neutral zusammenfassen und schreibt data/news.json.
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

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

let geminiIndex = 0;
const geminiModelle = () => [].concat(CFG.modelle.gemini);
function naechstesGeminiModell() {
  const liste = geminiModelle();
  if (liste.length < 2) return false;
  geminiIndex = (geminiIndex + 1) % liste.length;
  console.warn(`Wechsle zu Modell: ${liste[geminiIndex]}`);
  return true;
}

async function geminiAnfrage(system, user, maxTokens) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY fehlt (GitHub Secret anlegen).");
  const modell = geminiModelle()[geminiIndex];
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
  const gemini = CFG.anbieter !== "anthropic";
  const anfrage = gemini ? geminiAnfrage : anthropicAnfrage;
  const maxVersuche = 8;
  for (let versuch = 1; versuch <= maxVersuche; versuch++) {
    const pause = (CFG.pauseZwischenKiAnfragenSekunden || 0) * 1000 - (Date.now() - letzteAnfrage);
    if (pause > 0) await warte(pause);
    letzteAnfrage = Date.now();
    let antwort;
    try { antwort = await anfrage(system, user, maxTokens); }
    catch (e) { if (/fehlt/.test(e.message)) throw e; antwort = { fehler: 0, text: e.message }; }
    if (!antwort.fehler) {
      try { return jsonAusText(antwort.text); }
      catch { console.warn("Antwort war kein gültiges JSON, neuer Versuch …"); }
    } else {
      const kurz = antwort.text.replace(/\s+/g, " ").slice(0, 160);
      console.warn(`KI-Fehler ${antwort.fehler} (Versuch ${versuch}/${maxVersuche}): ${kurz}`);
      if ([400, 401, 403].includes(antwort.fehler)) throw new Error("Schlüssel oder Anfrage ungültig (siehe Meldung oben).");
      if (antwort.fehler === 404) {
        if (gemini && naechstesGeminiModell()) continue;
        throw new Error("Modellname nicht gefunden (siehe Meldung oben).");
      }
      if ([429, 500, 503, 529].includes(antwort.fehler)) {
        if (gemini) naechstesGeminiModell();
        const sek = Math.min(20 * versuch, 90);
        console.warn(`Dienst überlastet oder Limit erreicht – warte ${sek} Sekunden …`);
        await warte(sek * 1000);
        continue;
      }
    }
    await warte(5000 * versuch);
  }
  throw new Error("Die KI war dauerhaft nicht erreichbar. Beim nächsten geplanten Lauf wird es automatisch erneut versucht.");
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
- Wähle die wichtigsten Themen, höchstens ${CFG.maxNeueThemenProLauf + bestehende.length}. Neue Themen, die noch nicht in der App sind, haben Vorrang. Achte auf eine Mischung der Rubriken (auch Wirtschaft, Wissen & Klima und Sport), wenn es dort Themen mit mindestens 2 Medien gibt. Rubrik aus: ${CFG.rubriken.join(", ")}.
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

// ---------- Zweiter Prüfdurchgang + Lernbereich ----------
async function themaPruefen(entwurf, quellenTexte) {
  const docs = quellenTexte.map(q => `### Quelle: ${q.name}\n${(q.text || q.teaser).slice(0, 4000)}`).join("\n\n");
  const nachricht = { titel: entwurf.titel, vorspann: entwurf.vorspann, zusammenfassung: entwurf.zusammenfassung,
    einig: entwurf.einig, unklar: entwurf.unklar, positionen: entwurf.positionen, fehlend: entwurf.fehlend,
    medien: entwurf.medien.map(m => ({ name: m.name, fokus: m.fokus, text: m.text })), unterschiede: entwurf.unterschiede };
  return ki(REGELN, `Du bist die PRÜFREDAKTION. Hier sind die Originalberichte:
${docs}

Hier ist der Entwurf einer Nachricht (JSON):
${JSON.stringify(nachricht)}

Aufgabe 1 – Prüfen und korrigieren:
- Prüfe JEDEN Satz gegen die Originalberichte. Was dort nicht steht, wird entfernt oder korrigiert.
- Jeder Punkt in "einig" muss in ALLEN dort genannten Quellen stehen, und es müssen mindestens 2 sein. Sonst Quelle streichen oder Punkt nach "unklar" verschieben.
- Zahlen, Namen, Daten und Orte genau mit den Quellen vergleichen.
- Aussagen von Beteiligten müssen als Aussage gekennzeichnet sein.
- Wertende oder zuspitzende Wörter durch neutrale ersetzen (außer in gekennzeichneten Zitaten).
- Beschreibe jede Änderung in "korrekturen" in einem kurzen Satz. Keine Änderung nötig: leere Liste.

Aufgabe 2 – Lernmaterial für Schülerinnen und Schüler (nur aus Inhalten der geprüften Nachricht):
- "begriffe": 3–4 schwierige Begriffe aus der Nachricht, je 1–2 einfache Sätze Erklärung, ohne Wertung.
- "fragen": 2–3 offene Diskussionsfragen, die keine Meinung vorgeben (z. B. zu Quellen, Wortwahl, Folgen).
- "quiz": 3 Fragen mit je 3 Antworten; genau eine richtig; die richtige Antwort muss unter "einig" belegt sein.

Antworte NUR mit JSON: {"nachricht": {gleiches Format wie der Entwurf}, "korrekturen": ["..."], "lernen": {"begriffe": [["Begriff","Erklärung"]], "fragen": ["..."], "quiz": [{"frage":"...","optionen":["...","...","..."],"richtig":0,"erklaerung":"..."}]}}`, 7000);
}

export function lernenPruefen(l) {
  if (!l || typeof l !== "object") return undefined;
  const begriffe = (l.begriffe || []).filter(b => Array.isArray(b) && b[0] && b[1]).map(b => [String(b[0]), String(b[1])]).slice(0, 5);
  const fragen = (l.fragen || []).map(String).filter(Boolean).slice(0, 4);
  const quiz = (l.quiz || []).filter(q => q && q.frage && Array.isArray(q.optionen) && q.optionen.length >= 2 && q.optionen.length <= 4
    && Number.isInteger(q.richtig) && q.richtig >= 0 && q.richtig < q.optionen.length)
    .map(q => ({ frage: String(q.frage), optionen: q.optionen.map(String), richtig: q.richtig, erklaerung: String(q.erklaerung || "") })).slice(0, 5);
  return (begriffe.length || fragen.length || quiz.length) ? { begriffe, fragen, quiz } : undefined;
}

export function wertendeWoerterFinden(n, liste = []) {
  const texte = [n.titel, n.vorspann, ...(n.zusammenfassung || []), ...(n.einig || []).map(e => e[0]), ...(n.unklar || [])]
    .join(" ").replace(/„[^“]*“|"[^"]*"|»[^«]*«/g, " ");
  const gefunden = new Set();
  for (const w of liste) {
    const re = new RegExp(`(?<!\\p{L})${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\p{L}*`, "iu");
    const m = re.exec(texte);
    if (m) gefunden.add(m[0]);
  }
  return [...gefunden];
}

// ---------- Archiv ----------
const berlinMonat = iso => {
  const t = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit" }).formatToParts(new Date(iso));
  return `${t.find(x => x.type === "year").value}-${t.find(x => x.type === "month").value}`;
};
const leseJson = async (url, standard) => { try { return JSON.parse(await fs.readFile(url, "utf8")); } catch { return standard; } };

export async function archivieren(alteNachrichten, aktive, jetzt, cfg, root = ROOT) {
  const archivOrdner = new URL("data/archiv/", root);
  await fs.mkdir(archivOrdner, { recursive: true });
  const nachMonat = new Map();
  for (const n of alteNachrichten) {
    const m = berlinMonat(n.zeit);
    if (!nachMonat.has(m)) nachMonat.set(m, []);
    nachMonat.get(m).push(n);
  }
  for (const [monat, liste] of nachMonat) {
    const datei = new URL(`${monat}.json`, archivOrdner);
    const vorhanden = await leseJson(datei, []);
    const karte = new Map(vorhanden.map(n => [n.id, n]));
    liste.forEach(n => karte.set(n.id, n));
    await fs.writeFile(datei, JSON.stringify([...karte.values()].sort((a, b) => b.zeit.localeCompare(a.zeit))));
  }
  const sucheDatei = new URL("data/suche.json", root);
  const suche = await leseJson(sucheDatei, []);
  const idx = new Map(suche.map(e => [e.id, e]));
  for (const n of alteNachrichten) idx.set(n.id, { id: n.id, titel: n.titel, vorspann: n.vorspann, rubrik: n.rubrik, zeit: n.zeit, monat: berlinMonat(n.zeit) });
  for (const n of aktive) idx.delete(n.id); // aktive Nachrichten stehen in news.json
  const grenze = jetzt - (cfg.archivMonate || 13) * 30 * 864e5;
  const neu = [...idx.values()].filter(e => new Date(e.zeit) >= grenze).sort((a, b) => b.zeit.localeCompare(a.zeit));
  await fs.writeFile(sucheDatei, JSON.stringify(neu));
  return neu.length;
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
  const sortiert = [...nachrichten].sort((a, b) => b.zeit.localeCompare(a.zeit));
  const aktiv = sortiert.filter(n => new Date(n.zeit) >= grenze).slice(0, cfg.maxNachrichten);
  const ids = new Set(aktiv.map(n => n.id));
  return { aktiv, alt: sortiert.filter(n => !ids.has(n.id)) };
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
    const feeds = [].concat(q.feeds || q.feed || []);
    const gesehen = new Map();
    let ok = 0;
    for (const f of feeds) {
      try {
        for (const i of parseFeed(await holen(f))) {
          if (i.datum && !isNaN(i.datum) && jetzt - i.datum > 30 * 36e5) continue;
          const key = i.link.split("?")[0];
          if (!gesehen.has(key)) gesehen.set(key, i);
        }
        ok++;
      } catch (e) { console.warn(`  ✗ ${q.name} (${f}): ${e.message}`); }
    }
    const frisch = [...gesehen.values()]
      .sort((a, b) => (b.datum && !isNaN(b.datum) ? +b.datum : 0) - (a.datum && !isNaN(a.datum) ? +a.datum : 0))
      .slice(0, CFG.maxMeldungenProQuelle || 25);
    frisch.forEach(i => artikel.push({ ...i, quelle: q.name, q }));
    console.log(`${ok ? "✓" : "✗"} ${q.name}: ${frisch.length} Meldungen aus ${ok}/${feeds.length} Feeds`);
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
      let entwurf = pruefen(await themaSchreiben(t, quellenTexte, altesThema), quellenTexte);
      if (!entwurf.titel || entwurf.einig.length === 0) { console.warn(`Übersprungen (keine belegten Fakten): ${t.id}`); continue; }
      let geprueft = false, korrekturen = [], lernen;
      try {
        const pr = await themaPruefen(entwurf, quellenTexte);
        const korrigiert = pruefen({ ...pr.nachricht, eil: entwurf.eil }, quellenTexte);
        if (korrigiert.titel && korrigiert.einig.length > 0) {
          entwurf = korrigiert; geprueft = true;
          korrekturen = (pr.korrekturen || []).map(String).slice(0, 12);
          lernen = lernenPruefen(pr.lernen);
          console.log(`  Prüfung: ${korrekturen.length} Korrektur(en)`);
        } else console.warn("  Prüfung lieferte keine gültige Fassung – Entwurf bleibt, als ungeprüft markiert.");
      } catch (e) { console.warn(`  Prüfung fehlgeschlagen: ${e.message}`); }
      const wortwarnung = wertendeWoerterFinden(entwurf, CFG.wertendeWoerter);
      if (wortwarnung.length) console.warn(`  Wertende Wörter gefunden: ${wortwarnung.join(", ")}`);
      const neuesteZeit = quellenTexte.map(q => q.datum).filter(d => d !== "unbekannt").sort().pop() || jetzt.toISOString();
      ergebnis.set(t.id, {
        id: t.id, rubrik: CFG.rubriken.includes(t.rubrik) ? t.rubrik : "Welt",
        zeit: neuesteZeit,
        aktualisiert: altesThema ? `aktualisiert um ${berlinUhr(jetzt)} Uhr` : undefined,
        ...entwurf,
        geprueft, korrekturen, wortwarnung, lernen
      });
      neuGeschrieben++;
      console.log(`${altesThema ? "↻" : "+"} ${entwurf.titel} (${quellenTexte.length} Quellen)`);
    } catch (e) { console.warn(`Fehler bei ${t.id}: ${e.message}`); }
  }

  const { aktiv: nachrichten, alt: altListe } = aufraeumen([...ergebnis.values()], jetzt, CFG);
  const imArchiv = await archivieren(altListe, nachrichten, jetzt, CFG);
  if (altListe.length) console.log(`Archiviert: ${altListe.length} (Archiv gesamt: ${imArchiv})`);

  // 4. Eilmeldungen pushen (nur neue, höchstens 6 Stunden alt)
  const notified = new Set(alt.notified || []);
  for (const n of nachrichten.filter(n => n.eil && !notified.has(n.id) && jetzt - new Date(n.zeit) < 6 * 36e5)) {
    try { await pushSenden(n); } catch (e) { console.warn("Push-Fehler: " + e.message); }
    notified.add(n.id);
  }

  await fs.writeFile(DATA_FILE, JSON.stringify({
    stand: jetzt.toISOString(),
    ntfyTopic: process.env.NTFY_TOPIC || "",
    fehlerTopic: process.env.NTFY_TOPIC ? process.env.NTFY_TOPIC + "-fehler" : "",
    notified: [...notified].filter(id => nachrichten.some(n => n.id === id)),
    nachrichten
  }, null, 1));
  console.log(`Fertig: ${nachrichten.length} Nachrichten, ${neuGeschrieben} neu/aktualisiert.`);
  try { execSync("git add data", { cwd: new URL(".", ROOT).pathname, stdio: "ignore" }); } catch { /* lokal ohne git */ }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error("Abbruch: " + e.message); process.exit(1); });
}
