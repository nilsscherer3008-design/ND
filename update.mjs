// Nachrichten-Heft · neutral – Aktualisierung
// Läuft in GitHub Actions. Liest Nachrichten-Feeds, findet Themen mit mehreren Quellen,
// lässt sie von einer KI (Gemini oder Claude) neutral zusammenfassen und schreibt data/news.json.
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

const ROOT = new URL("./", import.meta.url);
const DATA_FILE = new URL("data/news.json", ROOT);
const UA = "Mozilla/5.0 (compatible; NachrichtenHeft/1.0; Schulprojekt)";
const TEXT_VERSION = 4; // höhere Zahl = ältere Artikel werden nach und nach neu geschrieben

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
  return parseInt(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hourCycle: "h23" }).format(d), 10);
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
  return absaetze.join("\n").slice(0, 10000);
}

export const istVideo = url => /\/video|\/videos\/|mediathek|\/av\//i.test(url);

// ---------- KI-Anbieter (Gemini kostenlos oder Claude) ----------
const warte = ms => new Promise(res => setTimeout(res, ms));
function jsonAusText(text) {
  const t = text.replace(/```json|```/g, "").trim();
  return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
}

let geminiIndex = 0;
export const modellZuruecksetzen = () => { geminiIndex = 0; };
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
  const hinweis = altesThema ? `\nEs gibt schon eine Fassung dieses Themas. Schreibe sie vollständig mit dem neuen Stand neu. Bisheriger Titel: ${JSON.stringify(altesThema.titel)}. Bisherige Zeitleiste: ${JSON.stringify(altesThema.zeitleiste || [])}\n` : "";
  const namen = quellenTexte.map(q => q.name).join(", ");
  return ki(REGELN, `${docs}
${hinweis}
Schreibe einen LANGEN, ausführlichen und streng sachlichen Nachrichtenartikel zu diesem Thema (Rubrik: ${thema.rubrik}) – im nüchternen Stil einer Nachrichtenagentur wie dpa oder Reuters. Verfügbare Quellennamen: ${namen}.
Länge und Inhalt:
- Der Artikel ("artikel") hat insgesamt 900 bis 1400 Wörter und mindestens 12 Absätze. Jeder Absatz besteht aus 4 bis 6 vollständigen Sätzen. Schreibe für Leserinnen und Leser, die alles genau wissen wollen.
- Nutze ALLE Details aus ALLEN Quellen und führe sie zusammen: Zahlen, Namen, Funktionen, Orte, Uhrzeiten, Abläufe, Vorgeschichte, Zitate (sinngemäß), angekündigte Schritte.
- Nennt eine Quelle etwas, das die anderen nicht nennen, schreibe dazu, von wem es stammt („laut ZDFheute …“).
- Widersprechen sich Quellen, nenne beide Angaben.
Stil:
- Sachlich und nüchtern. Keine wertenden, dramatisierenden oder gefühlsbetonten Wörter (z. B. nicht „besorgniserregend“, „bedrohlich“, „dramatisch“, „massiv“, „schockierend“).
- Keine Vermutungen der Redaktion, keine Spekulation, keine rhetorischen Fragen.
- Fachbegriffe beim ersten Vorkommen kurz erklären.
Antworte NUR mit JSON in genau diesem Format:
{
 "titel": "sachliche Überschrift",
 "vorspann": "2 Sätze, die das Wichtigste enthalten",
 "eil": ${thema.eil ? "true" : "false"},
 "wfragen": {"wer": "höchstens 12 Wörter", "was": "höchstens 12 Wörter", "wann": "Datum/Uhrzeit", "wo": "Ort", "wie": "höchstens 15 Wörter", "warum": "höchstens 15 Wörter, mit Angabe wer den Grund nennt – oder 'noch unklar'", "quellenlage": "höchstens 12 Wörter: worauf stützen sich die Berichte (Polizei, Unternehmen, Augenzeugen …)"},
 "artikel": [
   {"ueberschrift": "Das ist passiert", "absaetze": ["2–3 Absätze: das Ereignis mit allen gesicherten Einzelheiten"]},
   {"ueberschrift": "Die Einzelheiten", "absaetze": ["2–3 Absätze: Ablauf, Zahlen, Beteiligte, Orte genauer"]},
   {"ueberschrift": "Hintergrund", "absaetze": ["1–3 Absätze: Vorgeschichte und Zusammenhänge laut den Berichten"]},
   {"ueberschrift": "Zum Verständnis", "absaetze": ["1–2 Absätze: gesichertes, allgemein bekanntes Grundwissen, das man zum Verstehen braucht (z. B. was eine Institution macht, wie ein Verfahren abläuft). KEINE aktuellen Ereignisse, Zahlen oder Bewertungen, die nicht in den Berichten stehen."]},
   {"ueberschrift": "Reaktionen", "absaetze": ["1–3 Absätze, jede Aussage mit Namen und Funktion gekennzeichnet"]},
   {"ueberschrift": "Wie geht es weiter?", "absaetze": ["1–2 Absätze, nur was in den Berichten angekündigt wird"]}
 ],
 "zusammenfassung": ["3 bis 5 kurze Absätze: die Kurzfassung"],
 "zeitleiste": [["Datum oder Wochentag", "Ereignis in einem Satz"]],
 "einig": [["Fakt", ["Quellenname", "Quellenname"]]],
 "unklar": ["was noch nicht feststeht oder sich widerspricht, mit Angabe wer was sagt"],
 "positionen": [["Wer (Rolle)", "Aussage in eigenen Worten", "Quellenname(n)"]],
 "fehlend": "Welche Stimmen oder Seiten in den Berichten nicht vorkommen",
 "medien": [{"name": "Quellenname", "fokus": "Schwerpunkt in 2–5 Wörtern", "text": "2–3 Sätze: was dieser Bericht betont"}],
 "unterschiede": [["Stichwort (z. B. Ton, Stimmen, Weggelassenes)", "Erklärung"]],
 "bilder": [{"art": "person | ort | institution | symbol | keins", "suchbegriff": "genauer Suchbegriff für Wikimedia Commons: Eigenname plus Zusatz, möglichst auf Englisch, z. B. 'Ulf Kristersson politician', 'Riksdag building Stockholm', 'European Central Bank headquarters'. Keine allgemeinen Wörter wie 'Politik' oder 'Nachrichten'.", "bildunterschrift": "1 Satz: was zu sehen ist und was es mit dem Thema zu tun hat"}],
 "ort": {"name": "Ort und Land, wo das Ereignis stattfand – z. B. 'Wuppertal, Deutschland'; sonst 'keiner'"}
}
Regeln für "artikel": Abschnitte nur weglassen, wenn die Berichte dazu wirklich nichts enthalten. Lieber ausführlich als knapp – solange jede Angabe belegt ist.
Regeln für "zeitleiste": nur Schritte, die in den Berichten stehen; bei neuen Ereignissen ohne Vorgeschichte leere Liste.
Regeln für "bilder": 2 bis 4 verschiedene Vorschläge, die das Thema verständlicher machen (z. B. die beteiligte Person, der Ort, das Gebäude der Institution, ein neutrales Symbol). Zeige nie das Ereignis selbst. Bei Unglücken mit Toten oder Verletzten, bei Gewalttaten, bei Opfern oder bei Kindern IMMER nur einen Eintrag mit art "keins".`, 9000);
}

// ---------- Zweiter Prüfdurchgang + Lernbereich ----------
async function themaPruefen(entwurf, quellenTexte) {
  const docs = quellenTexte.map(q => `### Quelle: ${q.name}\n${(q.text || q.teaser).slice(0, 7000)}`).join("\n\n");
  const { medien, geprueft, korrekturen, wortwarnung, lernen, einfach, video, bild, ...rest } = entwurf;
  const nachricht = { ...rest, medien: medien.map(m => ({ name: m.name, fokus: m.fokus, text: m.text })), bild };
  return ki(REGELN, `Du bist die PRÜFREDAKTION. Hier sind die Originalberichte:
${docs}

Hier ist der Entwurf einer Nachricht (JSON):
${JSON.stringify(nachricht)}

Aufgabe 1 – Prüfen und korrigieren:
- Prüfe JEDEN Satz gegen die Originalberichte. Was dort nicht steht, wird entfernt oder korrigiert.
- Jeder Punkt in "einig" muss in ALLEN dort genannten Quellen stehen, und es müssen mindestens 2 sein. Sonst Quelle streichen oder Punkt nach "unklar" verschieben.
- Zahlen, Namen, Daten und Orte genau mit den Quellen vergleichen – auch in "artikel", "wfragen" und "zeitleiste".
- Unbekanntes in "wfragen" als "noch unklar" angeben, nicht raten.
- Aussagen von Beteiligten müssen als Aussage gekennzeichnet sein.
- Wertende, dramatisierende oder gefühlsbetonte Wörter durch neutrale ersetzen (außer in gekennzeichneten Zitaten).
- Im Abschnitt "Zum Verständnis" nur gesichertes Grundwissen stehen lassen; alles Aktuelle, Strittige oder Zahlen ohne Beleg entfernen.
- KÜRZE DEN ARTIKEL NICHT. Ersetze Entferntes möglichst durch belegte Informationen aus den Originalberichten, damit er ausführlich bleibt.
- Beschreibe jede Änderung in "korrekturen" in einem kurzen Satz. Keine Änderung nötig: leere Liste.

Aufgabe 2 – Einfache Fassung und Videotexte (nur aus Inhalten der geprüften Nachricht):
- "einfach": Vorspann und 3–5 kurze Absätze in einfacher Sprache (kurze Sätze, keine Fremdwörter ohne Erklärung) für Jugendliche ab 12.
- "video": Sprechtexte für eine Nachrichtensendung. Jeder Satz höchstens 14 Wörter. Kurze Hauptsätze, Präsens oder Perfekt. Keine Abkürzungen, Zahlen ausgeschrieben, wie man sie spricht (z. B. "drei Komma sieben fünf Prozent"). Setze Kommas dort, wo ein Sprecher Luft holt. Keine Floskeln wie "Guten Abend". Wenn mehrere Medien berichten, darf ein Satz das sachlich erwähnen ("Mehrere Medien berichten übereinstimmend").
  Erzähle in dieser Reihenfolge: 1. ein Einstiegssatz, der neugierig macht, aber nichts übertreibt und nichts wertet. 2. die wichtigsten Fakten. 3. ein Schlusssatz, der sagt, was als Nächstes passiert oder was noch offen ist.
  "kurz": 3 Sätze. "lang": 6–8 Sätze. "einfach": 4–5 sehr einfache Sätze.

Aufgabe 3 – Lernmaterial für Schülerinnen und Schüler:
- "begriffe": 3–4 schwierige Begriffe aus der Nachricht, je 1–2 einfache Sätze Erklärung, ohne Wertung.
- "fragen": 2–3 offene Diskussionsfragen, die keine Meinung vorgeben (z. B. zu Quellen, Wortwahl, Folgen).
- "quiz": 3 Fragen mit je 3 Antworten; genau eine richtig; die richtige Antwort muss unter "einig" belegt sein.

Antworte NUR mit JSON: {"nachricht": {gleiches Format wie der Entwurf}, "korrekturen": ["..."], "einfach": {"vorspann": "...", "absaetze": ["..."]}, "video": {"kurz": ["..."], "lang": ["..."], "einfach": ["..."]}, "lernen": {"begriffe": [["Begriff","Erklärung"]], "fragen": ["..."], "quiz": [{"frage":"...","optionen":["...","...","..."],"richtig":0,"erklaerung":"..."}]}}`, 12000);
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
    unterschiede: (entwurf.unterschiede || []).filter(u => Array.isArray(u) && u.length >= 2).map(u => [String(u[0]), String(u[1])]),
    wfragen: wfragenPruefen(entwurf.wfragen),
    artikel: (entwurf.artikel || []).filter(a => a && a.ueberschrift && Array.isArray(a.absaetze) && a.absaetze.length)
      .map(a => ({ ueberschrift: String(a.ueberschrift), absaetze: a.absaetze.map(String).filter(Boolean) })).slice(0, 6),
    zeitleiste: (entwurf.zeitleiste || []).filter(z => Array.isArray(z) && z[0] && z[1]).map(z => [String(z[0]), String(z[1])]).slice(0, 12),
    bilder: (Array.isArray(entwurf.bilder) ? entwurf.bilder : entwurf.bild ? [entwurf.bild] : [])
      .filter(b => b && typeof b === "object")
      .map(b => ({ art: String(b.art || "keins").trim().toLowerCase(), suchbegriff: String(b.suchbegriff || ""), bildunterschrift: String(b.bildunterschrift || "") }))
      .slice(0, 4),
    ort: entwurf.ort?.name && !/^kein/i.test(entwurf.ort.name) ? { name: String(entwurf.ort.name).slice(0, 80) } : undefined
  };
}

const W_FELDER = ["wer", "was", "wann", "wo", "wie", "warum", "quellenlage"];
export function wfragenPruefen(w) {
  if (!w || typeof w !== "object") return undefined;
  const o = {};
  for (const f of W_FELDER) if (w[f]) o[f] = String(w[f]).trim();
  return Object.keys(o).length >= 4 ? o : undefined;
}
export function einfachPruefen(e) {
  if (!e || !Array.isArray(e.absaetze) || !e.absaetze.length) return undefined;
  return { vorspann: String(e.vorspann || ""), absaetze: e.absaetze.map(String).filter(Boolean).slice(0, 6) };
}
export function videoPruefen(v) {
  if (!v || typeof v !== "object") return undefined;
  const sätze = x => (Array.isArray(x) ? x : [x]).map(t => String(t || "").trim()).filter(Boolean).slice(0, 5);
  const o = { kurz: sätze(v.kurz), lang: sätze(v.lang), einfach: sätze(v.einfach) };
  return o.kurz.length || o.lang.length ? o : undefined;
}

// ---------- Fotos von Wikimedia Commons ----------
const FREIE_LIZENZ = /^(cc0|cc[ -]by([ -]sa)?|public domain|pd)/i;
const ohneAkzente = t => String(t).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
// mindestens ein aussagekräftiges Wort des Suchbegriffs muss im Dateititel oder in der Beschreibung stehen
export function passtZumSuchbegriff(suchbegriff, titel, beschreibung) {
  const worte = ohneAkzente(suchbegriff).split(/[^a-z0-9äöüß]+/i).filter(w => w.length >= 4);
  if (!worte.length) return true;
  const text = ohneAkzente(titel + " " + beschreibung);
  return worte.some(w => text.includes(w));
}
export async function bildKandidaten(bild, maximal = 5) {
  if (!bild || !bild.suchbegriff || bild.art === "keins" || !["person", "ort", "institution", "symbol"].includes(bild.art)) return [];
  const url = "https://commons.wikimedia.org/w/api.php?" + new URLSearchParams({
    action: "query", format: "json", generator: "search", gsrnamespace: "6", gsrlimit: "12",
    gsrsearch: `${bild.suchbegriff} filetype:bitmap`, prop: "imageinfo", iiprop: "url|extmetadata|mime|size", iiurlwidth: "1280"
  });
  try {
    const r = await fetch(url, { headers: { "User-Agent": "NachrichtenHeft/1.0 (Schulprojekt; GitHub Pages)" } });
    if (!r.ok) return [];
    const seiten = Object.values((await r.json()).query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
    const treffer = [];
    for (const p of seiten) {
      const ii = p.imageinfo?.[0]; const m = ii?.extmetadata || {};
      const lizenz = decode(m.LicenseShortName?.value || "");
      if (!ii || !/image\/(jpeg|png|webp)/.test(ii.mime) || (ii.width || 0) < 600 || !FREIE_LIZENZ.test(lizenz)) continue;
      const titel = decode(p.title || "").replace(/^Datei:|^File:/i, "");
      const beschreibung = decode(m.ImageDescription?.value || m.ObjectName?.value || "").slice(0, 200);
      if (!passtZumSuchbegriff(bild.suchbegriff, titel, beschreibung)) continue;
      treffer.push({ titel, beschreibung, url: (ii.thumburl || ii.url).split("?")[0], original: ii.url, seite: ii.descriptionurl,
        urheber: decode(m.Artist?.value || "unbekannt").slice(0, 90), lizenz, lizenzUrl: m.LicenseUrl?.value || "",
        art: bild.art, suchbegriff: bild.suchbegriff, bildunterschrift: bild.bildunterschrift || "",
        hinweis: bild.art === "symbol" ? "Symbolbild" : "Archivfoto" });
      if (treffer.length >= maximal) break;
    }
    return treffer;
  } catch { return []; }
}

// Eine KI-Anfrage wählt für alle Themen die passenden Bilder aus
export async function bilderAuswaehlen(kandidatenProThema, kiFn) {
  const eintraege = [...kandidatenProThema.entries()].filter(([, v]) => v.kandidaten.length);
  if (!eintraege.length) return new Map();
  const liste = eintraege.map(([id, v]) =>
    `## Thema ${id}\n${v.titel}\n${v.vorspann.slice(0, 180)}\nBilder:\n` +
    v.kandidaten.map((k, i) => `[${id}#${i}] (${k.art}, Suche: ${k.suchbegriff}) ${k.titel} – ${k.beschreibung.slice(0, 120)}`).join("\n")
  ).join("\n\n");
  const antwort = await kiFn(`${liste}

Wähle für jedes Thema die Bilder aus, die WIRKLICH zum Thema passen und es verständlicher machen.
Regeln:
- Höchstens 3 Bilder je Thema, sinnvolle Reihenfolge: zuerst die beteiligte Person oder der Ort, dann Gebäude oder Symbol.
- Passt ein Bild nicht eindeutig zum Thema (falsche Person, falscher Ort, unpassendes Motiv, unklares Motiv), lass es weg.
- Lieber gar kein Bild als ein falsches. Themen ohne passendes Bild bekommen eine leere Liste.
- Schreibe zu jedem gewählten Bild eine sachliche Bildunterschrift in einem Satz (was zu sehen ist und der Bezug zum Thema).
Antworte NUR mit JSON: {"auswahl": [{"thema": "themen-id", "bilder": [{"ref": "themen-id#0", "bildunterschrift": "..."}]}]}`, 3000);
  const ergebnis = new Map();
  for (const a of antwort.auswahl || []) {
    const v = kandidatenProThema.get(a.thema); if (!v) continue;
    const gewaehlt = [];
    for (const b of (a.bilder || []).slice(0, 3)) {
      const i = +String(b.ref || "").split("#")[1];
      const k = v.kandidaten[i];
      if (k && !gewaehlt.some(g => g.url === k.url)) gewaehlt.push({ ...k, bildunterschrift: String(b.bildunterschrift || k.bildunterschrift || "") });
    }
    ergebnis.set(a.thema, gewaehlt);
  }
  return ergebnis;
}

export async function bildSuchen(bild) {
  if (!bild || !bild.suchbegriff || bild.art === "keins" || !["person", "ort", "institution", "symbol"].includes(bild.art)) return undefined;
  const begriffe = [bild.suchbegriff, bild.suchbegriff.split(/\s+/).slice(0, 2).join(" ")].filter((b, i, a) => b && a.indexOf(b) === i);
  for (const begriff of begriffe) {
    const url = "https://commons.wikimedia.org/w/api.php?" + new URLSearchParams({
      action: "query", format: "json", generator: "search", gsrnamespace: "6", gsrlimit: "8",
      gsrsearch: `${begriff} filetype:bitmap`, prop: "imageinfo", iiprop: "url|extmetadata|mime|size", iiurlwidth: "1280"
    });
    try {
      const r = await fetch(url, { headers: { "User-Agent": "NachrichtenHeft/1.0 (Schulprojekt; GitHub Pages)" } });
      if (!r.ok) continue;
      const seiten = Object.values((await r.json()).query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
      for (const p of seiten) {
        const ii = p.imageinfo?.[0]; const m = ii?.extmetadata || {};
        const lizenz = decode(m.LicenseShortName?.value || "");
        if (!ii || !/image\/(jpeg|png|webp)/.test(ii.mime) || (ii.width || 0) < 600 || !FREIE_LIZENZ.test(lizenz)) continue;
        return {
          url: (ii.thumburl || ii.url).split("?")[0], original: ii.url, seite: ii.descriptionurl,
          urheber: decode(m.Artist?.value || "unbekannt").slice(0, 90), lizenz,
          lizenzUrl: m.LicenseUrl?.value || "", art: bild.art,
          hinweis: bild.art === "symbol" ? "Symbolbild" : "Archivfoto"
        };
      }
    } catch { /* nächster Versuch */ }
  }
  return undefined;
}

export async function bilderSuchen(bilder, schonDa = []) {
  const treffer = [], gesehen = new Set(schonDa.map(b => b.url));
  for (const b of (bilder || []).slice(0, 4)) {
    if (treffer.length >= 3) break;
    const info = await bildSuchen(b);
    if (info && !gesehen.has(info.url)) {
      gesehen.add(info.url);
      treffer.push({ ...info, bildunterschrift: b.bildunterschrift || "" });
    }
  }
  return treffer;
}

// ---------- Ort für die Karte ----------
export async function ortSuchen(ort) {
  if (!ort?.name) return undefined;
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?" + new URLSearchParams({ q: ort.name, format: "json", limit: "1" }),
      { headers: { "User-Agent": UA, "Accept-Language": "de" } });
    if (!r.ok) return undefined;
    const [t] = await r.json();
    if (!t) return undefined;
    return { name: ort.name, lat: +(+t.lat).toFixed(3), lon: +(+t.lon).toFixed(3) };
  } catch { return undefined; }
}

// ---------- Ausgaben zu festen Zeiten ----------
const SENDEZEITEN = [6, 9, 12, 15, 18, 21];
export function aktuelleSendezeit(jetzt) {
  const h = berlinStunde(jetzt);
  const passend = [...SENDEZEITEN].reverse().find(z => h >= z);
  return passend ?? null;
}
async function ausgabeSpeichern(jetzt, nachrichten) {
  const stunde = aktuelleSendezeit(jetzt);
  if (stunde === null) return;
  const tag = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(jetzt);
  const id = `${tag}-${String(stunde).padStart(2, "0")}`;
  const themen = [...nachrichten]
    .sort((a, b) => (b.eil - a.eil) || b.zeit.localeCompare(a.zeit))
    .slice(0, 12)
    .map(n => ({ id: n.id, titel: n.titel, rubrik: n.rubrik, eil: !!n.eil, bilder: n.bildInfos || (n.bildInfo ? [n.bildInfo] : []), ort: n.ortInfo,
      saetze: n.video?.lang?.length ? n.video.lang : [n.vorspann] }));
  if (themen.length < 3) return;
  const ordner = new URL("data/ausgaben/", ROOT);
  await fs.mkdir(ordner, { recursive: true });
  const name = `${stunde}-Uhr-Ausgabe`;
  await fs.writeFile(new URL(`${id}.json`, ordner), JSON.stringify({ id, name, stunde, zeit: jetzt.toISOString(), themen }, null, 1));
  const indexDatei = new URL("index.json", ordner);
  const alt = await leseJson(indexDatei, []);
  const neu = [{ id, name, stunde, zeit: jetzt.toISOString(), anzahl: themen.length }, ...alt.filter(a => a.id !== id)].slice(0, 40);
  await fs.writeFile(indexDatei, JSON.stringify(neu, null, 1));
  console.log(`Ausgabe gespeichert: ${name} (${themen.length} Themen)`);
}

// ---------- Wochenrückblick ----------
async function wochenrueckblick(jetzt, aktive, force) {
  const datei = new URL("data/woche.json", ROOT);
  const alt = await leseJson(datei, null);
  const wochentag = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", weekday: "short" }).format(jetzt);
  const alter = alt ? (jetzt - new Date(alt.erstellt)) / 36e5 : Infinity;
  if (!force && !(alter > 7 * 24 || (wochentag.startsWith("So") && alter > 20))) return;
  const grenze = jetzt - 7 * 864e5;
  const monate = [...new Set([0, 8].map(t => berlinMonat(new Date(jetzt - t * 864e5).toISOString())))];
  let kandidaten = [...aktive];
  for (const m of monate) kandidaten.push(...await leseJson(new URL(`data/archiv/${m}.json`, ROOT), []));
  const ids = new Set();
  kandidaten = kandidaten.filter(n => new Date(n.zeit) >= grenze && !ids.has(n.id) && ids.add(n.id));
  if (kandidaten.length < 3) return console.log("Wochenrückblick: noch zu wenige Themen.");
  const liste = kandidaten.slice(0, 70).map(n => `[${n.id}] ${n.rubrik} | ${n.medien?.length || 0} Medien | ${n.titel}\n${[n.vorspann, ...(n.zusammenfassung || [])].join(" ").slice(0, 500)}`).join("\n\n");
  try {
    const erg = await ki(REGELN, `Hier sind die Nachrichten der letzten 7 Tage:\n${liste}\n
Wähle die 6 bis 8 wichtigsten, möglichst unterschiedlichen Themen der Woche (verschiedene Rubriken, keine Doppelungen).
Schreibe zu jedem 3 neutrale Sprechsätze zum Vorlesen (je höchstens 20 Wörter), NUR aus dem mitgelieferten Text.
Antworte NUR mit JSON: {"themen": [{"id": "...", "saetze": ["...", "...", "..."]}]}`, 4000);
    const themen = (erg.themen || []).map(t => {
      const n = kandidaten.find(k => k.id === t.id);
      const saetze = (t.saetze || []).map(String).filter(Boolean).slice(0, 4);
      return n && saetze.length ? { id: n.id, titel: n.titel, rubrik: n.rubrik, zeit: n.zeit, bild: n.bildInfo, saetze } : null;
    }).filter(Boolean).slice(0, 8);
    if (themen.length < 3) return console.warn("Wochenrückblick: zu wenige gültige Themen.");
    await fs.writeFile(datei, JSON.stringify({ erstellt: jetzt.toISOString(), von: new Date(grenze).toISOString(), bis: jetzt.toISOString(), themen }, null, 1));
    console.log(`Wochenrückblick erstellt: ${themen.length} Themen`);
  } catch (e) { console.warn("Wochenrückblick fehlgeschlagen: " + e.message); }
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
  let neuGeschrieben = 0, upgrades = 0;
  const bildWahl = new Map(); // Kandidaten je Thema

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
    const veraltet = altesThema && (altesThema.version || 1) < TEXT_VERSION;
    if (altesThema && !veraltet && auswahl.every(a => alteLinks.has(a.link))) continue; // nichts Neues
    if (veraltet && auswahl.every(a => alteLinks.has(a.link))) { if (upgrades >= (CFG.maxNeuschreibenProLauf ?? 3)) continue; upgrades++; }
    if (!altesThema && neuGeschrieben >= CFG.maxNeueThemenProLauf) continue;

    modellZuruecksetzen(); // für jedes Thema zuerst wieder das beste Modell versuchen

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
      let geprueft = false, korrekturen = [], lernen, einfach, video;
      try {
        const pr = await themaPruefen(entwurf, quellenTexte);
        const korrigiert = pruefen({ ...pr.nachricht, eil: entwurf.eil }, quellenTexte);
        if (!korrigiert.bild) korrigiert.bild = entwurf.bild;
        if (korrigiert.titel && korrigiert.einig.length > 0) {
          entwurf = korrigiert; geprueft = true;
          korrekturen = (pr.korrekturen || []).map(String).slice(0, 12);
          lernen = lernenPruefen(pr.lernen);
          einfach = einfachPruefen(pr.einfach);
          video = videoPruefen(pr.video);
          console.log(`  Prüfung: ${korrekturen.length} Korrektur(en)`);
        } else console.warn("  Prüfung lieferte keine gültige Fassung – Entwurf bleibt, als ungeprüft markiert.");
      } catch (e) { console.warn(`  Prüfung fehlgeschlagen: ${e.message}`); }
      const alleTexte = { ...entwurf, zusammenfassung: [...entwurf.zusammenfassung, ...entwurf.artikel.flatMap(a => a.absaetze)] };
      const wortwarnung = wertendeWoerterFinden(alleTexte, CFG.wertendeWoerter);
      // Zeitleiste mit der bisherigen Fassung zusammenführen
      if (altesThema?.zeitleiste?.length) {
        const bekannt = new Set(entwurf.zeitleiste.map(z => z[1]));
        entwurf.zeitleiste = [...altesThema.zeitleiste.filter(z => !bekannt.has(z[1])), ...entwurf.zeitleiste].slice(-12);
      }
      // Fotos: Kandidaten sammeln, die Auswahl trifft später eine gemeinsame KI-Anfrage
      let bildInfos = altesThema?.bildInfos || (altesThema?.bildInfo ? [altesThema.bildInfo] : []);
      if (CFG.bilder !== false && bildInfos.length < 2) {
        const kandidaten = [];
        for (const b of (entwurf.bilder || []).slice(0, 4)) {
          if (kandidaten.length >= 8) break;
          kandidaten.push(...(await bildKandidaten(b, 3)));
        }
        if (kandidaten.length) bildWahl.set(t.id, { titel: entwurf.titel, vorspann: entwurf.vorspann, kandidaten });
        console.log(`  Bildvorschläge: ${kandidaten.length}`);
      }
      const bildInfo = bildInfos[0];
      const ortInfo = altesThema?.ortInfo?.name === entwurf.ort?.name ? altesThema.ortInfo : await ortSuchen(entwurf.ort);
      if (ortInfo) console.log(`  Ort: ${ortInfo.name} (${ortInfo.lat}, ${ortInfo.lon})`);
      if (wortwarnung.length) console.warn(`  Wertende Wörter gefunden: ${wortwarnung.join(", ")}`);
      const neuesteZeit = quellenTexte.map(q => q.datum).filter(d => d !== "unbekannt").sort().pop() || jetzt.toISOString();
      ergebnis.set(t.id, {
        id: t.id, rubrik: CFG.rubriken.includes(t.rubrik) ? t.rubrik : "Welt",
        zeit: neuesteZeit,
        aktualisiert: altesThema ? `aktualisiert um ${berlinUhr(jetzt)} Uhr` : undefined,
        ...entwurf,
        geprueft, korrekturen, wortwarnung, lernen, einfach, video, bildInfo, bildInfos, ortInfo, version: TEXT_VERSION
      });
      neuGeschrieben++;
      console.log(`${altesThema ? "↻" : "+"} ${entwurf.titel} (${quellenTexte.length} Quellen)`);
    } catch (e) { console.warn(`Fehler bei ${t.id}: ${e.message}`); }
  }

  // Bilder auswählen: eine KI-Anfrage prüft alle Kandidaten auf Passgenauigkeit
  if (bildWahl.size) {
    try {
      const wahl = await bilderAuswaehlen(bildWahl, (text, max) => ki(REGELN, text, max || 3000));
      for (const [id, bilder] of wahl) {
        const n = ergebnis.get(id); if (!n) continue;
        n.bildInfos = bilder; n.bildInfo = bilder[0]; n.bildVersucht = true;
        console.log(`  Bilder für ${id}: ${bilder.length ? bilder.map(b => b.titel.slice(0, 40)).join(" | ") : "keins passte"}`);
      }
    } catch (e) { console.warn("Bildauswahl fehlgeschlagen: " + e.message); }
  }

  // Fotos für Nachrichten ohne Bild nachholen (eine gemeinsame KI-Anfrage)
  if (CFG.bilder !== false) {
    const ohneBild = [...ergebnis.values()].filter(n => !n.bildInfo && !(n.bilder?.[0]?.art === "keins") && !n.bildVersucht).slice(0, 15);
    if (ohneBild.length) {
      try {
        const erg = await ki(REGELN, `Schlage für diese Nachrichten je ein freies Foto bei Wikimedia Commons vor.
Zeige nie das Ereignis selbst, sondern eine beteiligte Person, einen Ort, eine Institution oder ein neutrales Symbol.
Bei Unglücken mit Toten oder Verletzten, Gewalttaten, Opfern oder Kindern: art "keins".
${ohneBild.map(n => `[${n.id}] ${n.titel} – ${n.vorspann}`).join("\n")}
Antworte NUR mit JSON: {"bilder": [{"id": "...", "art": "person | ort | institution | symbol | keins", "suchbegriff": "..."}]}`, 2000);
        const nachhol = new Map();
        for (const b of erg.bilder || []) {
          const n = ergebnis.get(b.id); if (!n) continue;
          n.bilder = [{ art: String(b.art || "keins").toLowerCase(), suchbegriff: String(b.suchbegriff || ""), bildunterschrift: "" }];
          n.bildVersucht = true;
          nachhol.set(n.id, { titel: n.titel, vorspann: n.vorspann, kandidaten: await bildKandidaten(n.bilder[0], 4) });
        }
        const wahl2 = await bilderAuswaehlen(nachhol, (text, max) => ki(REGELN, text, max || 3000));
        for (const [id, bilder] of wahl2) {
          const n = ergebnis.get(id); if (!n) continue;
          n.bildInfos = bilder; n.bildInfo = bilder[0];
          console.log(`  Foto nachgeholt für ${id}: ${bilder.length ? bilder[0].titel.slice(0, 40) : "keins passte"}`);
        }
      } catch (e) { console.warn("Fotos nachholen fehlgeschlagen: " + e.message); }
    }
  }

  const { aktiv: nachrichten, alt: altListe } = aufraeumen([...ergebnis.values()], jetzt, CFG);
  const imArchiv = await archivieren(altListe, nachrichten, jetzt, CFG);
  await ausgabeSpeichern(jetzt, nachrichten);
  await wochenrueckblick(jetzt, nachrichten, !!process.env.FORCE_WOCHE);
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
