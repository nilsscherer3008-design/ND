#!/usr/bin/env python3
"""Hörprobe für die Podcast-Besetzung.

Das Modell de_DE-mls-medium bringt 236 verschiedene Sprecher mit. Welche davon
angenehm klingen und wer männlich oder weiblich klingt, hört man nur – deshalb
spricht dieses Skript denselben Text mit vielen Sprechern und baut eine Seite,
auf der man sie nacheinander anhören kann.

Läuft über einen eigenen Arbeitsablauf von Hand, nicht bei jedem Update.
Ergebnis:  ton/proben/probe-<nr>.mp3   und   proben/index.html
"""

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROBEN_TON = ROOT / "ton" / "proben"
PROBEN_SEITE = ROOT / "proben"
STIMMEN = ROOT / ".stimmen"
MODELL = os.environ.get("PROBE_MODELL", "de_DE-mls-medium")

# Zwei Sätze, die typisch für den Podcast sind: einer sachlich, einer als Frage.
TEXT = [
    "Guten Abend, hier ist das Nachrichten-Heft.",
    "Darüber berichten heute mehrere Medien – aber worin sind sie sich eigentlich einig?",
]


def log(*a):
    print(*a, flush=True)
    sys.stdout.flush()


def sprecher_liste():
    roh = os.environ.get("PROBE_SPRECHER", "").strip()
    if roh:
        try:
            return [int(x) for x in roh.replace(",", " ").split() if x.strip().isdigit()]
        except ValueError:
            pass
    # Gut verteilt über den ganzen Bereich, damit man eine echte Auswahl hört.
    schritt = max(1, 236 // 24)
    return list(range(0, 236, schritt))[:24]


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
    log(f"Modell {MODELL}: {gesamt} Sprecher")

    nummern = [n for n in sprecher_liste() if 0 <= n < gesamt]
    if not nummern:
        log("Keine gültigen Sprechernummern.")
        return 1

    PROBEN_TON.mkdir(parents=True, exist_ok=True)
    PROBEN_SEITE.mkdir(parents=True, exist_ok=True)
    rate = voice.config.sample_rate
    fertig = []

    for nr in nummern:
        ziel = PROBEN_TON / f"probe-{nr:03d}.mp3"
        try:
            conf = SynthesisConfig(length_scale=1.04, noise_scale=0.667,
                                   noise_w_scale=0.8, normalize_audio=True, speaker_id=nr)
            stuecke = [b"\x00\x00" * int(rate * 0.2)]
            for satz in TEXT:
                stuecke.append(b"".join(c.audio_int16_bytes for c in voice.synthesize(satz, conf)))
                stuecke.append(b"\x00\x00" * int(rate * 0.3))
            roh = b"".join(stuecke)
            p = subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-f", "s16le", "-ar", str(rate),
                 "-ac", "1", "-i", "pipe:0", "-c:a", "libmp3lame", "-b:a", "48k", str(ziel)],
                input=roh, capture_output=True, timeout=120)
            if p.returncode != 0 or not ziel.exists():
                log(f"  Sprecher {nr}: ffmpeg meldet {p.stderr.decode('utf8', 'ignore')[:90]}")
                continue
            fertig.append(nr)
            log(f"  ♪ Sprecher {nr:3} -> {ziel.name} ({ziel.stat().st_size // 1024} KB)")
        except Exception as ex:
            log(f"  Sprecher {nr}: {ex}")

    if not fertig:
        log("Keine Probe erzeugt.")
        return 1

    repo = os.environ.get("GITHUB_REPOSITORY", "")
    basis = f"https://raw.githubusercontent.com/{repo}/ton/proben/" if repo else ""
    seite = baue_seite(fertig, basis)
    (PROBEN_SEITE / "index.html").write_text(seite, encoding="utf8")
    (PROBEN_SEITE / "stimmen.json").write_text(
        json.dumps({"modell": MODELL, "sprecher": fertig}, ensure_ascii=False, indent=1), encoding="utf8")
    log(f"\nFertig: {len(fertig)} Proben. Seite unter /proben/")
    return 0


def baue_seite(nummern, basis):
    karten = "\n".join(f"""  <div class="p">
    <b>Sprecher {n}</b>
    <audio controls preload="none" src="{basis}probe-{n:03d}.mp3"></audio>
    <label><input type="checkbox" data-n="{n}"> merken</label>
  </div>""" for n in nummern)
    return f"""<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stimmen anhören</title>
<style>
  :root{{color-scheme:light dark}}
  body{{font-family:system-ui,sans-serif;margin:0;padding:18px;max-width:640px;margin-inline:auto;line-height:1.5}}
  h1{{font-size:1.4rem;margin:0 0 6px}}
  p.hin{{color:#667;margin:0 0 18px}}
  .p{{border:1px solid #8884;border-radius:12px;padding:12px 14px;margin-bottom:10px}}
  .p b{{display:block;margin-bottom:8px}}
  audio{{width:100%}}
  label{{display:inline-flex;gap:6px;align-items:center;margin-top:8px;font-size:.9rem;color:#667}}
  #raus{{position:sticky;bottom:10px;width:100%;padding:14px;font-size:1rem;font-weight:700;
    border:0;border-radius:12px;background:#16407A;color:#fff;margin-top:16px}}
  #liste{{margin-top:10px;font-family:ui-monospace,monospace;font-size:1.1rem;text-align:center}}
</style></head><body>
<h1>Welche Stimmen sollen den Podcast sprechen?</h1>
<p class="hin">Hör dir die Proben an und hak die an, die dir gefallen. Unten kommt dann
eine Liste mit Nummern heraus – die schickst du mir, und ich setze die Besetzung zusammen.</p>
{karten}
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
