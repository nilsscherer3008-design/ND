#!/usr/bin/env python3
"""Der Debatten-Podcast des Nachrichten-Hefts.

Eigenständig: liest data/news.json, lässt die KI ein Gespräch schreiben,
spricht es mit mehreren Stimmen und legt Folge plus RSS-Datei ab.
Braucht weder update.mjs noch ton.py.

Feste Regeln, die hier im Code stehen und nicht verhandelbar sind:
  * Die Gesprächspartner sind erfundene Figuren mit erfundenen Namen.
    Echte Personen werden zitiert ("die IG Metall argumentiert"), nie gespielt.
  * Am Anfang jeder Folge wird gesagt, dass es Computerstimmen sind.
  * Jede Angabe stammt aus dem Bericht, nichts wird dazuerfunden.

Ergebnis:
  ton/folge-podcast-<id>.mp3   die Folge
  data/podcast.json            Liste der Folgen
  feed.xml                     zum Abonnieren in Spotify, Apple Podcasts …
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from email.utils import format_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATEN = ROOT / "data" / "news.json"
PODCAST = ROOT / "data" / "podcast.json"
TON = ROOT / "ton"
STIMMEN = ROOT / ".stimmen"
MODELL = "de_DE-mls-medium"

# ---------------------------------------------------------------- Besetzung
# Die Nummern stammen aus einer Messung aller Proben: Tonhöhe, Gleichmäßigkeit,
# Lautstärke und Deutlichkeit. Wer nicht gefällt, wird hier ausgetauscht.
BESETZUNG = [
    {"name": "Thorsten", "nr": 162, "rolle": "führt durch die Sendung, fasst zusammen, übergibt"},
    {"name": "Sigrid",   "nr": 153, "rolle": "ordnet ein, stellt die Gegenfrage"},
    {"name": "Malte",    "nr": 171, "rolle": "bringt Zahlen und Belege, nennt die Quellen"},
    {"name": "Nora",     "nr": 36,  "rolle": "fragt kritisch nach, benennt was offen ist"},
]
MODERATION = "Thorsten"

BEHALTEN = 8          # so viele Folgen bleiben im Feed
MAX_ZEILEN = 60
TITEL = "Nachrichten-Heft · neutral"


def log(*a):
    print(*a, flush=True)


# ------------------------------------------------------------------- KI
def ki(system, user, max_tokens=4000):
    """Fragt der Reihe nach die eingerichteten Dienste, bis einer antwortet."""
    fehler = []
    for name in ["gemini", "openai", "anthropic"]:
        try:
            antwort = _anbieter(name, system, user, max_tokens)
            if antwort:
                log(f"  Antwort von {name}")
                return antwort
        except Exception as ex:
            fehler.append(f"{name}: {ex}")
    raise RuntimeError("Kein KI-Dienst erreichbar – " + " | ".join(fehler) if fehler
                       else "Kein KI-Schlüssel hinterlegt (GEMINI_API_KEY oder OPENAI_API_KEY).")


def _post(url, kopf, koerper, zeit=120):
    daten = json.dumps(koerper).encode("utf8")
    anfrage = urllib.request.Request(url, data=daten, headers={**kopf, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(anfrage, timeout=zeit) as r:
            return json.loads(r.read().decode("utf8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode('utf8', 'ignore')[:150]}")


def _anbieter(name, system, user, max_tokens):
    if name == "gemini":
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            return None
        d = _post("https://generativelanguage.googleapis.com/v1beta/models/"
                  "gemini-2.0-flash:generateContent",
                  {"x-goog-api-key": key},
                  {"systemInstruction": {"parts": [{"text": system}]},
                   "contents": [{"role": "user", "parts": [{"text": user}]}],
                   "generationConfig": {"responseMimeType": "application/json",
                                        "maxOutputTokens": max_tokens * 2, "temperature": 0.35}})
        teile = d.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        return _json_aus("".join(t.get("text", "") for t in teile))

    if name == "openai":
        key = os.environ.get("OPENAI_API_KEY")
        if not key:
            return None
        basis = (os.environ.get("OPENAI_BASIS") or "https://api.groq.com/openai/v1").rstrip("/")
        modell = os.environ.get("OPENAI_MODELL") or "llama-3.3-70b-versatile"
        d = _post(f"{basis}/chat/completions", {"authorization": "Bearer " + key},
                  {"model": modell, "temperature": 0.35, "max_tokens": max_tokens,
                   "response_format": {"type": "json_object"},
                   "messages": [{"role": "system", "content": system},
                                {"role": "user", "content": user}]})
        return _json_aus(d["choices"][0]["message"]["content"])

    if name == "anthropic":
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            return None
        d = _post("https://api.anthropic.com/v1/messages",
                  {"x-api-key": key, "anthropic-version": "2023-06-01"},
                  {"model": "claude-sonnet-4-5", "max_tokens": max_tokens, "system": system,
                   "messages": [{"role": "user", "content": user}]})
        return _json_aus("".join(b.get("text", "") for b in d.get("content", [])))
    return None


def _json_aus(text):
    text = (text or "").strip()
    if not text:
        return None
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
    return None


# ------------------------------------------------------------- Thema finden
def thema_waehlen(daten, schon):
    """Das Thema mit den meisten Quellen, das noch keine Folge hatte."""
    passend = []
    for n in daten.get("nachrichten", []):
        if n.get("id") in schon:
            continue
        if len(n.get("medien") or []) < 2:
            continue
        if not (n.get("unklar") or n.get("positionen")):
            continue          # ohne Streitpunkt gibt es nichts zu besprechen
        passend.append(n)
    if not passend:
        return None
    passend.sort(key=lambda n: (len(n.get("medien") or []), n.get("zeit") or ""), reverse=True)
    return passend[0]


# ------------------------------------------------------------ Skript
REGELN = """Du schreibst Gespräche für einen deutschen Nachrichten-Podcast.

UNUMSTÖSSLICH:
- Jede Angabe – jede Zahl, jeder Name, jedes Zitat – muss in der Vorlage stehen.
  Nichts aus eigenem Wissen ergänzen. Im Zweifel weglassen.
- Die Sprecher sind erfundene Figuren der Sendung. Echte Personen und Organisationen
  werden zitiert ("die IG Metall fordert"), aber NIE gespielt. Niemals einer echten
  Person Worte in den Mund legen, die sie nicht gesagt hat.
- Positionen werden fair wiedergegeben. Beide Seiten kommen zu Wort. Keine Sprecherfigur
  bewertet, wer recht hat.
- Was offen oder umstritten ist, wird als offen benannt.

STIL:
- Gesprochene Sprache, kurze Sätze. Wie Menschen wirklich reden.
- Einwürfe und Nachfragen sind erwünscht, auch mal ein halber Satz.
- Keine Ausrufezeichen, keine Werbesprache, keine Anrede ans Publikum außer am Anfang.
- Zahlen ausgeschrieben, damit die Sprachausgabe sie richtig liest."""


def skript_schreiben(thema, besetzung):
    wer = "\n".join(f"- {h['name']}: {h['rolle']}" for h in besetzung)
    namen = ", ".join(h["name"] for h in besetzung)
    medien = ", ".join(m.get("name", "") for m in (thema.get("medien") or []) if m.get("name"))
    einig = [e[0] if isinstance(e, list) else e for e in (thema.get("einig") or [])]
    positionen = [f"{p[0]}: {p[1]}" for p in (thema.get("positionen") or []) if isinstance(p, list) and len(p) >= 2]

    vorlage = json.dumps({
        "titel": thema.get("titel"),
        "vorspann": thema.get("vorspann"),
        "zusammenfassung": thema.get("zusammenfassung"),
        "worin_einig": einig,
        "positionen": positionen,
        "noch_offen": thema.get("unklar"),
        "zahlen": thema.get("fakten"),
        "zeitleiste": thema.get("zeitleiste"),
        "medien": medien,
    }, ensure_ascii=False)[:11000]

    auftrag = f"""Hier ist die Vorlage – ein aus mehreren Medien zusammengetragener Bericht:

{vorlage}

Schreibe daraus ein Podcast-Gespräch von acht bis zwölf Minuten.

Die Sprecher (nur diese, keine anderen):
{wer}

{MODERATION} eröffnet und schließt die Sendung.

AUFBAU:
1. {MODERATION} begrüßt, nennt das Thema und sagt WÖRTLICH in einem eigenen Satz,
   dass alle Stimmen dieser Sendung Computerstimmen sind.
2. {MODERATION} stellt die anderen mit Namen vor.
3. Worum geht es – kurz und konkret.
4. Worin sich die Berichte decken.
5. Die Positionen, je eine pro Sprecher vorgetragen, fair und mit Quelle.
6. Nachfragen und Widerspruch untereinander.
7. Was offen bleibt.
8. {MODERATION} schließt ab.

NAMEN NENNEN: bei der Vorstellung, bei der ersten Übergabe an jeden
("Sigrid, wie siehst du das?"), bei Themenwechseln ("Damit zu Malte")
und beim Rückbezug ("wie Nora eben sagte"). NICHT bei jedem Sprecherwechsel.

Antworte NUR mit JSON:
{{"titel": "Überschrift der Folge, höchstens zehn Wörter",
  "beschreibung": "zwei Sätze für die Podcast-App",
  "zeilen": [{{"wer": "einer von: {namen}", "text": "was diese Person sagt, ein bis drei Sätze"}}]}}"""
    return ki(REGELN, auftrag, 6000)


def _zeilen_finden(roh):
    """Die KI nennt die Liste mal zeilen, mal dialog, mal skript – alle akzeptieren."""
    if isinstance(roh, list):
        return roh
    if not isinstance(roh, dict):
        return []
    for k in ("zeilen", "dialog", "gespraech", "gespräch", "skript", "script", "lines", "turns"):
        if isinstance(roh.get(k), list):
            return roh[k]
    for v in roh.values():                      # eine Ebene tiefer suchen
        if isinstance(v, dict):
            tiefer = _zeilen_finden(v)
            if tiefer:
                return tiefer
    return []


def _wer_finden(z, erlaubt):
    """Erlaubt 'Thorsten', 'thorsten:', 'Sprecher Thorsten', 'Thorsten (Moderation)'."""
    for k in ("wer", "sprecher", "name", "speaker", "rolle", "von"):
        roh = z.get(k)
        if not roh:
            continue
        text = str(roh).strip()
        for name in erlaubt:
            if re.search(r"\b" + re.escape(name) + r"\b", text, re.I):
                return name
    return None


def skript_pruefen(roh, besetzung):
    """Nur erlaubte Sprecher, sinnvolle Länge, Computerstimmen-Hinweis vorhanden.
    Gibt bei Ablehnung den Grund mit zurück, damit man im Protokoll sieht warum."""
    liste = _zeilen_finden(roh)
    if not liste:
        return None, f"keine Zeilen gefunden (Antwort war: {str(roh)[:120]})"
    erlaubt = {h["name"] for h in besetzung}
    zeilen, fremd, kurz = [], set(), 0
    for z in liste:
        if isinstance(z, str):                  # "Thorsten: Guten Abend."
            teil = z.split(":", 1)
            z = {"wer": teil[0], "text": teil[1]} if len(teil) == 2 else {"text": z}
        if not isinstance(z, dict):
            continue
        wer = _wer_finden(z, erlaubt)
        text = " ".join(str(z.get("text") or z.get("satz") or z.get("inhalt") or "").split())
        if not wer:
            fremd.add(str(z.get("wer") or z.get("sprecher") or "?")[:40])
            continue
        if len(text) < 8:
            kurz += 1
            continue
        zeilen.append({"wer": wer, "text": text[:700]})
        if len(zeilen) >= MAX_ZEILEN:
            break
    if len(zeilen) < 6:
        return None, (f"nur {len(zeilen)} brauchbare Zeilen"
                      + (f", fremde Sprecher: {', '.join(list(fremd)[:4])}" if fremd else "")
                      + (f", {kurz} zu kurz" if kurz else ""))
    if len({z["wer"] for z in zeilen}) < 2:
        return None, "nur ein Sprecher im ganzen Gespräch"
    if fremd:
        log(f"  Hinweis: {len(fremd)} fremde Sprecher übersprungen ({', '.join(list(fremd)[:3])})")

    # Der Hinweis auf die Computerstimmen ist Pflicht. Fehlt er, setzen wir ihn selbst.
    anfang = " ".join(z["text"] for z in zeilen[:4]).lower()
    if "computerstimme" not in anfang and "künstliche" not in anfang:
        zeilen.insert(1, {"wer": zeilen[0]["wer"],
                          "text": "Ein Hinweis vorweg: Alle Stimmen in dieser Sendung sind "
                                  "Computerstimmen. Die Personen, die hier sprechen, gibt es nicht."})
    woerter = sum(len(z["text"].split()) for z in zeilen)
    kopf = roh if isinstance(roh, dict) else {}
    return {"titel": str(kopf.get("titel") or kopf.get("title") or "")[:120],
            "beschreibung": str(kopf.get("beschreibung") or kopf.get("description") or "")[:600],
            "zeilen": zeilen, "woerter": woerter}, None


# ------------------------------------------------------------- Sprechen
def lade_stimme():
    from piper import PiperVoice
    from piper.download_voices import download_voice
    STIMMEN.mkdir(parents=True, exist_ok=True)
    modell = STIMMEN / f"{MODELL}.onnx"
    if not modell.exists():
        log(f"Lade Stimme {MODELL} …")
        download_voice(MODELL, STIMMEN)
    return PiperVoice.load(modell)


def sprechbar(text):
    t = str(text)
    for a, b in [("–", ","), ("—", ","), ("…", "."), ("„", ""), ("“", ""), ("”", ""),
                 ("»", ""), ("«", ""), ('"', ""), ("%", " Prozent"), ("&", " und ")]:
        t = t.replace(a, b)
    t = re.sub(r"\s+", " ", t).strip()
    if t and t[-1] not in ".!?:,":
        t += "."
    return t


def gespraech_sprechen(voice, skript, besetzung, ziel, frist):
    """Jede Zeile mit der Stimme ihrer Figur, kurze Pause beim Sprecherwechsel."""
    from piper.config import SynthesisConfig
    nummer = {h["name"]: h["nr"] for h in besetzung}
    rate = voice.config.sample_rate
    grund = getattr(voice.config, "length_scale", 1.0) or 1.0
    stuecke = [b"\x00\x00" * int(rate * 0.3)]
    proben = int(rate * 0.3)
    marken = []
    letzter = None
    for i, z in enumerate(skript["zeilen"]):
        if time.time() > frist:
            log(f"  Zeit reicht nur für {i} von {len(skript['zeilen'])} Zeilen.")
            break
        conf = SynthesisConfig(length_scale=grund * 1.0, noise_scale=0.667, noise_w_scale=0.8,
                               normalize_audio=True, speaker_id=nummer[z["wer"]])
        marken.append({"s": round(proben / rate, 2), "wer": z["wer"], "text": z["text"]})
        roh = b"".join(c.audio_int16_bytes for c in voice.synthesize(sprechbar(z["text"]), conf))
        stuecke.append(roh)
        proben += len(roh) // 2
        pause = 0.42 if z["wer"] != letzter else 0.26
        if z["text"].rstrip().endswith("?"):
            pause += 0.12
        stuecke.append(b"\x00\x00" * int(rate * pause))
        proben += int(rate * pause)
        letzter = z["wer"]
    if len(marken) < 6:
        return None
    p = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "s16le", "-ar", str(rate), "-ac", "1",
         "-i", "pipe:0",
         "-af", "highpass=f=80,acompressor=threshold=-20dB:ratio=3:attack=8:release=180,"
                "loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.97",
         "-c:a", "libmp3lame", "-b:a", "64k", str(ziel)],
        input=b"".join(stuecke), capture_output=True, timeout=600)
    if p.returncode != 0 or not ziel.exists():
        log("  ffmpeg: " + p.stderr.decode("utf8", "ignore")[:200])
        return None
    return {"d": ziel.name, "l": round(proben / rate, 2), "b": ziel.stat().st_size, "marken": marken}


# ------------------------------------------------------------------ Feed
def xml_sicher(t):
    return (str(t if t is not None else "")
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))


def hhmmss(sek):
    s = max(0, int(round(float(sek or 0))))
    return f"{s // 3600:02d}:{s // 60 % 60:02d}:{s % 60:02d}"


def feed_schreiben(folgen, seite, ton_basis):
    def datum(z):
        try:
            return format_datetime(datetime.fromisoformat(str(z).replace("Z", "+00:00")))
        except Exception:
            return format_datetime(datetime.now(timezone.utc))

    eintraege = "\n".join(f"""  <item>
    <title>{xml_sicher(f.get('titel'))}</title>
    <description>{xml_sicher(f.get('text') or f.get('titel'))}</description>
    <itunes:summary>{xml_sicher(f.get('text') or f.get('titel'))}</itunes:summary>
    <pubDate>{datum(f.get('zeit'))}</pubDate>
    <guid isPermaLink="false">{xml_sicher(f.get('id'))}</guid>
    <enclosure url="{xml_sicher(ton_basis + f['d'])}" length="{int(f.get('b') or 0)}" type="audio/mpeg"/>
    <itunes:duration>{hhmmss(f.get('l'))}</itunes:duration>
    <itunes:explicit>false</itunes:explicit>
  </item>""" for f in folgen if f.get("d") and f.get("b"))

    beschreibung = ("Ein Thema, mehrere Stimmen: Worin sich die Medien einig sind und wo sie "
                    "auseinandergehen. Alle Sprecher sind Computerstimmen, alle Angaben stammen "
                    "aus den verlinkten Berichten. Ein Schulprojekt für Gemeinschaftskunde.")
    bild = f"{seite}/icon-512.png" if seite else ""
    (ROOT / "feed.xml").write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>{xml_sicher(TITEL)}</title>
  <description>{xml_sicher(beschreibung)}</description>
  <language>de-de</language>
  <lastBuildDate>{format_datetime(datetime.now(timezone.utc))}</lastBuildDate>
  {f'<link>{xml_sicher(seite)}</link>' if seite else ''}
  {f'<atom:link href="{xml_sicher(seite)}/feed.xml" rel="self" type="application/rss+xml"/>' if seite else ''}
  <itunes:author>Nachrichten-Heft</itunes:author>
  <itunes:summary>{xml_sicher(beschreibung)}</itunes:summary>
  <itunes:explicit>false</itunes:explicit>
  <itunes:type>episodic</itunes:type>
  <itunes:category text="News"/>
  {f'<itunes:image href="{xml_sicher(bild)}"/>' if bild else ''}
{eintraege}
</channel>
</rss>
""", encoding="utf8")
    log(f"  feed.xml: {len(folgen)} Folgen")


# ------------------------------------------------------------------ Lauf
def main():
    if not DATEN.exists():
        log("Keine data/news.json – nichts zu besprechen.")
        return 0
    daten = json.loads(DATEN.read_text(encoding="utf8"))
    alt = json.loads(PODCAST.read_text(encoding="utf8")) if PODCAST.exists() else {}
    folgen = [f for f in (alt.get("folgen") or []) if isinstance(f, dict)]
    schon = {f.get("themaId") for f in folgen}

    thema = thema_waehlen(daten, schon)
    if not thema:
        log("Kein passendes Thema (zu wenige Quellen oder alles schon besprochen).")
        return 0
    log(f"Thema: {thema.get('titel')} ({len(thema.get('medien') or [])} Medien)")

    # Zwei bis vier Sprecher, je nach Umfang des Themas.
    wie_viele = 2 + min(2, len(thema.get("positionen") or []))
    besetzung = [h for h in BESETZUNG if h["name"] == MODERATION]
    besetzung += [h for h in BESETZUNG if h["name"] != MODERATION][:wie_viele - 1]
    log(f"Besetzung: {', '.join(h['name'] for h in besetzung)}")

    skript, grund = None, "kein Versuch gelaufen"
    for versuch in (1, 2, 3):
        try:
            roh = skript_schreiben(thema, besetzung)
            skript, grund = skript_pruefen(roh, besetzung)
        except Exception as ex:
            grund = str(ex)
        if skript:
            break
        log(f"  Versuch {versuch} verworfen: {grund}")
        time.sleep(3)
    if not skript:
        log(f"Kein brauchbares Skript ({grund}) – nächster Lauf versucht es erneut.")
        return 1
    log(f"Skript: {len(skript['zeilen'])} Zeilen, {skript['woerter']} Wörter")

    TON.mkdir(parents=True, exist_ok=True)
    voice = lade_stimme()
    kennung = re.sub(r"[^a-z0-9]+", "-", str(thema.get("id", "folge")).lower()).strip("-")[:50]
    ziel = TON / f"folge-podcast-{kennung}.mp3"
    frist = time.time() + int(os.environ.get("PODCAST_SEKUNDEN", "900"))
    ton = gespraech_sprechen(voice, skript, besetzung, ziel, frist)
    if not ton:
        log("Folge konnte nicht gesprochen werden.")
        return 1
    log(f"♫ {skript['titel']} – {ton['l'] / 60:.1f} Minuten, {ton['b'] // 1024} KB")

    jetzt = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    neu = {"id": "podcast-" + kennung, "themaId": thema.get("id"), "art": "podcast",
           "titel": skript["titel"] or thema.get("titel"), "text": skript["beschreibung"],
           "zeit": jetzt, "besetzung": [h["name"] for h in besetzung],
           "d": ton["d"], "l": ton["l"], "b": ton["b"], "marken": ton["marken"]}
    folgen = [neu] + [f for f in folgen if f.get("id") != neu["id"]]
    folgen = folgen[:BEHALTEN]

    # Aufnahmen, die keine Folge mehr sind, verschwinden.
    gebraucht = {f["d"] for f in folgen if f.get("d")}
    for p in TON.glob("folge-podcast-*.mp3"):
        if p.name not in gebraucht:
            p.unlink()

    PODCAST.parent.mkdir(parents=True, exist_ok=True)
    PODCAST.write_text(json.dumps({"stand": jetzt, "besetzung": BESETZUNG, "folgen": folgen},
                                  ensure_ascii=False, indent=1), encoding="utf8")

    repo = os.environ.get("GITHUB_REPOSITORY", "")
    seite = (os.environ.get("SITE_URL") or "").rstrip("/")
    feed_schreiben(folgen, seite, f"https://raw.githubusercontent.com/{repo}/ton/" if repo else "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
