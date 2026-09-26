#!/usr/bin/env python3
"""Welche Stimmen versteht man wirklich?

Das Modell de_DE-mls-medium bringt 236 Sprecher mit, und die Qualität schwankt
stark - es stammt aus Hörbuchaufnahmen von Freiwilligen. Nach Tonhöhe und
Lautstärke auszuwählen war der falsche Maßstab: Eine Stimme kann angenehm tief
sein und trotzdem unverständlich nuscheln.

Hier wird stattdessen gemessen, was zählt. Jeder Sprecher liest dieselben drei
Sätze. Eine Spracherkennung hört zu und schreibt mit. Dann wird verglichen, wie
viele Wörter sie falsch verstanden hat - die Wortfehlerrate. Wer niedrig liegt,
ist verständlich. Genau das, was ein Zuhörer auch merkt.

Ergebnis:
  ton/proben/probe-<nr>.mp3   die Aufnahmen
  proben/index.html           Seite zum Anhören, nach Verständlichkeit sortiert
  proben/stimmen.json         die Messwerte

Läuft über einen eigenen Arbeitsablauf von Hand, nicht bei jedem Update.
"""

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROBEN_TON = ROOT / "ton" / "proben"
PROBEN_SEITE = ROOT / "proben"
STIMMEN = ROOT / ".stimmen"
MODELL = os.environ.get("PROBE_MODELL", "de_DE-mls-medium")

# Drei Sätze wie im Podcast: eine Begrüßung, ein Satz mit Zahlen und Fachwörtern,
# eine Rückfrage. Zahlen ausgeschrieben, damit der Vergleich fair bleibt.
TEXTE = [
    "Guten Abend, hier ist das Nachrichten-Heft.",
    "Die Institute haben ihre Prognose von null Komma sechs auf eins Komma drei Prozent angehoben.",
    "Worin sind sich die Berichte eigentlich einig, und wo gehen sie auseinander?",
]


def log(*a):
    print(*a, flush=True)
    sys.stdout.flush()


# ---------------------------------------------------------------- Vergleich
def normalisieren(text):
    """Auf das Wesentliche herunterbrechen: keine Satzzeichen, alles klein,
    Umlaute so lassen. Sonst zählt ein fehlendes Komma als Fehler."""
    text = text.lower().replace("ß", "ss")
    text = re.sub(r"[^a-zäöü\s]", " ", text)
    return [w for w in text.split() if w]


def wortfehlerrate(soll, ist):
    """Levenshtein-Abstand auf Wortebene, geteilt durch die Anzahl der Sollwörter.
    0.0 = jedes Wort richtig verstanden, 1.0 = nichts verstanden."""
    a, b = normalisieren(soll), normalisieren(ist)
    if not a:
        return 1.0
    # Zeile für Zeile durch die Matrix, nur zwei Zeilen im Speicher
    vorher = list(range(len(b) + 1))
    for i, wa in enumerate(a, 1):
        jetzt = [i]
        for j, wb in enumerate(b, 1):
            jetzt.append(min(vorher[j] + 1,          # löschen
                             jetzt[j - 1] + 1,       # einfügen
                             vorher[j - 1] + (wa != wb)))   # ersetzen
        vorher = jetzt
    return min(1.0, vorher[-1] / len(a))


# ---------------------------------------------------------------- Auswahl
def sprecher_liste(gesamt):
    roh = os.environ.get("PROBE_SPRECHER", "").strip()
    if roh:
        return [int(x) for x in roh.replace(",", " ").split() if x.strip().isdigit()]
    wie_viele = int(os.environ.get("PROBE_ANZAHL", "40"))
    schritt = max(1, gesamt // wie_viele)
    return list(range(0, gesamt, schritt))[:wie_viele]


def main():
    try:
        from piper import PiperVoice
        from piper.config import SynthesisConfig
        from piper.download_voices import download_voice
    except ImportError as e:
        log("Piper ist nicht installiert:", e)
        return 1

    STIMMEN.mkdir(parents=True, exist_ok=True)
    modell = STIMMEN / f"{MODELL}.onnx"
    if not modell.exists():
        log(f"Lade Stimme {MODELL} …")
        download_voice(MODELL, STIMMEN)
    voice = PiperVoice.load(modell)

    gesamt = getattr(voice.config, "num_speakers", 1) or 1
    grund = getattr(voice.config, "length_scale", 1.0) or 1.0
    log(f"Modell {MODELL}: {gesamt} Sprecher, Grundtempo {grund}")

    nummern = [n for n in sprecher_liste(gesamt) if 0 <= n < gesamt]
    if not nummern:
        log("Keine gültigen Sprechernummern.")
        return 1
    log(f"Es werden {len(nummern)} Sprecher geprüft.\n")

    # Zuhörer laden. Ohne ihn werden die Proben trotzdem erzeugt - dann eben
    # nur zum Selbstanhören, ohne Messwert.
    hoerer = None
    try:
        from faster_whisper import WhisperModel
        hoerer = WhisperModel(os.environ.get("PROBE_HOERER", "small"),
                              device="cpu", compute_type="int8")
        log("Spracherkennung bereit.\n")
    except Exception as e:
        log(f"Ohne Spracherkennung weiter ({e}) – es gibt dann keine Messwerte.\n")

    PROBEN_TON.mkdir(parents=True, exist_ok=True)
    PROBEN_SEITE.mkdir(parents=True, exist_ok=True)
    rate = voice.config.sample_rate
    fertig = []

    for nr in nummern:
        ziel = PROBEN_TON / f"probe-{nr:03d}.mp3"
        try:
            conf = SynthesisConfig(length_scale=grund * 1.04, noise_scale=0.667,
                                   noise_w_scale=0.8, normalize_audio=True, speaker_id=nr)
            stuecke = [b"\x00\x00" * int(rate * 0.2)]
            for satz in TEXTE:
                stuecke.append(b"".join(c.audio_int16_bytes for c in voice.synthesize(satz, conf)))
                stuecke.append(b"\x00\x00" * int(rate * 0.35))
            roh = b"".join(stuecke)
            p = subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-f", "s16le", "-ar", str(rate),
                 "-ac", "1", "-i", "pipe:0", "-c:a", "libmp3lame", "-b:a", "64k", str(ziel)],
                input=roh, capture_output=True, timeout=180)
            if p.returncode != 0 or not ziel.exists():
                log(f"  Sprecher {nr:3}: ffmpeg meldet {p.stderr.decode('utf8','ignore')[:80]}")
                continue

            dauer = 0.0
            try:
                pr = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                     "-of", "default=nw=1:nk=1", str(ziel)],
                                    capture_output=True, text=True, timeout=30)
                dauer = round(float(pr.stdout.strip()), 1)
            except Exception:
                pass

            fehler, gehoert = None, ""
            if hoerer:
                try:
                    teile, _ = hoerer.transcribe(str(ziel), language="de", beam_size=1)
                    gehoert = " ".join(t.text for t in teile).strip()
                    fehler = round(wortfehlerrate(" ".join(TEXTE), gehoert), 3)
                except Exception as e:
                    log(f"  Sprecher {nr:3}: Zuhören fehlgeschlagen ({e})")

            fertig.append({"nr": nr, "sekunden": dauer, "kb": ziel.stat().st_size // 1024,
                           "fehlerrate": fehler, "gehoert": gehoert[:300]})
            note = "–" if fehler is None else f"{fehler*100:4.0f} % falsch"
            marke = "" if fehler is None else ("   ← sehr gut" if fehler <= 0.10
                                               else "   ← brauchbar" if fehler <= 0.25 else "")
            log(f"  Sprecher {nr:3}: {dauer:5.1f}s  {note}{marke}")
        except Exception as ex:
            log(f"  Sprecher {nr:3}: {ex}")

    if not fertig:
        log("Keine Probe erzeugt.")
        return 1

    # Nach Verständlichkeit sortieren, Unbewertete ans Ende
    fertig.sort(key=lambda x: (x["fehlerrate"] is None, x["fehlerrate"] if x["fehlerrate"] is not None else 9))
    gut = [f for f in fertig if f["fehlerrate"] is not None and f["fehlerrate"] <= 0.15]

    log("")
    log("=" * 58)
    if gut:
        log(f"Die {min(8, len(gut))} verständlichsten Sprecher:")
        for f in gut[:8]:
            log(f"   Nummer {f['nr']:3}  –  {f['fehlerrate']*100:.0f} % der Wörter falsch verstanden")
        log("")
        log("Vorschlag für die Besetzung: " + ", ".join(str(f["nr"]) for f in gut[:4]))
    else:
        log("Kein Sprecher kam unter 15 % Wortfehler. Dann ist dieses Modell")
        log("für einen Podcast nicht geeignet und wir brauchen andere Stimmen.")
    log("=" * 58)

    repo = os.environ.get("GITHUB_REPOSITORY", "")
    basis = f"https://raw.githubusercontent.com/{repo}/ton/proben/" if repo else ""
    marke = str(int(time.time()))
    (PROBEN_SEITE / "index.html").write_text(
        baue_seite(fertig, basis, marke, bool(hoerer)), encoding="utf8")
    (PROBEN_SEITE / "stimmen.json").write_text(
        json.dumps({"modell": MODELL, "grundtempo": grund, "texte": TEXTE,
                    "gemessen": bool(hoerer), "sprecher": fertig},
                   ensure_ascii=False, indent=1), encoding="utf8")
    log(f"\nFertig: {len(fertig)} Proben. Seite unter /proben/")
    return 0


def baue_seite(liste, basis, marke="", gemessen=True):
    def karte(f):
        w = f["fehlerrate"]
        stufe = ("gut" if w is not None and w <= 0.10 else
                 "mittel" if w is not None and w <= 0.25 else
                 "schlecht" if w is not None else "ohne")
        wort = ("–" if w is None else
                "sehr gut verständlich" if w <= 0.10 else
                "brauchbar" if w <= 0.25 else
                "schwer verständlich")
        return f"""  <div class="p {stufe}">
    <b>Sprecher {f['nr']} <span class="d">{'' if w is None else f'{w*100:.0f} % falsch · '}{f['sekunden']}s</span></b>
    <span class="urteil">{wort}</span>
    <audio controls preload="none" src="{basis}probe-{f['nr']:03d}.mp3?v={marke}"></audio>
    {f'<p class="gehoert">Verstanden wurde: „{f["gehoert"]}"</p>' if f.get("gehoert") else ""}
    <label><input type="checkbox" data-n="{f['nr']}"> merken</label>
  </div>"""

    kopf = ("Eine Spracherkennung hat jeder Stimme zugehört und mitgeschrieben. "
            "Der Prozentwert sagt, wie viele Wörter sie falsch verstanden hat – "
            "je niedriger, desto verständlicher. Oben stehen die besten."
            if gemessen else
            "Die Spracherkennung lief nicht, es gibt diesmal keine Messwerte. "
            "Hör sie dir an und hak an, was dir gefällt.")
    return f"""<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stimmen anhören</title>
<style>
  :root{{color-scheme:light dark}}
  body{{font-family:system-ui,sans-serif;margin:0;padding:18px;max-width:660px;margin-inline:auto;line-height:1.5}}
  h1{{font-size:1.4rem;margin:0 0 6px}}
  p.hin{{color:#667;margin:0 0 18px}}
  .p{{border:1px solid #8884;border-left-width:5px;border-radius:12px;padding:12px 14px;margin-bottom:10px}}
  .p.gut{{border-left-color:#1B7A46}} .p.mittel{{border-left-color:#9A5A0B}}
  .p.schlecht{{border-left-color:#A33326;opacity:.72}} .p.ohne{{border-left-color:#8888}}
  .p b{{display:block}}
  .urteil{{display:block;font-size:.85rem;color:#667;margin:2px 0 8px}}
  audio{{width:100%}}
  .d{{float:right;font-weight:400;color:#889;font-size:.85rem}}
  .gehoert{{font-size:.82rem;color:#778;margin:8px 0 0;font-style:italic}}
  label{{display:inline-flex;gap:6px;align-items:center;margin-top:8px;font-size:.9rem;color:#667}}
  #raus{{position:sticky;bottom:10px;width:100%;padding:14px;font-size:1rem;font-weight:700;
    border:0;border-radius:12px;background:#4A2A6B;color:#fff;margin-top:16px}}
  #liste{{margin-top:10px;font-family:ui-monospace,monospace;font-size:1.1rem;text-align:center}}
</style></head><body>
<h1>Welche Stimmen sollen den Podcast sprechen?</h1>
<p class="hin">{kopf}</p>
{chr(10).join(karte(f) for f in liste)}
<button id="raus">Ausgewählte anzeigen</button>
<div id="liste"></div>
<script>
document.getElementById("raus").onclick = () => {{
  const n = [...document.querySelectorAll("input:checked")].map(x => x.dataset.n);
  document.getElementById("liste").textContent = n.length ? n.join(", ") : "noch nichts ausgewählt";
}};
</script>
</body></html>
"""


if __name__ == "__main__":
    sys.exit(main())
