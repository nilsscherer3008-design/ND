// Nachrichten-Heft · neutral – Aktualisierung
// Läuft in GitHub Actions. Liest Nachrichten-Feeds, findet Themen mit mehreren Quellen,
// lässt sie von einer KI (Gemini oder Claude) neutral zusammenfassen und schreibt data/news.json.
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

const ROOT = new URL("./", import.meta.url);
const DATA_FILE = new URL("data/news.json", ROOT);
const UA = "Mozilla/5.0 (compatible; NachrichtenHeft/1.0; Schulprojekt)";
const TEXT_VERSION = 5; // höhere Zahl = ältere Artikel werden nach und nach neu geschrieben

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
const geminiModelle = () => [].concat(CFG?.modelle?.gemini || ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash"]);
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
    body: JSON.stringify({ model: CFG?.modelle?.anthropic || "claude-sonnet-4-5", max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] })
  });
  if (!r.ok) return { fehler: r.status, text: await r.text() };
  const data = await r.json();
  return { text: data.content.map(c => c.text || "").join("") };
}

// Zweitdienst: Groq, Mistral, OpenRouter und andere sprechen alle dieselbe Sprache.
// Ein Schlüssel und eine Adresse genügen, dann springt die App dorthin, wenn Gemini für heute leer ist.
async function openaiAnfrage(system, user, maxTokens) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY fehlt (GitHub Secret anlegen).");
  const basis = (process.env.OPENAI_BASIS || CFG.zweitdienst?.basis || "https://api.groq.com/openai/v1").replace(/\/$/, "");
  const modell = process.env.OPENAI_MODELL || CFG.zweitdienst?.modell || "llama-3.3-70b-versatile";
  const r = await fetch(`${basis}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({
      model: modell, temperature: 0.2, max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    })
  });
  if (!r.ok) return { fehler: r.status, text: await r.text() };
  const data = await r.json();
  return { text: data.choices?.[0]?.message?.content || "" };
}

const ANBIETER = {
  gemini:    { schluessel: "GEMINI_API_KEY",    anfrage: geminiAnfrage,    name: "Gemini" },
  openai:    { schluessel: "OPENAI_API_KEY",    anfrage: openaiAnfrage,    name: "Zweitdienst" },
  anthropic: { schluessel: "ANTHROPIC_API_KEY", anfrage: anthropicAnfrage, name: "Claude" }
};
let anbieterIndex = 0;
const anbieterReihe = () => (CFG?.anbieterReihe || ["gemini", "openai", "anthropic"])
  .filter(a => ANBIETER[a] && process.env[ANBIETER[a].schluessel]);

let kiAnfragen = 0;
export const kiVerbrauch = () => kiAnfragen;
export const kiBudgetFrei = () => kiAnfragen < (CFG?.maxKiAnfragenProLauf || 99);
// Wie viele Anfragen sind in diesem Lauf noch übrig?
export const kiBudgetRest = () => Math.max(0, (CFG?.maxKiAnfragenProLauf || 99) - kiAnfragen);

let letzteAnfrage = 0;
async function ki(system, user, maxTokens = 4000) {
  const reihe = anbieterReihe();
  if (!reihe.length) throw new Error("Kein KI-Schlüssel hinterlegt – lege GEMINI_API_KEY (oder OPENAI_API_KEY) als GitHub Secret an.");
  const maxVersuche = 8;
  let limits = 0;
  kiAnfragen++;
  for (let versuch = 1; versuch <= maxVersuche; versuch++) {
    const aktiv = reihe[Math.min(anbieterIndex, reihe.length - 1)];
    const gemini = aktiv === "gemini";
    const anfrage = ANBIETER[aktiv].anfrage;
    const pause = (CFG?.pauseZwischenKiAnfragenSekunden || 0) * 1000 - (Date.now() - letzteAnfrage);
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
        limits++;
        if (gemini && limits < 3 && naechstesGeminiModell()) { await warte(4000); continue; }
        if (anbieterIndex < reihe.length - 1) {
          anbieterIndex++;
          console.warn(`Limit erreicht – wechsle auf ${ANBIETER[reihe[anbieterIndex]].name}.`);
          await warte(3000);
          continue;
        }
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

export async function themenFinden(artikel, bestehende) {
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
Regeln für "bilder": 3 bis 5 deutlich verschiedene Vorschläge (Person, Ort, Gebäude, Symbol – nicht zweimal dasselbe Motiv), die das Thema verständlicher machen. Zeige nie das Ereignis selbst.
- Der erste Vorschlag ist möglichst eine BETEILIGTE PERSON mit vollem Namen und Funktion, denn ein Gesicht erklärt mehr als ein Gebäude. Nur wenn keine Person im Mittelpunkt steht, beginne mit dem Ort oder der Institution.
- Schreibe Suchbegriffe so, wie ein Wikipedia-Artikel heißt: "Magdalena Andersson", "Oktoberfest", "Federal Reserve", "Bundesgerichtshof". Keine beschreibenden Sätze, keine allgemeinen Wörter wie "Politik".
- Nimm nicht bei jedem Thema dasselbe Regierungsgebäude. Wenn dir nichts Besseres einfällt als ein Amtssitz, nimm lieber die handelnde Person.
- NUR in diesen Fällen stattdessen einen einzigen Eintrag mit art "keins": das Ereignis ist ein Unglück mit Toten oder Verletzten, eine Gewalttat, ein Verbrechen, oder es geht um Opfer oder um Kinder. Ein Volksfest, eine Wahl, ein Gerichtsurteil, eine Behördenentscheidung oder ein Sportereignis ist KEIN solcher Fall – dort immer Bilder vorschlagen.`, 9000);
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
- "dossier": {"slug": "kurzer-themen-slug", "titel": "Name des übergeordneten Themas, z. B. 'Wahl in Schweden' oder 'Krieg in der Ukraine'"} – gleiche Ereignisketten bekommen denselben Slug.
- "kurz": 3 bis 4 Stichpunkte für Eilige, je höchstens 15 Wörter.
- "fakten": die wichtigsten Zahlen und Daten als Paare, z. B. [["Stimmen im Parlament", "262 zu 159"], ["Datum", "17. September 2026"]]. Nur Zahlen, die in den Berichten stehen. Leere Liste, wenn es keine gibt.
- "video": Sprechtexte für eine Nachrichtensendung, so wie sie eine Sprecherin oder ein Sprecher vorliest.
  Sprechregeln (wichtig, der Text wird wirklich vorgelesen):
  · Jeder Satz höchstens 16 Wörter, ein Gedanke pro Satz. Kurze Hauptsätze, Präsens oder Perfekt, aktive Formulierungen ("Das Parlament beschloss", nicht "es wurde beschlossen").
  · Keine Abkürzungen. Schreibe alles so, wie man es spricht: Zahlen als Wörter ("drei Komma sieben fünf Prozent", "siebzehnter September"), Prozent statt %, Euro statt €, "und so weiter" statt "usw.", "Europäische Union" statt "EU" beim ersten Mal.
  · Setze Kommas genau dort, wo ein Sprecher Luft holt. Keine Klammern, keine Gedankenstriche, keine Aufzählungszeichen, keine Anführungszeichen um ganze Sätze.
  · Keine Floskeln wie "Guten Abend", "Willkommen", "Bleiben Sie dran". Keine Fragen an das Publikum.
  · Namen beim ersten Mal mit Funktion ("die schwedische Ministerpräsidentin Magdalena Andersson"), danach nur noch der Nachname.
  · Aussagen immer kennzeichnen: "nach Angaben der Polizei", "das sagte er am Donnerstag". Wenn mehrere Medien dasselbe berichten, darf ein Satz das sachlich erwähnen.
  Aufbau von "lang" (8 bis 10 Sätze): 1. Ein Einstiegssatz, der das Wichtigste sofort sagt, ohne zu werten und ohne zu übertreiben. 2.–3. Was genau passiert ist, mit Ort und Zeit. 4.–6. Die wichtigsten Zahlen, Namen und Abläufe, jeweils mit Beleg. 7. Wenn es unterschiedliche Angaben oder Sichtweisen gibt: ein Satz dazu, wer was sagt. 8. Ein Hintergrundsatz, der das Ereignis einordnet – nur Gesichertes. 9.–10. Wie es weitergeht oder was noch offen ist.
  "kurz": 3 bis 4 Sätze – Kern, wichtigste Zahl, Ausblick. "einfach": 5 bis 6 sehr einfache Sätze für Jugendliche ab zwölf, jeder Satz höchstens zwölf Wörter, schwierige Wörter direkt im Satz erklärt.

Aufgabe 3 – Lernmaterial für Schülerinnen und Schüler:
- "begriffe": 3–4 schwierige Begriffe aus der Nachricht, je 1–2 einfache Sätze Erklärung, ohne Wertung.
- "fragen": 2–3 offene Diskussionsfragen, die keine Meinung vorgeben (z. B. zu Quellen, Wortwahl, Folgen).
- "quiz": 3 Fragen mit je 3 Antworten; genau eine richtig; die richtige Antwort muss unter "einig" belegt sein.

Antworte NUR mit JSON: {"nachricht": {gleiches Format wie der Entwurf}, "korrekturen": ["..."], "dossier": {"slug": "...", "titel": "..."}, "kurz": ["..."], "fakten": [["Bezeichnung", "Wert"]], "einfach": {"vorspann": "...", "absaetze": ["..."]}, "video": {"kurz": ["..."], "lang": ["..."], "einfach": ["..."]}, "lernen": {"begriffe": [["Begriff","Erklärung"]], "fragen": ["..."], "quiz": [{"frage":"...","optionen":["...","...","..."],"richtig":0,"erklaerung":"..."}]}}`, 12000);
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
  for (const n of alteNachrichten) idx.set(n.id, { id: n.id, titel: n.titel, vorspann: n.vorspann, rubrik: n.rubrik, zeit: n.zeit, monat: berlinMonat(n.zeit), dossier: n.dossier });
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
export function kurzPruefen(k) {
  const l = (Array.isArray(k) ? k : []).map(String).map(t => t.trim()).filter(Boolean).slice(0, 5);
  return l.length ? l : undefined;
}
export function faktenPruefen(f) {
  const l = (Array.isArray(f) ? f : []).filter(x => Array.isArray(x) && x[0] && x[1]).map(x => [String(x[0]), String(x[1])]).slice(0, 8);
  return l.length ? l : undefined;
}
export function dossierPruefen(d) {
  if (!d || !d.slug) return undefined;
  const slug = String(d.slug).toLowerCase().replace(/[^a-z0-9äöüß-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return slug ? { slug, titel: String(d.titel || slug).slice(0, 80) } : undefined;
}
export function videoPruefen(v) {
  if (!v || typeof v !== "object") return undefined;
  const sätze = (x, max) => (Array.isArray(x) ? x : [x]).map(t => String(t || "").trim()).filter(Boolean).slice(0, max);
  const o = { kurz: sätze(v.kurz, 4), lang: sätze(v.lang, 10), einfach: sätze(v.einfach, 6) };
  return o.kurz.length || o.lang.length ? o : undefined;
}

// ---------- Fotos von Wikimedia Commons ----------
// Freie Lizenzen. GFDL und "Attribution" fehlten hier - dadurch fiel ein grosser Teil
// der aelteren Wikipedia-Bilder stillschweigend durch.
const FREIE_LIZENZ = /^(cc0|cc[ -]by([ -]sa)?|public domain|pd|gfdl|attribution|fal)/i;
const ohneAkzente = t => String(t).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
// mindestens ein aussagekräftiges Wort des Suchbegriffs muss im Dateititel oder in der Beschreibung stehen
export function passtZumSuchbegriff(suchbegriff, titel, beschreibung) {
  const worte = ohneAkzente(suchbegriff).split(/[^a-z0-9äöüß]+/i).filter(w => w.length >= 4);
  if (!worte.length) return true;
  const text = ohneAkzente(titel + " " + beschreibung);
  return worte.some(w => text.includes(w));
}
const WIKI_KOPF = { "User-Agent": "NachrichtenHeft/1.0 (Schulprojekt; GitHub Pages)" };
// Metadaten einer Commons-Datei holen (Lizenz, Urheber, Vorschaubild)
async function commonsDatei(dateiTitel, grund) {
  // Commons kennt den Dateinamensraum als "File:". Die deutsche Wikipedia liefert
  // "Datei:" - das wird hier vereinheitlicht, damit nichts ins Leere laeuft.
  const titel = String(dateiTitel).replace(/^\s*Datei:/i, "File:");
  const url = "https://commons.wikimedia.org/w/api.php?" + new URLSearchParams({
    action: "query", format: "json", titles: titel,
    prop: "imageinfo", iiprop: "url|extmetadata|mime|size", iiurlwidth: "1280"
  });
  let r, daten;
  try {
    r = await fetch(url, { headers: WIKI_KOPF });
    if (!r.ok){ if (grund) grund.abgelehnt.push(`HTTP ${r.status}`); return null; }
    daten = await r.json();
  } catch (e) { if (grund) grund.abgelehnt.push("Abruf: " + e.message); return null; }
  const seite = Object.values(daten.query?.pages || {})[0];
  const ii = seite?.imageinfo?.[0];
  if (!ii){ if (grund) grund.abgelehnt.push("nicht auf Commons"); return null; }
  const m = ii.extmetadata || {};
  const lizenz = decode(m.LicenseShortName?.value || "");
  if (!/image\/(jpeg|png|webp)/.test(ii.mime)){ if (grund) grund.abgelehnt.push("Format " + ii.mime); return null; }
  if ((ii.width || 0) < 400){ if (grund) grund.abgelehnt.push(`zu klein (${ii.width}px)`); return null; }
  if (!FREIE_LIZENZ.test(lizenz)){ if (grund) grund.abgelehnt.push("Lizenz " + (lizenz || "unbekannt")); return null; }
  return {
    titel: decode(seite.title || "").replace(/^Datei:|^File:/i, ""),
    beschreibung: decode(m.ImageDescription?.value || m.ObjectName?.value || "").slice(0, 200),
    url: (ii.thumburl || ii.url).split("?")[0], original: ii.url, seite: ii.descriptionurl,
    urheber: decode(m.Artist?.value || "unbekannt").slice(0, 90), lizenz, lizenzUrl: m.LicenseUrl?.value || ""
  };
}
// Das Titelbild des passenden Wikipedia-Artikels – so sieht man wirklich die gemeinte Person oder den Ort
export async function wikipediaBild(suchbegriff, sprachen = ["de", "en"]) {
  for (const sprache of sprachen) {
    try {
      const url = `https://${sprache}.wikipedia.org/w/api.php?` + new URLSearchParams({
        action: "query", format: "json", generator: "search", gsrsearch: suchbegriff, gsrlimit: "3",
        gsrnamespace: "0", prop: "pageimages", piprop: "name", pilicense: "free"
      });
      const r = await fetch(url, { headers: WIKI_KOPF });
      if (!r.ok) continue;
      const seiten = Object.values((await r.json()).query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
      for (const seite of seiten) {
        if (!seite.pageimage) continue;
        const datei = await commonsDatei("File:" + seite.pageimage);
        if (datei) return { ...datei, artikel: seite.title, sprache };
      }
    } catch { /* nächste Sprache */ }
  }
  return null;
}
export async function bildKandidaten(bild, maximal = 5) {
  if (!bild || !bild.suchbegriff || bild.art === "keins" || !["person", "ort", "institution", "symbol"].includes(bild.art)) return [];
  const url = "https://commons.wikimedia.org/w/api.php?" + new URLSearchParams({
    action: "query", format: "json", generator: "search", gsrnamespace: "6", gsrlimit: "12",
    gsrsearch: `${bild.suchbegriff} filetype:bitmap`, prop: "imageinfo", iiprop: "url|extmetadata|mime|size", iiurlwidth: "1280"
  });
  const treffer = [];
  const rahmen = d => ({ ...d, art: bild.art, suchbegriff: bild.suchbegriff, bildunterschrift: bild.bildunterschrift || "",
    hinweis: bild.art === "symbol" ? "Symbolbild" : "Archivfoto" });
  // 1. Das Titelbild des Wikipedia-Artikels – zeigt fast immer genau das Gemeinte
  if (bild.art === "person" || bild.art === "institution" || bild.art === "ort") {
    try {
      const w = await wikipediaBild(bild.suchbegriff);
      if (w) treffer.push(rahmen({ ...w, beschreibung: (w.beschreibung || `Titelbild des Wikipedia-Artikels „${w.artikel}“`).slice(0, 200) }));
    } catch { /* dann eben nur die Suche */ }
  }
  // 2. Volltextsuche in der Bilddatenbank
  try {
    const r = await fetch(url, { headers: WIKI_KOPF });
    if (!r.ok) return treffer;
    const seiten = Object.values((await r.json()).query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
    for (const p of seiten) {
      const ii = p.imageinfo?.[0]; const m = ii?.extmetadata || {};
      const lizenz = decode(m.LicenseShortName?.value || "");
      if (!ii || !/image\/(jpeg|png|webp)/.test(ii.mime) || (ii.width || 0) < 600 || !FREIE_LIZENZ.test(lizenz)) continue;
      const titel = decode(p.title || "").replace(/^Datei:|^File:/i, "");
      const beschreibung = decode(m.ImageDescription?.value || m.ObjectName?.value || "").slice(0, 200);
      if (!passtZumSuchbegriff(bild.suchbegriff, titel, beschreibung)) continue;
      if (treffer.some(t => t.url === (ii.thumburl || ii.url).split("?")[0])) continue;
      treffer.push(rahmen({ titel, beschreibung, url: (ii.thumburl || ii.url).split("?")[0], original: ii.url, seite: ii.descriptionurl,
        urheber: decode(m.Artist?.value || "unbekannt").slice(0, 90), lizenz, lizenzUrl: m.LicenseUrl?.value || "" }));
      if (treffer.length >= maximal) break;
    }
    return treffer;
  } catch { return treffer; }
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
- Höchstens 4 Bilder je Thema, sinnvolle Reihenfolge: zuerst die beteiligte Person oder der Ort, dann Gebäude oder Symbol. Wähle möglichst unterschiedliche Motive, keine zwei fast gleichen Bilder.
- Verwende dasselbe Bild NICHT für zwei verschiedene Themen. Taucht ein Motiv (z. B. ein Amtssitz) bei mehreren Themen auf, gib es nur dem Thema, zu dem es am besten passt.
- Passt ein Bild nicht eindeutig zum Thema (falsche Person, falscher Ort, unpassendes Motiv, unklares Motiv), lass es weg.
- Lieber gar kein Bild als ein falsches. Themen ohne passendes Bild bekommen eine leere Liste.
- Schreibe zu jedem gewählten Bild eine sachliche Bildunterschrift in einem Satz (was zu sehen ist und der Bezug zum Thema).
Antworte NUR mit JSON: {"auswahl": [{"thema": "themen-id", "bilder": [{"ref": "themen-id#0", "bildunterschrift": "..."}]}]}`, 3000);
  const ergebnis = new Map();
  for (const a of antwort.auswahl || []) {
    const v = kandidatenProThema.get(a.thema); if (!v) continue;
    const gewaehlt = [];
    for (const b of (a.bilder || []).slice(0, 4)) {
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



// Alle frei lizenzierten Bilder eines Wikipedia-Artikels holen – so viele, wie eine Doku braucht.
const BILD_MUELL = /(commons-logo|wiki(pedia|media|quote|source|books)|logo|icon|disambig|ambox|question_?book|edit-|symbol|flag_of|wappen|coat_of_arms|\.svg$|map_of_the_world|translation)/i;
export async function wikipediaBilder(artikelTitel, maximal = 8, sprache = "de") {
  try {
    const url = `https://${sprache}.wikipedia.org/w/api.php?` + new URLSearchParams({
      action: "query", format: "json", prop: "images", titles: artikelTitel, imlimit: "40", redirects: "1"
    });
    const r = await fetch(url, { headers: WIKI_KOPF });
    if (!r.ok) return [];
    const seite = Object.values((await r.json()).query?.pages || {})[0];
    const alle = (seite?.images || []).map(i => i.title);
    const namen = alle.filter(t => /\.(jpg|jpeg|png|webp)$/i.test(t) && !BILD_MUELL.test(t));
    const treffer = [];
    const grund = { abgelehnt: [] };
    // Wichtig: jeder Abruf einzeln abgesichert. Vorher hat ein einziger Fehlschlag
    // die ganze Liste gekippt - deshalb kam nie mehr als das Titelbild an.
    for (const name of namen.slice(0, maximal * 3)) {
      if (treffer.length >= maximal) break;
      try {
        const d = await commonsDatei(name, grund);
        if (d && !treffer.some(t => t.url === d.url)) treffer.push({ ...d, art: "symbol", hinweis: "Bild aus der Wikipedia" });
      } catch (e) { grund.abgelehnt.push("Fehler: " + e.message); }
      await warte(180);   // Wikimedia mag keine Salve von Anfragen
    }
    console.log(`    Bilder zu „${artikelTitel}“: ${alle.length} im Artikel, ${namen.length} nach Filter, ${treffer.length} brauchbar`
      + (grund.abgelehnt.length ? ` · abgelehnt: ${[...new Set(grund.abgelehnt)].slice(0, 5).join(", ")}` : ""));
    return treffer;
  } catch (e) { console.warn(`    Bildersuche zu „${artikelTitel}“ fehlgeschlagen: ${e.message}`); return []; }
}

// ---------- Wissensbereich: die KI sucht sich ein Thema und schlägt es in der Wikipedia nach ----------
// Regel wie überall in dieser App: Das Thema darf sie sich ausdenken, die Fakten nicht.
export async function wikipediaText(titel) {
  const suchen = async (t) => {
    const url = "https://de.wikipedia.org/w/api.php?" + new URLSearchParams({
      action: "query", format: "json", prop: "extracts", explaintext: "1", redirects: "1", titles: t
    });
    const r = await fetch(url, { headers: WIKI_KOPF });
    if (!r.ok) return null;
    const seite = Object.values((await r.json()).query?.pages || {})[0];
    if (!seite || seite.missing !== undefined || !seite.extract) return null;
    return { titel: seite.title, text: seite.extract };
  };
  let treffer = await suchen(titel);
  if (!treffer) {
    // Titel nicht exakt getroffen: über die Suche den richtigen Artikel finden
    const url = "https://de.wikipedia.org/w/api.php?" + new URLSearchParams({
      action: "query", format: "json", list: "search", srsearch: titel, srlimit: "1", srnamespace: "0"
    });
    const r = await fetch(url, { headers: WIKI_KOPF });
    if (!r.ok) return null;
    const erster = (await r.json()).query?.search?.[0];
    if (!erster) return null;
    treffer = await suchen(erster.title);
  }
  if (!treffer || treffer.text.length < 1200) return null;
  return {
    titel: treffer.titel,
    text: treffer.text.slice(0, 14000),
    url: "https://de.wikipedia.org/wiki/" + encodeURIComponent(treffer.titel.replace(/ /g, "_"))
  };
}

const WISSEN_BEREICHE = ["Natur und Tiere", "Weltall", "Geschichte", "Technik und Erfindungen",
  "Körper und Gesundheit", "Erde und Klima", "Gesellschaft und Zusammenleben", "Sprache und Kultur"];

async function wissenThemaFinden(bisherige) {
  const bereich = WISSEN_BEREICHE[Math.floor(Math.random() * WISSEN_BEREICHE.length)];
  return ki(REGELN, `Du bist die Redaktion eines Wissensmagazins für Jugendliche ab zwölf Jahren – so wie Terra X im Fernsehen.
Überlege dir EIN Thema aus dem Bereich "${bereich}", das neugierig macht und das man in fünf Minuten verstehen kann.
Gute Themen beantworten eine Frage, die man sich wirklich stellt: Wie entsteht ein Gewitter? Warum haben Zebras Streifen?
Wie kam der Mensch auf den Mond? Was ist eigentlich Inflation?

Diese Themen gab es schon, nimm ein anderes:
${bisherige.slice(0, 40).map(t => "- " + t).join("\n") || "- (noch keine)"}

Wichtig: Zu dem Thema muss es einen ausführlichen deutschen Wikipedia-Artikel geben, denn daraus werden die Fakten geholt.
Antworte NUR mit JSON: {"titel": "Die Überschrift als Frage oder Aussage, höchstens 9 Wörter",
 "wikipedia": "exakter Titel des deutschen Wikipedia-Artikels", "bereich": "${bereich}",
 "warum": "1 Satz: warum das interessant ist"}`, 700);
}

async function wissenSchreiben(thema, quelle) {
  return ki(REGELN, `Hier ist der deutsche Wikipedia-Artikel „${quelle.titel}“:

${quelle.text}

Schreibe daraus ein Wissensstück für Jugendliche ab zwölf Jahren, im Stil einer guten Wissenssendung.
Titelvorschlag der Redaktion: ${JSON.stringify(thema.titel)}

STRENGE REGEL: Jede Angabe – jede Zahl, jedes Jahr, jeder Name – muss im Artikel oben stehen.
Nichts aus eigenem Wissen ergänzen. Was dort nicht steht, kommt nicht vor. Im Zweifel weglassen.

Stil: neugierig, aber sachlich. Kurze Sätze. Fachbegriffe beim ersten Mal erklären. Keine Ausrufezeichen,
keine Übertreibungen, keine Anrede wie "Liebe Leser". Nichts behaupten, was umstritten ist, ohne das zu sagen.

Antworte NUR mit JSON:
{
 "titel": "Überschrift, höchstens 9 Wörter",
 "vorspann": "2 Sätze, die neugierig machen und schon das Wichtigste sagen",
 "artikel": [
   {"ueberschrift": "Worum es geht", "absaetze": ["2 Absätze à 4-6 Sätze"]},
   {"ueberschrift": "So funktioniert es", "absaetze": ["2-3 Absätze à 4-6 Sätze"]},
   {"ueberschrift": "Woher wir das wissen", "absaetze": ["1-2 Absätze: wie man das herausgefunden hat"]},
   {"ueberschrift": "Was noch offen ist", "absaetze": ["1 Absatz: was die Forschung noch nicht weiß – nur wenn der Artikel das hergibt"]}
 ],
 "fakten": [["Bezeichnung", "Zahl oder Wert"]],
 "begriffe": [["Begriff", "Erklärung in 1-2 einfachen Sätzen"]],
 "quiz": [{"frage": "...", "optionen": ["...", "...", "..."], "richtig": 0, "erklaerung": "..."}],
 "video": ["8 bis 10 Sprechsätze für ein kurzes Erklärvideo, je höchstens 16 Wörter, Zahlen ausgeschrieben"],
 "bild": {"suchbegriff": "Titel des Wikipedia-Artikels oder ein passendes Motiv", "bildunterschrift": "1 Satz"}
}`, 9000);
}

export function wissenPruefen(roh, thema, quelle) {
  if (!roh || !roh.titel || !Array.isArray(roh.artikel)) return null;
  const text = t => String(t || "").trim();
  const artikel = roh.artikel
    .filter(a => a && a.ueberschrift && Array.isArray(a.absaetze))
    .map(a => ({ ueberschrift: text(a.ueberschrift), absaetze: a.absaetze.map(text).filter(x => x.length > 40) }))
    .filter(a => a.absaetze.length);
  if (!artikel.length) return null;
  const woerter = artikel.flatMap(a => a.absaetze).join(" ").split(/\s+/).length;
  if (woerter < 180) return null;
  return {
    id: slugId(roh.titel),
    zeit: new Date().toISOString(),
    bereich: text(thema.bereich),
    titel: text(roh.titel).slice(0, 120),
    vorspann: text(roh.vorspann).slice(0, 400),
    artikel,
    fakten: faktenPruefen(roh.fakten) || [],
    begriffe: (roh.begriffe || []).filter(b => Array.isArray(b) && b[0] && b[1]).map(b => [text(b[0]), text(b[1])]).slice(0, 5),
    quiz: (lernenPruefen({ quiz: roh.quiz }) || {}).quiz || [],
    video: ((videoPruefen({ lang: roh.video }) || {}).lang) || [],
    bild: roh.bild && roh.bild.suchbegriff ? { art: "symbol", suchbegriff: text(roh.bild.suchbegriff), bildunterschrift: text(roh.bild.bildunterschrift) } : null,
    quelle: { titel: quelle.titel, url: quelle.url, lizenz: "CC BY-SA 4.0" },
    woerter
  };
}
const slugId = t => String(t).toLowerCase()
  .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

async function wissenErzeugen(jetzt, cfg) {
  const datei = new URL("data/wissen.json", ROOT);
  const alt = await leseJson(datei, { stuecke: [] });
  const stuecke = alt.stuecke || [];
  const heute = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(jetzt);
  const proTag = cfg.proTag ?? 1;
  const heuteSchon = stuecke.filter(x => x.zeit && x.zeit.slice(0, 10) === heute).length;
  if (heuteSchon >= proTag) return null;

  modellZuruecksetzen();
  // Mehrere Anläufe: klappt ein Thema nicht (kein Wikipedia-Artikel, zu wenig Text,
  // schon vorhanden), wird einfach ein anderes genommen statt aufzugeben.
  const versuche = Math.max(1, cfg.versuche ?? 3);
  const schonProbiert = [];
  let thema = null, quelle = null, stueck = null, letzterGrund = "";
  for (let v = 1; v <= versuche; v++) {
    // Ein Anlauf braucht zwei Anfragen (Thema + Text). Zusätzlich bleibt eine
    // Anfrage für die Doku-Vorproduktion übrig, damit die auch vorankommt.
    if (kiBudgetRest() < (v === 1 ? 2 : 3)) { letzterGrund = letzterGrund || "KI-Budget aufgebraucht"; break; }
    try {
      thema = await wissenThemaFinden([...stuecke.map(x => x.titel), ...schonProbiert]);
      if (!thema?.wikipedia) { letzterGrund = "kein Thema gefunden"; continue; }
      schonProbiert.push(thema.titel);
      console.log(`  Wissensthema (Versuch ${v}/${versuche}): ${thema.titel} (Quelle: ${thema.wikipedia})`);

      quelle = await wikipediaText(thema.wikipedia);
      if (!quelle) { letzterGrund = `kein Wikipedia-Artikel zu „${thema.wikipedia}“`; console.log("  " + letzterGrund); continue; }
      if (String(quelle.text || "").length < 1200) {
        letzterGrund = `Wikipedia-Artikel „${quelle.titel}“ ist zu kurz`; console.log("  " + letzterGrund); continue;
      }

      const roh = wissenPruefen(await wissenSchreiben(thema, quelle), thema, quelle);
      if (!roh) { letzterGrund = "Text war zu dünn"; console.log("  " + letzterGrund); continue; }
      if (stuecke.some(x => x.id === roh.id)) { letzterGrund = "Wissensstück gab es schon"; console.log("  " + letzterGrund); continue; }

      stueck = roh;
      break;
    } catch (e) {
      letzterGrund = e.message;
      console.log(`  Versuch ${v} fehlgeschlagen: ${e.message}`);
    }
  }
  if (!stueck) throw new Error(letzterGrund || "kein Wissensstück zustande gekommen");

  if (cfg.bilder !== false) {
    try {
      const titel = await wikipediaBild(quelle.titel);
      const weitere = await wikipediaBilder(quelle.titel, cfg.bilderProStueck ?? 6);
      const alle = [titel, ...weitere].filter(Boolean)
        .filter((b, i, a) => b.url && a.findIndex(x => x.url === b.url) === i);
      if (alle.length) {
        stueck.bildInfos = alle.map((b, i) => ({ ...b, art: "symbol", hinweis: "Bild aus der Wikipedia",
          bildunterschrift: i === 0 ? (stueck.bild?.bildunterschrift || b.beschreibung || "") : (b.beschreibung || "") }));
        stueck.bildInfo = stueck.bildInfos[0];
        console.log(`  Bilder: ${stueck.bildInfos.length}`);
      }
    } catch { /* ohne Bild ist auch gut */ }
  }
  const neu = [stueck, ...stuecke].slice(0, cfg.behalten ?? 40);
  await fs.writeFile(datei, JSON.stringify({ stand: jetzt.toISOString(), stuecke: neu }, null, 1));
  console.log(`✦ Wissen: ${stueck.titel} (${stueck.woerter} Wörter, Quelle: ${quelle.titel})`);
  return stueck;
}


// ---------- Lange Doku: wird über mehrere Läufe vorproduziert ----------
// Ein Lauf macht immer nur EINEN Arbeitsschritt: planen oder ein Kapitel schreiben.
// Erst wenn alle Kapitel stehen und vertont sind, erscheint die Doku in der App.
const DOKU_DATEI = () => new URL("data/doku.json", ROOT);

async function dokuPlanen(bisherige, cfg) {
  const bereich = WISSEN_BEREICHE[Math.floor(Math.random() * WISSEN_BEREICHE.length)];
  const kapitelZahl = cfg.kapitel ?? 10;
  const plan = await ki(REGELN, `Du planst eine lange Wissensdokumentation für Jugendliche ab zwölf Jahren – etwa 45 Minuten,
so wie eine Fernsehdoku. Bereich: "${bereich}".

Wähle EIN großes Thema, das so viel hergibt, dass man ${kapitelZahl} Kapitel darüber füllen kann, und teile es in Kapitel auf,
die aufeinander aufbauen und eine Geschichte erzählen: erst die Frage, dann die Grundlagen, dann die Einzelheiten,
dann wie man es herausgefunden hat, am Ende was offen bleibt.

Diese Dokus gab es schon, nimm ein anderes Thema:
${bisherige.slice(0, 20).map(t => "- " + t).join("\n") || "- (noch keine)"}

WICHTIG: Zu JEDEM Kapitel musst du einen eigenen deutschen Wikipedia-Artikel angeben, aus dem die Fakten kommen.
Nimm Artikel, die es wirklich gibt und die ausführlich sind. Verschiedene Kapitel sollen verschiedene Artikel nutzen.

Antworte NUR mit JSON:
{"titel": "Haupttitel, höchstens 8 Wörter", "untertitel": "ein Satz, der neugierig macht", "bereich": "${bereich}",
 "kapitel": [{"ueberschrift": "Kapiteltitel, höchstens 7 Wörter", "wikipedia": "exakter Titel des deutschen Wikipedia-Artikels",
              "fokus": "1 Satz: worauf dieses Kapitel hinausläuft"}]}`, 2500);
  if (!plan?.titel || !Array.isArray(plan.kapitel) || plan.kapitel.length < 4) throw new Error("Plan unbrauchbar");
  return {
    id: slugId(plan.titel),
    titel: String(plan.titel).slice(0, 120),
    untertitel: String(plan.untertitel || "").slice(0, 300),
    bereich: String(plan.bereich || bereich),
    begonnen: new Date().toISOString(),
    kapitel: plan.kapitel.slice(0, kapitelZahl).map(k => ({
      ueberschrift: String(k.ueberschrift || "").slice(0, 90),
      wikipedia: String(k.wikipedia || "").slice(0, 120),
      fokus: String(k.fokus || "").slice(0, 200)
    })).filter(k => k.ueberschrift && k.wikipedia)
  };
}

async function dokuKapitelSchreiben(doku, kapitel, quelle, nummer, gesamt, cfg) {
  const woerter = cfg.woerterProKapitel ?? 650;
  const roh = await ki(REGELN, `Du schreibst Kapitel ${nummer} von ${gesamt} einer Wissensdokumentation.

Titel der Doku: ${JSON.stringify(doku.titel)}
Kapitel: ${JSON.stringify(kapitel.ueberschrift)}
Worauf es hinausläuft: ${kapitel.fokus}
Bereits behandelte Kapitel: ${doku.kapitel.filter(k => k.absaetze?.length).map(k => k.ueberschrift).join(", ") || "(noch keine)"}

Hier ist der deutsche Wikipedia-Artikel „${quelle.titel}“, aus dem die Fakten kommen:

${quelle.text}

STRENGE REGEL: Jede Angabe – jede Zahl, jedes Jahr, jeder Name – muss in diesem Artikel stehen.
Nichts aus eigenem Wissen ergänzen. Was dort nicht steht, kommt nicht vor.

Schreibe dieses Kapitel als gesprochenen Text für eine Dokumentation: etwa ${woerter} Wörter in 5 bis 7 Absätzen.
Der Text wird vorgelesen, also: kurze Hauptsätze, höchstens sechzehn Wörter, Zahlen ausgeschrieben, wie man sie spricht,
keine Klammern, keine Aufzählungszeichen, keine Abkürzungen. Beginne mit einem Satz, der an das vorige Kapitel anknüpft,
und ende mit einem Satz, der zum nächsten überleitet. Sachlich und neugierig, nie reißerisch.

Antworte NUR mit JSON:
{"absaetze": ["Absatz 1", "Absatz 2", "..."],
 "fakten": [["Bezeichnung", "Zahl oder Wert"]],
 "begriffe": [["Begriff", "Erklärung in 1-2 einfachen Sätzen"]],
 "bild": {"suchbegriff": "Titel des Wikipedia-Artikels oder ein passendes Motiv", "bildunterschrift": "1 Satz"}}`, 9000);
  const absaetze = (roh?.absaetze || []).map(t => String(t).trim()).filter(t => t.length > 60);
  if (absaetze.length < 3) throw new Error("Kapitel zu dünn");
  return {
    ...kapitel,
    absaetze,
    fakten: faktenPruefen(roh.fakten) || [],
    begriffe: (roh.begriffe || []).filter(b => Array.isArray(b) && b[0] && b[1]).map(b => [String(b[0]), String(b[1])]).slice(0, 4),
    bild: roh.bild?.suchbegriff ? { art: "symbol", suchbegriff: String(roh.bild.suchbegriff), bildunterschrift: String(roh.bild.bildunterschrift || "") } : null,
    quelle: { titel: quelle.titel, url: quelle.url },
    woerter: absaetze.join(" ").split(/\s+/).length
  };
}

// Ein Arbeitsschritt pro Lauf – mehr nicht, damit das KI-Kontingent für die Nachrichten reicht.
async function dokuArbeiten(jetzt, cfg) {
  const datei = DOKU_DATEI();
  const daten = await leseJson(datei, { inArbeit: null, fertig: [] });
  const fertig = daten.fertig || [];
  let arbeit = daten.inArbeit;
  let etwasGetan = false;

  if (!arbeit) {
    if (fertig.length >= (cfg.behalten ?? 12)) fertig.pop();
    arbeit = await dokuPlanen(fertig.map(d => d.titel), cfg);
    console.log(`◆ Doku geplant: ${arbeit.titel} (${arbeit.kapitel.length} Kapitel)`);
    etwasGetan = true;
  } else {
    const offen = arbeit.kapitel.findIndex(k => !k.absaetze?.length && !k.fehlgeschlagen);
    if (offen >= 0) {
      const k = arbeit.kapitel[offen];
      // Findet sich zum vorgesehenen Artikel nichts, wird erst die Kapitelüberschrift
      // und dann das Doku-Thema als Suchbegriff probiert. Erst danach gilt es als gescheitert.
      let quelle = await wikipediaText(k.wikipedia);
      for (const ersatz of [k.ueberschrift, k.fokus, arbeit.titel]) {
        if (quelle || !ersatz) break;
        quelle = await wikipediaText(String(ersatz).split(/[:–—,]/)[0].trim());
        if (quelle) console.log(`    Ersatzquelle gefunden: „${quelle.titel}“`);
      }
      if (!quelle) {
        k.versuche = (k.versuche || 0) + 1;
        if (k.versuche >= 3) {
          k.fehlgeschlagen = true;
          console.warn(`  Kapitel „${k.ueberschrift}“ endgültig übersprungen: keine Quelle gefunden`);
        } else {
          console.warn(`  Kapitel „${k.ueberschrift}“: keine Quelle (Versuch ${k.versuche} von 3)`);
        }
      } else {
        arbeit.kapitel[offen] = await dokuKapitelSchreiben(arbeit, k, quelle, offen + 1, arbeit.kapitel.length, cfg);
        if (cfg.bilder !== false) {
          try {
            const titel = await wikipediaBild(quelle.titel);
            const weitere = await wikipediaBilder(quelle.titel, cfg.bilderProKapitel ?? 7);
            const alle = [titel, ...weitere].filter(Boolean)
              .filter((b, i, a) => b.url && a.findIndex(x => x.url === b.url) === i);
            if (alle.length) {
              arbeit.kapitel[offen].bildInfos = alle.map((b, i) => ({ ...b, art: "symbol", hinweis: "Bild aus der Wikipedia",
                bildunterschrift: i === 0 ? (arbeit.kapitel[offen].bild?.bildunterschrift || b.beschreibung || "") : (b.beschreibung || "") }));
              arbeit.kapitel[offen].bildInfo = arbeit.kapitel[offen].bildInfos[0];
              console.log(`    Bilder: ${alle.length}`);
            }
          } catch { /* ohne Bild */ }
        }
        // Ein Kapitel mit 60 Wörtern ist kein Kapitel. Lieber noch einmal schreiben lassen.
        const mindest = cfg.mindestWoerterProKapitel ?? 380;
        const w = arbeit.kapitel[offen].woerter || 0;
        if (w < mindest) {
          arbeit.kapitel[offen].zuDuenn = (arbeit.kapitel[offen].zuDuenn || 0) + 1;
          if (arbeit.kapitel[offen].zuDuenn < 3) {
            console.warn(`  Kapitel ${offen + 1}: nur ${w} Wörter (mindestens ${mindest}) – wird neu geschrieben.`);
            arbeit.kapitel[offen] = { ...k, zuDuenn: arbeit.kapitel[offen].zuDuenn };  // Text verwerfen
          } else {
            console.warn(`  Kapitel ${offen + 1}: bleibt bei ${w} Wörtern, mehr gibt die Quelle nicht her.`);
          }
        } else {
          console.log(`  Kapitel ${offen + 1}/${arbeit.kapitel.length}: ${arbeit.kapitel[offen].ueberschrift} (${w} Wörter)`);
        }
      }
      etwasGetan = true;
    }
  }

  // Alles geschrieben? Dann ist die Doku fertig und kommt in die App.
  const geschrieben = arbeit.kapitel.filter(k => k.absaetze?.length);
  const nochOffen = arbeit.kapitel.some(k => !k.absaetze?.length && !k.fehlgeschlagen);
  const anteil = geschrieben.length / Math.max(1, arbeit.kapitel.length);
  const gesamtWoerter = geschrieben.reduce((a, k) => a + (k.woerter || 0), 0);
  // Eine Doku erscheint erst, wenn sie wirklich eine ist: mindestens drei Viertel
  // der geplanten Kapitel und genug Text für eine halbe Stunde.
  const reichtAus = anteil >= (cfg.mindestAnteil ?? 0.75) && gesamtWoerter >= (cfg.mindestWoerter ?? 2500);
  if (!nochOffen && geschrieben.length && !reichtAus) {
    console.warn(`  Doku „${arbeit.titel}“ zu dünn (${geschrieben.length}/${arbeit.kapitel.length} Kapitel, `
      + `${gesamtWoerter} Wörter) – gescheiterte Kapitel werden noch einmal versucht.`);
    for (const k of arbeit.kapitel) if (k.fehlgeschlagen && !k.absaetze?.length) { k.fehlgeschlagen = false; k.versuche = 0; }
  }
  if (!nochOffen && geschrieben.length && reichtAus) {
    const gesehen = new Set();
    for (const k of geschrieben) {
      k.bildInfos = (k.bildInfos || []).filter(b => b?.url && !gesehen.has(b.url) && gesehen.add(b.url));
      k.bildInfo = k.bildInfos[0] || k.bildInfo;
    }
    const doku = {
      id: arbeit.id, titel: arbeit.titel, untertitel: arbeit.untertitel, bereich: arbeit.bereich,
      zeit: jetzt.toISOString(), kapitel: geschrieben,
      woerter: geschrieben.reduce((a, k) => a + (k.woerter || 0), 0),
      bildInfo: geschrieben.find(k => k.bildInfo)?.bildInfo,
      bilderGesamt: geschrieben.reduce((a, k) => a + (k.bildInfos?.length || 0), 0),
      quellen: [...new Map(geschrieben.map(k => [k.quelle.url, k.quelle])).values()]
    };
    doku.dauerMinuten = Math.round(doku.woerter / 140);
    console.log(`★ Doku fertig: ${doku.titel} – ${geschrieben.length} Kapitel, ${doku.woerter} Wörter, etwa ${doku.dauerMinuten} Minuten`);
    await fs.writeFile(datei, JSON.stringify({ stand: jetzt.toISOString(), inArbeit: null,
      fertig: [doku, ...fertig].slice(0, cfg.behalten ?? 12) }, null, 1));
    return doku;
  }
  if (etwasGetan) {
    const offen = arbeit.kapitel.filter(k => !k.absaetze?.length && !k.fehlgeschlagen).length;
    console.log(`  Vorproduktion läuft: noch ${offen} Kapitel offen.`);
    await fs.writeFile(datei, JSON.stringify({ stand: jetzt.toISOString(), inArbeit: arbeit, fertig }, null, 1));
  }
  return null;
}

// ---------- Wetter (Open-Meteo, Daten vom Deutschen Wetterdienst – kostenlos, ohne Schlüssel) ----------
// Reine Messdaten: hier rechnet keine KI mit, der Text wird aus den Zahlen gebaut.
const WETTER_ORTE = [
  { name: "Hamburg", lat: 53.55, lon: 9.99, teil: "Norden" },
  { name: "Berlin", lat: 52.52, lon: 13.40, teil: "Osten" },
  { name: "Leipzig", lat: 51.34, lon: 12.37, teil: "Osten" },
  { name: "Köln", lat: 50.94, lon: 6.96, teil: "Westen" },
  { name: "Frankfurt", lat: 50.11, lon: 8.68, teil: "Westen" },
  { name: "Stuttgart", lat: 48.78, lon: 9.18, teil: "Süden" },
  { name: "München", lat: 48.14, lon: 11.58, teil: "Süden" }
];
const WETTER_WORT = { 0:"klar", 1:"meist klar", 2:"teils bewölkt", 3:"bewölkt", 45:"neblig", 48:"neblig",
  51:"leichter Nieselregen", 53:"Nieselregen", 55:"starker Nieselregen", 56:"gefrierender Nieselregen", 57:"gefrierender Nieselregen",
  61:"leichter Regen", 63:"Regen", 65:"starker Regen", 66:"gefrierender Regen", 67:"gefrierender Regen",
  71:"leichter Schneefall", 73:"Schneefall", 75:"starker Schneefall", 77:"Schneegriesel",
  80:"Regenschauer", 81:"Regenschauer", 82:"kräftige Schauer", 85:"Schneeschauer", 86:"Schneeschauer",
  95:"Gewitter", 96:"Gewitter mit Hagel", 99:"Gewitter mit Hagel" };
export const wetterWort = c => WETTER_WORT[c] || "wechselhaft";
const haeufigstes = liste => {
  const z = new Map();
  liste.forEach(c => z.set(c, (z.get(c) || 0) + 1));
  return [...z.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};
export function wetterText(orte, morgenTag) {
  if (!orte.length) return [];
  const heuteMax = orte.map(o => o.heute.max), morgenMax = orte.map(o => o.morgen.max);
  const waermste = orte.slice().sort((a, b) => b.morgen.max - a.morgen.max)[0];
  const gruppe = teil => orte.filter(o => o.teil === teil);
  const wort = liste => wetterWort(haeufigstes(liste.map(o => o.morgen.code)));
  const nord = wort(gruppe("Norden").concat(gruppe("Osten")));
  const sued = wort(gruppe("Süden").concat(gruppe("Westen")));
  const t = [];
  t.push(`Heute liegen die Höchstwerte zwischen ${Math.min(...heuteMax)} und ${Math.max(...heuteMax)} Grad.`);
  t.push(nord === sued
    ? `Die Vorhersage für morgen, ${morgenTag}, im ganzen Land: ${nord}.`
    : `Die Vorhersage für morgen, ${morgenTag}: im Norden und Osten ${nord}, im Süden und Westen ${sued}.`);
  t.push(`Die Temperaturen erreichen dann ${Math.min(...morgenMax)} bis ${Math.max(...morgenMax)} Grad.`);
  t.push(`Am wärmsten wird es in ${waermste.name} mit ${waermste.morgen.max} Grad.`);
  t.push("Die Daten kommen vom Deutschen Wetterdienst.");
  return t;
}
async function wetterHolen(jetzt) {
  const url = "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
    latitude: WETTER_ORTE.map(o => o.lat).join(","),
    longitude: WETTER_ORTE.map(o => o.lon).join(","),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset",
    current: "temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m",
    timezone: "Europe/Berlin", forecast_days: "7"
  });
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("Wetterdienst antwortet nicht (" + r.status + ")");
  const roh = await r.json();
  const liste = Array.isArray(roh) ? roh : [roh];
  const orte = WETTER_ORTE.map((o, i) => {
    const d = liste[i]?.daily;
    if (!d || !d.temperature_2m_max) return null;
    const tag = k => ({
      datum: d.time?.[k],
      code: d.weather_code[k],
      max: Math.round(d.temperature_2m_max[k]),
      min: Math.round(d.temperature_2m_min[k]),
      regen: d.precipitation_probability_max?.[k] == null ? null : Math.round(d.precipitation_probability_max[k]),
      wind: d.wind_speed_10m_max?.[k] == null ? null : Math.round(d.wind_speed_10m_max[k]),
      auf: (d.sunrise?.[k] || "").slice(11, 16), unter: (d.sunset?.[k] || "").slice(11, 16)
    });
    const c = liste[i]?.current;
    const jetztWert = c ? { grad: Math.round(c.temperature_2m), code: c.weather_code,
      wind: Math.round(c.wind_speed_10m || 0), feuchte: Math.round(c.relative_humidity_2m || 0) } : null;
    const tage = d.time ? d.time.map((_, k) => tag(k)) : [tag(0), tag(1)];
    return { ...o, jetzt: jetztWert, heute: tag(0), morgen: tag(1), tage };
  }).filter(Boolean);
  if (orte.length < 3) throw new Error("zu wenige Messwerte");
  const morgen = new Date(+jetzt + 24 * 36e5);
  const morgenTag = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", weekday: "long" }).format(morgen);
  let modelle = null;
  try { modelle = await wetterModelle(morgenTag); } catch (e) { console.warn("  Modellvergleich: " + e.message); }
  return { stand: jetzt.toISOString(), morgenTag, orte, text: wetterText(orte, morgenTag),
    modelle, quelle: "Open-Meteo / Deutscher Wetterdienst" };
}

// Verschiedene Wetterdienste rechnen mit verschiedenen Modellen - und sind sich oft
// uneinig. Normale Wetter-Apps zeigen eine Zahl und tun so, als waere sie sicher.
// Hier steht daneben, wo die Modelle auseinandergehen. Dieselbe Idee wie beim Medienvergleich.
const WETTER_MODELLE = [
  { schluessel: "icon_seamless",  name: "ICON",   heim: "Deutscher Wetterdienst" },
  { schluessel: "gfs_seamless",   name: "GFS",    heim: "USA" },
  { schluessel: "ecmwf_ifs025",   name: "ECMWF",  heim: "Europa" }
];
async function wetterModelle(morgenTag) {
  const url = "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
    latitude: WETTER_ORTE.map(o => o.lat).join(","),
    longitude: WETTER_ORTE.map(o => o.lon).join(","),
    daily: "temperature_2m_max,precipitation_sum",
    models: WETTER_MODELLE.map(m => m.schluessel).join(","),
    timezone: "Europe/Berlin", forecast_days: "2"
  });
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const liste = (x => Array.isArray(x) ? x : [x])(await r.json());

  const orte = [];
  for (let i = 0; i < WETTER_ORTE.length; i++) {
    const d = liste[i]?.daily; if (!d) continue;
    // Die Feldnamen selbst aus der Antwort lesen, statt sie zu raten - so bleibt
    // es heil, falls Open-Meteo die Benennung einmal ändert.
    const je = Object.keys(d)
      .filter(k => k.startsWith("temperature_2m_max") && Array.isArray(d[k]) && d[k][1] != null)
      .map(k => {
        const kuerzel = k.replace(/^temperature_2m_max_?/, "") || "standard";
        const bekannt = WETTER_MODELLE.find(m => m.schluessel === kuerzel);
        const n = d["precipitation_sum_" + kuerzel] || d.precipitation_sum;
        return { name: bekannt ? bekannt.name : kuerzel.replace(/_seamless|_ifs\d*/g, "").toUpperCase(),
                 heim: bekannt ? bekannt.heim : "",
                 grad: Math.round(d[k][1]),
                 regen: n?.[1] == null ? null : Math.round(n[1] * 10) / 10 };
      });
    if (je.length >= 2) orte.push({ name: WETTER_ORTE[i].name, je });
  }
  if (!orte.length) throw new Error("keine Modelldaten");

  // Wo gehen sie am weitesten auseinander?
  let spanneGrad = 0, wo = null, nassUneinig = null;
  for (const o of orte) {
    const g = o.je.map(x => x.grad);
    const spanne = Math.max(...g) - Math.min(...g);
    if (spanne > spanneGrad) { spanneGrad = spanne; wo = o; }
    const regen = o.je.filter(x => x.regen != null);
    if (regen.length >= 2 && !nassUneinig) {
      const nass = regen.filter(x => x.regen >= 1).map(x => x.name);
      const trocken = regen.filter(x => x.regen < 1).map(x => x.name);
      if (nass.length && trocken.length) nassUneinig = { ort: o.name, nass, trocken };
    }
  }
  const saetze = [];
  if (spanneGrad <= 1) {
    saetze.push(`Die Wettermodelle sind sich für morgen weitgehend einig: hoechstens ein Grad Unterschied.`);
  } else if (wo) {
    const g = wo.je.map(x => x.grad);
    saetze.push(`Für ${wo.name} gehen die Modelle am weitesten auseinander: zwischen ${Math.min(...g)} und ${Math.max(...g)} Grad.`);
  }
  if (nassUneinig) {
    saetze.push(`Und in ${nassUneinig.ort} erwartet ${nassUneinig.nass.join(" und ")} Regen, `
      + `${nassUneinig.trocken.join(" und ")} dagegen nicht.`);
  }
  console.log(`  Modellvergleich: ${orte.length} Orte, groesste Spanne ${spanneGrad} Grad`);
  return { tag: morgenTag, orte, spanneGrad, uneinigRegen: nassUneinig, saetze,
    dienste: WETTER_MODELLE.map(m => `${m.name} (${m.heim})`) };
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

// ---------- Podcast-Feed ----------
// Die fertigen Folgen liegen schon als MP3 im Ton-Zweig. Diese Datei macht sie
// in Spotify, Apple Podcasts und jeder anderen Podcast-App abonnierbar.
const xmlSicher = t => String(t == null ? "" : t)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/\u0000-\u0008\u000b\u000c\u000e-\u001f/g, "");
const rfc822 = d => {
  const t = new Date(d);
  return isNaN(t) ? new Date().toUTCString() : t.toUTCString();
};
const hhmmss = sek => {
  const s = Math.max(0, Math.round(Number(sek) || 0));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map(x => String(x).padStart(2, "0")).join(":");
};

export function feedBauen(folgen, opt) {
  const { seite, tonBasis, titel, beschreibung, autor, bild, stand } = opt;
  const eintraege = (folgen || []).filter(f => f && f.d && f.b).map(f => `  <item>
    <title>${xmlSicher(f.titel)}</title>
    <description>${xmlSicher(f.text || f.titel)}</description>
    <itunes:summary>${xmlSicher(f.text || f.titel)}</itunes:summary>
    <pubDate>${rfc822(f.zeit)}</pubDate>
    <guid isPermaLink="false">${xmlSicher(f.id)}</guid>
    <enclosure url="${xmlSicher(tonBasis + f.d)}" length="${Math.round(f.b)}" type="audio/mpeg"/>
    <itunes:duration>${hhmmss(f.l)}</itunes:duration>
    <itunes:explicit>false</itunes:explicit>
    ${seite ? `<link>${xmlSicher(seite)}</link>` : ""}
  </item>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${xmlSicher(titel)}</title>
  <description>${xmlSicher(beschreibung)}</description>
  <language>de-de</language>
  <lastBuildDate>${rfc822(stand)}</lastBuildDate>
  <generator>Nachrichten-Heft</generator>
  ${seite ? `<link>${xmlSicher(seite)}</link>
  <atom:link href="${xmlSicher(seite + "/feed.xml")}" rel="self" type="application/rss+xml"/>` : ""}
  <itunes:author>${xmlSicher(autor)}</itunes:author>
  <itunes:summary>${xmlSicher(beschreibung)}</itunes:summary>
  <itunes:explicit>false</itunes:explicit>
  <itunes:type>episodic</itunes:type>
  <itunes:category text="News"/>
  ${bild ? `<itunes:image href="${xmlSicher(bild)}"/>
  <image><url>${xmlSicher(bild)}</url><title>${xmlSicher(titel)}</title>${seite ? `<link>${xmlSicher(seite)}</link>` : ""}</image>` : ""}
${eintraege}
</channel>
</rss>
`;
}

async function feedSchreiben(jetzt) {
  // Zwei Quellen: die aus den Sendungen zusammengebauten Folgen (ton.py)
  // und die Gespräche (podcast.py). Beide landen im selben Feed.
  const a = await leseJson(new URL("data/podcast.json", ROOT), null);
  const b = await leseJson(new URL("data/gespraeche.json", ROOT), null);
  const alle = [...(a?.folgen || []), ...(b?.folgen || [])]
    .filter(f => f && f.d && f.b)
    .sort((x, y) => String(y.zeit || "").localeCompare(String(x.zeit || "")))
    .slice(0, 12);
  const daten = { folgen: alle };
  if (!daten.folgen.length) { console.log("Podcast: noch keine Folgen."); return; }
  const repo = process.env.GITHUB_REPOSITORY || "";
  const seite = (process.env.SITE_URL || "").replace(/\/$/, "");
  if (!repo) { console.warn("Podcast: GITHUB_REPOSITORY fehlt – kein Feed."); return; }
  const xml = feedBauen(daten.folgen, {
    seite: seite ? seite + "/data" : "", tonBasis: `https://raw.githubusercontent.com/${repo}/ton/`,
    titel: "Nachrichten-Heft · neutral",
    beschreibung: "Nachrichten, die erst dann hier landen, wenn mehrere unabhängige Medien sie berichten. "
      + "Zusammengefasst von einer KI, jede Angabe mit Quelle. Dazu erklärende Stücke und lange Dokumentationen. "
      + "Ein Schulprojekt für Gemeinschaftskunde.",
    autor: "Nachrichten-Heft",
    bild: seite ? seite + "/icon-512.png" : "",
    stand: jetzt.toISOString()
  });
  await fs.writeFile(new URL("data/feed.xml", ROOT), xml);
  console.log(`Podcast-Feed geschrieben: ${daten.folgen.length} Folgen`);
}

// ---------- Wochenrückblick ----------
async function wochenrueckblick(jetzt, aktive, force) {
  const datei = new URL("data/woche.json", ROOT);
  const alt = await leseJson(datei, null);
  const wochentag = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", weekday: "short" }).format(jetzt);
  const alter = alt ? (jetzt - new Date(alt.erstellt)) / 36e5 : Infinity;
  // Der Rückblick entsteht nur sonntags – unter der Woche wiederholt er nur, was ohnehin in der App steht.
  if (!force && !(wochentag.startsWith("So") && alter > 20)) return;
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

// ---------- Handy-Mitteilungen über den eigenen Briefkasten (Web Push) ----------
async function webPush(neue) {
  const url = process.env.PUSH_URL, token = process.env.PUSH_TOKEN;
  const oeffentlich = process.env.VAPID_PUBLIC, geheim = process.env.VAPID_PRIVATE;
  if (!url || !token || !oeffentlich || !geheim || !neue.length) return;
  let wp;
  try { wp = (await import("web-push")).default; }
  catch { return console.log("web-push nicht installiert – überspringe Handy-Mitteilungen."); }
  wp.setVapidDetails(process.env.PUSH_KONTAKT || "mailto:heft@example.org", oeffentlich, geheim);
  let abos = [];
  try {
    const r = await fetch(url.replace(/\/$/, "") + "/liste", { headers: { authorization: "Bearer " + token } });
    abos = r.ok ? await r.json() : [];
  } catch (e) { return console.warn("Abo-Liste nicht erreichbar: " + e.message); }
  if (!abos.length) return console.log("Noch niemand für Mitteilungen angemeldet.");
  const seite = (process.env.SITE_URL || "").replace(/\/$/, "");
  const kaputt = [];
  let gesendet = 0;
  for (const n of neue) {
    const inhalt = JSON.stringify({
      titel: (n.eil ? "Eilmeldung: " : n.rubrik + ": ") + n.titel,
      text: n.vorspann, id: n.id, eil: !!n.eil, url: seite ? `${seite}/#/n/${n.id}` : "./"
    });
    for (const a of abos) {
      // wer Rubriken gewählt hat, bekommt nur diese; Eilmeldungen gehen an alle
      if (!n.eil && a.rubriken?.length && !a.rubriken.includes(n.rubrik)) continue;
      try { await wp.sendNotification(a.abo, inhalt); gesendet++; }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) kaputt.push(a.id); }
    }
  }
  if (kaputt.length) {
    try { await fetch(url.replace(/\/$/, "") + "/loeschen", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ ids: kaputt }) }); } catch {}
  }
  console.log(`Handy-Mitteilungen: ${gesendet} verschickt an ${abos.length} Geräte${kaputt.length ? `, ${kaputt.length} veraltete gelöscht` : ""}.`);
}

const rubrikSlug = r => String(r).toLowerCase().replace(/ & /g, "-").replace(/[^a-zäöü-]/g, "").replace(/ä/g,"ae").replace(/ö/g,"oe").replace(/ü/g,"ue");
async function pushSenden(n, nurRubrik = false) {
  const basis = process.env.NTFY_TOPIC;
  if (!basis) return console.log("Kein NTFY_TOPIC gesetzt – keine Push-Nachricht.");
  const headers = { "content-type": "application/json" };
  if (process.env.NTFY_TOKEN) headers.authorization = "Bearer " + process.env.NTFY_TOKEN;
  const seite = process.env.SITE_URL ? `${process.env.SITE_URL.replace(/\/$/, "")}/#/n/${n.id}` : undefined;
  // Eilmeldungen laufen auf den Hauptkanal UND auf einen reinen Eil-Kanal,
  // damit man auch nur die wirklich wichtigen Meldungen abonnieren kann.
  const kanaele = nurRubrik ? [`${basis}-${rubrikSlug(n.rubrik)}`] : [basis, `${basis}-eil`];
  for (const topic of kanaele) {
    const r = await fetch(CFG.ntfyServer, {
      method: "POST", headers,
      body: JSON.stringify({ topic, title: (nurRubrik ? n.rubrik + ": " : "EILMELDUNG: ") + n.titel, message: n.vorspann,
        priority: nurRubrik ? 3 : 5, tags: [nurRubrik ? "newspaper" : "rotating_light"], click: seite })
    });
    console.log(r.ok ? `Push (${topic}): ${n.titel}` : `Push fehlgeschlagen (${topic}, ${r.status})`);
  }
}

// ---------- Hauptprogramm ----------
let CFG;
export const konfigSetzen = c => { CFG = c; };   // wird von main gesetzt, für Tests auch von außen
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
  let themen = [];
  try {
    ({ themen = [] } = await themenFinden(artikel, bestehende));
  } catch (e) {
    console.warn(`Themen finden fehlgeschlagen: ${e.message}`);
    console.warn("Diesmal keine neuen Themen – Wetter, Aufräumen und Speichern laufen trotzdem.");
  }
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
    // Ein Teil des Kontingents bleibt für „Warum eigentlich?“ und die Doku reserviert –
    // sonst fressen die Nachrichten jeden Lauf alles auf und die Doku kommt nie voran.
    if (kiBudgetRest() <= (CFG.reserveFuerWissenUndDoku ?? 5)) {
      console.warn(`KI-Budget für die Nachrichten aufgebraucht (${kiVerbrauch()} Anfragen) – der Rest ist für Wissen und Doku reserviert.`);
      break;
    }

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
      let geprueft = false, korrekturen = [], lernen, einfach, video, kurz, fakten, dossier;
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
          kurz = kurzPruefen(pr.kurz);
          fakten = faktenPruefen(pr.fakten);
          dossier = dossierPruefen(pr.dossier);
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
      if (CFG.bilder !== false && bildInfos.length < 3) {
        const kandidaten = [];
        for (const b of (entwurf.bilder || []).slice(0, 5)) {
          if (kandidaten.length >= 12) break;
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
        geprueft, korrekturen, wortwarnung, lernen, einfach, video, kurz, fakten,
        dossier: dossier || altesThema?.dossier, bildInfo, bildInfos, ortInfo, version: TEXT_VERSION
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

  // Kein Foto zweimal: was ein Thema schon zeigt, bekommt kein zweites
  const bilderEntdoppeln = liste => {
    const benutzt = new Set();
    let entfernt = 0;
    for (const n of [...liste].sort((a, b) => (b.eil - a.eil) || b.zeit.localeCompare(a.zeit))) {
      const behalten = [];
      for (const b of n.bildInfos || []) {
        if (!b?.url || benutzt.has(b.url)) { entfernt++; continue; }
        benutzt.add(b.url);
        behalten.push(b);
      }
      n.bildInfos = behalten;
      n.bildInfo = behalten[0];
    }
    if (entfernt) console.log(`Doppelte Fotos entfernt: ${entfernt}`);
  };
  bilderEntdoppeln([...ergebnis.values()]);

  let wetter = alt.wetter;
  if (CFG.wetter !== false) {
    try { wetter = await wetterHolen(jetzt); console.log(`Wetter: ${wetter.orte.length} Orte, morgen ${wetter.morgenTag}`); }
    catch (e) { console.warn("Wetter nicht abrufbar: " + e.message); }
  }

  if (CFG.wissen?.aktiv !== false) {
    try { await wissenErzeugen(jetzt, CFG.wissen || {}); }
    catch (e) { console.warn("Wissensstück nicht erstellt: " + e.message); }
  }
  if (CFG.doku?.aktiv !== false && kiBudgetFrei()) {
    try { await dokuArbeiten(jetzt, CFG.doku || {}); }
    catch (e) { console.warn("Doku-Vorproduktion: " + e.message); }
  }

  const { aktiv: nachrichten, alt: altListe } = aufraeumen([...ergebnis.values()], jetzt, CFG);
  const imArchiv = await archivieren(altListe, nachrichten, jetzt, CFG);
  await ausgabeSpeichern(jetzt, nachrichten);
  await wochenrueckblick(jetzt, nachrichten, !!process.env.FORCE_WOCHE);
  try { await feedSchreiben(jetzt); } catch (e) { console.warn("Podcast-Feed: " + e.message); }
  if (altListe.length) console.log(`Archiviert: ${altListe.length} (Archiv gesamt: ${imArchiv})`);

  // 4. Eilmeldungen pushen (nur neue, höchstens 6 Stunden alt)
  const notified = new Set(alt.notified || []);
  for (const n of nachrichten.filter(n => n.eil && !notified.has(n.id) && jetzt - new Date(n.zeit) < 6 * 36e5)) {
    try { await pushSenden(n); } catch (e) { console.warn("Push-Fehler: " + e.message); }
    notified.add(n.id);
  }
  // Rubrik-Kanäle: neue Themen ohne Eilmeldung, damit man gezielt abonnieren kann
  for (const n of nachrichten.filter(n => !notified.has(n.id) && jetzt - new Date(n.zeit) < 4 * 36e5)) {
    try { await pushSenden(n, true); } catch (e) { console.warn("Push-Fehler: " + e.message); }
    notified.add(n.id);
  }

  // neue Themen für Handy-Mitteilungen sammeln (Eilmeldungen zuerst)
  const frischePush = nachrichten
    .filter(n => jetzt - new Date(n.zeit) < 4 * 36e5 && (n.eil || !alt.notified?.includes(n.id)))
    .filter(n => !(alt.gepusht || []).includes(n.id))
    .sort((a, b) => (b.eil - a.eil) || b.zeit.localeCompare(a.zeit))
    .slice(0, 6);
  try { await webPush(frischePush); } catch (e) { console.warn("Push-Fehler: " + e.message); }

  await fs.writeFile(DATA_FILE, JSON.stringify({
    stand: jetzt.toISOString(),
    push: process.env.PUSH_URL && process.env.VAPID_PUBLIC
      ? { url: process.env.PUSH_URL.replace(/\/$/, ""), key: process.env.VAPID_PUBLIC } : undefined,
    gepusht: [...new Set([...(alt.gepusht || []), ...frischePush.map(n => n.id)])].slice(-80),
    ntfyTopic: process.env.NTFY_TOPIC || "",
    fehlerTopic: process.env.NTFY_TOPIC ? process.env.NTFY_TOPIC + "-fehler" : "",
    notified: [...notified].filter(id => nachrichten.some(n => n.id === id)),
    wetter,
    ton: alt.ton,
    nachrichten
  }, null, 1));
  console.log(`Fertig: ${nachrichten.length} Nachrichten, ${neuGeschrieben} neu/aktualisiert.`);
  try { execSync("git add data", { cwd: new URL(".", ROOT).pathname, stdio: "ignore" }); } catch { /* lokal ohne git */ }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error("Abbruch: " + e.message); process.exit(1); });
}
