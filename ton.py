#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Nachrichten-Heft · neutral – Sprecherstimme erzeugen

Erzeugt mit Piper (kostenlos, läuft offline auf dem Server) echte Sprachaufnahmen
für die Videotexte und legt sie als MP3 im Ordner "ton/" ab. Die Zeiten jedes
Satzes werden in data/news.json geschrieben, damit Untertitel und Bilder in der
App genau zum Ton passen.

Läuft nach update.mjs. Fällt etwas aus, bleibt news.json unverändert gültig –
die App nutzt dann die Vorlesestimme des Geräts.
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATEN = ROOT / "data" / "news.json"
TON = ROOT / "ton"
STIMMEN = ROOT / ".stimmen"

WOCHENTAGE = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]
MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli",
          "August", "September", "Oktober", "November", "Dezember"]
ZAHLWORT = {6: "sechs", 9: "neun", 12: "zwölf", 15: "fünfzehn", 18: "achtzehn", 21: "einundzwanzig"}

# Tempo je Format: 1.0 = normal, größer = langsamer
TEMPO = {"doku": 1.08, "wissen": 1.06, "wetter": 1.02, "kurz": 1.0, "lang": 1.04, "einfach": 1.16, "unklar": 1.06, "begriff": 1.12, "tief": 1.04, "ansage": 1.0}
PAUSE = {"doku": 0.44, "wissen": 0.40, "wetter": 0.34, "kurz": 0.30, "lang": 0.34, "einfach": 0.46, "unklar": 0.36, "begriff": 0.42, "tief": 0.34, "ansage": 0.30}


def log(*a):
    print(*a, flush=True)


def saetze_aus(text):
    """Gleiche Satztrennung wie in der App."""
    teile = re.findall(r'[^.!?]+[.!?]+["“”]?|[^.!?]+$', str(text or ""))
    return [t.strip() for t in teile if t and t.strip()]


def schluessel(saetze):
    return " ".join(saetze)[:80]


def sprechbar(text):
    """Kleine Aussprachehilfen, damit die Stimme nicht über Sonderzeichen stolpert."""
    t = str(text)
    t = t.replace("–", ",").replace("—", ",").replace("…", ".")
    t = t.replace("„", "").replace("“", "").replace("”", "").replace("»", "").replace("«", "").replace('"', "")
    t = re.sub(r"\(([^)]*)\)", r", \1,", t)
    t = t.replace(" %", " Prozent").replace("%", " Prozent")
    t = t.replace("€", " Euro").replace("&", " und ")
    t = re.sub(r"\bz\.\s*B\.", "zum Beispiel", t)
    t = re.sub(r"\bu\.\s*a\.", "unter anderem", t)
    t = re.sub(r"\bca\.", "circa", t)
    t = re.sub(r"\bbzw\.", "beziehungsweise", t)
    t = re.sub(r"\bMrd\.", "Milliarden", t)
    t = re.sub(r"\bMio\.", "Millionen", t)
    t = re.sub(r"\bProf\.", "Professor", t)
    t = re.sub(r"\bDr\.", "Doktor", t)
    t = re.sub(r"\s{2,}", " ", t).strip()
    if t and t[-1] not in ".!?:,":
        t += "."
    return t


def stimme_laden(name):
    from piper import PiperVoice
    from piper.download_voices import download_voice
    STIMMEN.mkdir(parents=True, exist_ok=True)
    modell = STIMMEN / f"{name}.onnx"
    if not modell.exists():
        log(f"Lade Stimme {name} …")
        download_voice(name, STIMMEN)
    return PiperVoice.load(modell)


class Sprecher:
    """Verwaltet die Stimmen: welche liest was, und was passiert, wenn eine fehlt."""

    def __init__(self, cfg):
        standard = {"modell": [cfg.get("stimme", "de_DE-thorsten-medium")], "name": "Thorsten"}
        self.cfg = cfg.get("stimmen") or {"standard": standard}
        if "standard" not in self.cfg:
            self.cfg["standard"] = standard
        self.zuordnung = cfg.get("zuordnung") or {"einfach": "einfach", "begriff": "einfach"}
        self.geladen = {}
        self.geladen_name = {}   # welches Modell wirklich geladen wurde

    def schluessel(self, art):
        return self.zuordnung.get(re.sub(r"\d+$", "", art or ""), "standard")

    def name(self, schluessel):
        eintrag = self.cfg.get(schluessel) or self.cfg["standard"]
        return eintrag.get("name", "Computerstimme")

    def kennung(self, schluessel):
        # Der Dateiname enthaelt den Modellnamen. Er muss zu der Stimme passen, die
        # wirklich spricht - sonst behalten alte Aufnahmen faelschlich den neuen Namen.
        try:
            self.stimme(schluessel)
        except Exception:
            pass
        if schluessel in self.geladen_name:
            return self.geladen_name[schluessel]
        eintrag = self.cfg.get(schluessel) or self.cfg["standard"]
        modelle = eintrag.get("modell") or ["de_DE-thorsten-medium"]
        return modelle[0] if isinstance(modelle, list) else str(modelle)

    def stimme(self, schluessel):
        if schluessel in self.geladen:
            return self.geladen[schluessel]
        eintrag = self.cfg.get(schluessel) or self.cfg["standard"]
        modelle = eintrag.get("modell") or ["de_DE-thorsten-medium"]
        if not isinstance(modelle, list):
            modelle = [modelle]
        for m in modelle:
            try:
                self.geladen[schluessel] = stimme_laden(m)
                self.geladen_name[schluessel] = m
                log(f"  Stimme bereit: {eintrag.get('name', m)} ({m})")
                return self.geladen[schluessel]
            except Exception as e:
                log(f"  Stimme {m} nicht ladbar: {e}")
        if schluessel != "standard":
            log(f"  {eintrag.get('name', schluessel)} fällt auf die Standardstimme zurück.")
            self.geladen[schluessel] = self.stimme("standard")
            if "standard" in self.geladen_name:
                self.geladen_name[schluessel] = self.geladen_name["standard"]
            return self.geladen[schluessel]
        raise RuntimeError("Keine Stimme konnte geladen werden.")

    def namen(self):
        return {k: v.get("name", "Computerstimme") for k, v in self.cfg.items()}


def mp3_schreiben(pcm, rate, ziel):
    """Roh-Ton über ffmpeg in ein sendefertiges MP3 wandeln (gleich laut, klarer Klang)."""
    filt = ("highpass=f=85,"
            "equalizer=f=2600:t=q:w=1.4:g=2.5,"
            "acompressor=threshold=-20dB:ratio=3:attack=8:release=180,"
            "loudnorm=I=-16:TP=-1.5:LRA=11,"
            "alimiter=limit=0.97")
    p = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", "pipe:0",
         "-af", filt, "-c:a", "libmp3lame", "-b:a", "48k", "-ac", "1", str(ziel)],
        input=pcm, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError("ffmpeg: " + p.stderr.decode("utf8", "ignore")[-300:])


def aufnehmen(voice, saetze, art, ziel):
    """Sätze einzeln sprechen, Pausen setzen, als ein MP3 speichern. Gibt Startzeiten zurück."""
    from piper.config import SynthesisConfig
    # Jedes Modell bringt sein eigenes Grundtempo mit. Unser Wert ist ein Faktor
    # darauf, keine feste Vorgabe - sonst sprechen fremde Modelle drei Mal zu langsam.
    grund = getattr(voice.config, "length_scale", 1.0) or 1.0
    conf = SynthesisConfig(length_scale=grund * TEMPO.get(art, 1.04),
                           noise_scale=0.667, noise_w_scale=0.8, normalize_audio=True)
    rate = voice.config.sample_rate
    stueck = []
    zeiten = []
    proben = int(rate * 0.25)          # kleiner Vorlauf
    stueck.append(b"\x00\x00" * proben)
    for i, satz in enumerate(saetze):
        zeiten.append(round(proben / rate, 2))
        roh = b"".join(c.audio_int16_bytes for c in voice.synthesize(sprechbar(satz), conf))
        stueck.append(roh)
        proben += len(roh) // 2
        pause = PAUSE.get(art, 0.34)
        if satz.rstrip().endswith("?"):
            pause += 0.14
        if i == len(saetze) - 1:
            pause = 0.55
        still = int(rate * pause)
        stueck.append(b"\x00\x00" * still)
        proben += still
    mp3_schreiben(b"".join(stueck), rate, ziel)
    return zeiten, round(proben / rate, 2)


def auftraege(daten, cfg):
    """Was soll gesprochen werden? Wichtigstes zuerst."""
    formate = cfg.get("formate") or ["lang", "kurz", "einfach"]
    nachrichten = sorted(daten.get("nachrichten", []),
                         key=lambda n: (0 if n.get("eil") else 1, [-ord(c) for c in n.get("zeit", "")]))
    jobs = []
    for n in nachrichten:
        v = n.get("video") or {}
        for f in formate:
            s = [str(x) for x in (v.get(f) or []) if str(x).strip()]
            if s:
                jobs.append((n, f, s, 1))
        if n.get("unklar"):
            s = saetze_aus(n["unklar"][0])[:2]
            if s:
                jobs.append((n, "unklar", s, 2))
        b = ((n.get("lernen") or {}).get("begriffe") or [None])[0]
        if b and len(b) >= 2:
            s = [f"Was bedeutet eigentlich {b[0]}?"] + saetze_aus(b[1])[:2]
            jobs.append((n, "begriff", s, 2))
    if cfg.get("tief", True):
        for n in nachrichten:
            for i, a in enumerate(n.get("artikel") or []):
                s = [x for ab in a.get("absaetze", []) for x in saetze_aus(ab)][:8]
                if s:
                    jobs.append((n, f"tief{i}", s, 3))
    jobs.sort(key=lambda j: j[3])
    return jobs


def ansage_saetze(jetzt_iso, sprecher):
    """Feste Ansagen (Anfang und Ende der Sendungen) – jeden Tag einmal neu."""
    import datetime
    try:
        from zoneinfo import ZoneInfo
        zone = ZoneInfo("Europe/Berlin")
    except Exception:
        zone = datetime.timezone(datetime.timedelta(hours=2))
    d = datetime.datetime.fromisoformat(jetzt_iso.replace("Z", "+00:00")) if jetzt_iso else datetime.datetime.now(datetime.timezone.utc)
    if d.tzinfo is None:
        d = d.replace(tzinfo=datetime.timezone.utc)
    d = d.astimezone(zone)
    datum = f"{WOCHENTAGE[d.weekday()]}, {d.day}. {MONATE[d.month - 1]}"
    titel = ["Die Hauptausgabe", "Heft in hundert Sekunden", "Einfach erklärt", "Kurzmeldungen", "Der Wochenrückblick"]
    titel += [f"Die Ausgabe um {ZAHLWORT[h]} Uhr" for h in (6, 9, 12, 15, 18, 21)]
    titel += ["Deutschland", "Welt", "Wirtschaft", "Wissen und Klima", "Sport", "Region"]
    liste = []
    for t in titel:
        # "Einfach erklärt" liest die zweite Stimme – wie eine eigene Sendung
        art = "begriff" if t == "Einfach erklärt" else "ansage"
        name = sprecher.name(sprecher.schluessel(art))
        liste.append((art, [f"Nachrichten-Heft. {t} vom {datum}.", f"Es liest die Computerstimme {name}."]))
    liste.append(("ansage", ["Alle Hintergründe und Quellen findest du im Nachrichten-Heft."]))
    return liste


def dauer_von(pfad):
    """Wie lang ist eine MP3 wirklich? ffprobe weiss es genau."""
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "default=nw=1:nk=1", str(pfad)],
                           capture_output=True, text=True, timeout=30)
        return round(float(r.stdout.strip()), 2)
    except Exception:
        return 0.0


def folge_bauen(name, teile, ziel):
    """Haengt mehrere Aufnahmen zu einer Folge zusammen - ohne neu zu kodieren,
    das geht in Sekunden statt Minuten."""
    teile = [t for t in teile if t and t.exists() and t.stat().st_size > 0]
    if len(teile) < 2:
        return None
    liste = ziel.parent / (name + ".txt")
    liste.write_text("".join(f"file '{t.name}'\n" for t in teile), encoding="utf8")
    try:
        r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                            "-i", str(liste), "-c", "copy", str(ziel)],
                           capture_output=True, text=True, timeout=180, cwd=str(ziel.parent))
        if r.returncode != 0 or not ziel.exists():
            log(f"  Folge {name} nicht gebaut: {r.stderr.strip()[:120]}")
            return None
        return {"d": ziel.name, "l": dauer_von(ziel), "b": ziel.stat().st_size}
    except Exception as ex:
        log(f"  Folge {name} nicht gebaut: {ex}")
        return None
    finally:
        liste.unlink(missing_ok=True)


def folgen_sammeln(daten, wissen, doku, gebraucht, behalten_anzahl=6):
    """Aus den einzelnen Aufnahmen werden ganze Folgen - das, was ein Podcast braucht.
    Eine Folge pro Tag fuer die Hauptausgabe, dazu jedes Wissensstueck und jede Doku."""
    datei = ROOT / "data" / "podcast.json"
    alt = {}
    if datei.exists():
        try:
            alt = {f["id"]: f for f in json.loads(datei.read_text(encoding="utf8")).get("folgen", [])}
        except Exception:
            alt = {}
    folgen = []
    tag = (daten.get("stand") or "")[:10]

    def pfad(eintrag):
        return TON / eintrag["d"] if eintrag and eintrag.get("d") else None

    # 1. Die Hauptausgabe des Tages
    ansage = next((a for a in ((daten.get("ton") or {}).get("ansagen") or [])
                   if "Hauptausgabe" in (a.get("k") or "")), None)
    nachrichten = sorted(daten.get("nachrichten", []),
                         key=lambda n: (0 if n.get("eil") else 1, [-ord(c) for c in n.get("zeit", "")]))[:12]
    teile, titel = [], []
    if ansage:
        teile.append(pfad(ansage))
    for n in nachrichten:
        e = next((x for x in (n.get("ton") or []) if x.get("k") ), None)
        if e:
            teile.append(pfad(e))
            titel.append(n.get("titel", ""))
    if len(teile) >= 3 and tag:
        id_ = f"hauptausgabe-{tag}"
        ziel = TON / f"folge-{id_}.mp3"
        info = alt.get(id_) if ziel.exists() else None
        if not info:
            gebaut = folge_bauen(id_, teile, ziel)
            if gebaut:
                info = {"id": id_, "art": "nachrichten", "titel": f"Hauptausgabe vom {tag}",
                        "text": "Die wichtigsten Themen des Tages, verglichen aus mehreren Quellen. "
                                + " · ".join(t for t in titel[:5] if t),
                        "zeit": daten.get("stand"), **gebaut}
                log(f"  ♫ Folge: {info['titel']} ({info['l']:.0f}s, {info['b']//1024} KB)")
        if info:
            folgen.append(info)

    # 2. Wissensstuecke und Dokus - die sind von sich aus schon eine Folge
    for st in (wissen or {}).get("stuecke", [])[:8]:
        e = (st.get("ton") or [None])[0]
        pf = pfad(e)
        if not pf or not pf.exists():
            continue
        folgen.append({"id": "wissen-" + st["id"], "art": "wissen", "titel": st.get("titel", ""),
                       "text": st.get("vorspann", ""), "zeit": st.get("zeit"),
                       "d": e["d"], "l": e.get("l", 0), "b": pf.stat().st_size})

    for d in (doku or {}).get("fertig", [])[:4]:
        teile = [pfad((k.get("ton") or [None])[0]) for k in d.get("kapitel", [])]
        teile = [t for t in teile if t and t.exists()]
        if len(teile) < 2:
            continue
        id_ = "doku-" + d["id"]
        ziel = TON / f"folge-{id_}.mp3"
        info = alt.get(id_) if ziel.exists() else None
        if not info:
            gebaut = folge_bauen(id_, teile, ziel)
            if gebaut:
                info = {"id": id_, "art": "doku", "titel": d.get("titel", ""),
                        "text": d.get("untertitel", ""), "zeit": d.get("zeit"), **gebaut}
                log(f"  ♫ Folge: {info['titel']} ({info['l']:.0f}s)")
        if info:
            folgen.append(info)

    folgen.sort(key=lambda f: f.get("zeit") or "", reverse=True)
    folgen = folgen[:behalten_anzahl]
    for f in folgen:
        gebraucht.add(f["d"])
    datei.parent.mkdir(parents=True, exist_ok=True)
    datei.write_text(json.dumps({"stand": daten.get("stand"), "folgen": folgen},
                                ensure_ascii=False, indent=1), encoding="utf8")
    log(f"  Podcast: {len(folgen)} Folgen")
    return folgen


def main():
    cfg_datei = ROOT / "config.json"
    cfg = json.loads(cfg_datei.read_text(encoding="utf8")).get("ton", {}) if cfg_datei.exists() else {}
    if not cfg.get("aktiv", True):
        log("Ton ist in config.json abgeschaltet.")
        return
    if not DATEN.exists():
        log("Keine data/news.json – nichts zu vertonen.")
        return
    daten = json.loads(DATEN.read_text(encoding="utf8"))
    TON.mkdir(parents=True, exist_ok=True)

    sprecher = Sprecher(cfg)
    budget = float(os.environ.get("TON_BUDGET", cfg.get("budgetSekunden", 900)))
    frist = time.time() + float(os.environ.get("TON_ZEIT", cfg.get("maxLaufzeitSekunden", 600)))

    vorhanden = {p.name for p in TON.glob("*.mp3")}
    gebraucht = set()
    neu = 0

    def sichern(art, saetze, vorher):
        """Vorhandene Aufnahme wiederverwenden oder neu erzeugen."""
        nonlocal neu, budget
        k = schluessel(saetze)
        wer = sprecher.schluessel(art)
        h = hashlib.sha1((sprecher.kennung(wer) + "|" + art + "|" + "\n".join(saetze)).encode("utf8")).hexdigest()[:10]
        name = f"{h}.mp3"
        alt = next((e for e in (vorher or []) if e.get("d") == name), None)
        if name in vorhanden and alt:
            gebraucht.add(name)
            return {**alt, "k": k}
        woerter = sum(len(s.split()) for s in saetze)
        schaetzung = woerter / 2.6 + len(saetze) * 0.4
        if budget <= 0 or time.time() > frist:
            return None
        try:
            voice = sprecher.stimme(wer)
            zeiten, dauer = aufnehmen(voice, saetze, re.sub(r"\d+$", "", art), TON / name)
        except Exception as e:
            log(f"  ✗ {art}: {e}")
            return None
        budget -= dauer
        neu += 1
        gebraucht.add(name)
        log(f"  ♪ {art}: {dauer:.1f}s ({len(saetze)} Sätze, geschätzt {schaetzung:.0f}s)")
        return {"k": k, "d": name, "l": dauer, "s": zeiten}

    # 1. Ansagen
    alteAnsagen = ((daten.get("ton") or {}).get("ansagen")) or []
    ansagen = []
    for art, saetze in ansage_saetze(daten.get("stand"), sprecher):
        e = sichern(art, saetze, alteAnsagen)
        if e:
            ansagen.append(e)

    # 2. Nachrichten
    for n, art, saetze, _ in auftraege(daten, cfg):
        vorher = n.get("ton") or []
        e = sichern(art, saetze, vorher)
        if e:
            rest = [x for x in vorher if x.get("k") != e["k"]]
            n["ton"] = rest + [e]

    # 2b. Wetter
    w = daten.get("wetter")
    if w and w.get("text"):
        e = sichern("wetter", [str(x) for x in w["text"]], [w["ton"]] if w.get("ton") else [])
        if e:
            w["ton"] = e

    # 2c. Wissensstücke (eigene Datei)
    wissen_datei = ROOT / "data" / "wissen.json"
    wissen = None
    if wissen_datei.exists():
        try:
            wissen = json.loads(wissen_datei.read_text(encoding="utf8"))
            for st in (wissen.get("stuecke") or [])[:6]:
                saetze = [str(x) for x in (st.get("video") or []) if str(x).strip()]
                if not saetze:
                    continue
                e = sichern("wissen", saetze, st.get("ton") or [])
                if e:
                    st["ton"] = [e]
        except Exception as ex:
            log("Wissensstücke nicht vertont: " + str(ex))
            wissen = None

    # 2d. Lange Dokus – kapitelweise, so weit das Budget dieses Laufs reicht
    doku_datei = ROOT / "data" / "doku.json"
    doku = None
    if doku_datei.exists():
        try:
            doku = json.loads(doku_datei.read_text(encoding="utf8"))
            for d in (doku.get("fertig") or [])[:3]:
                for kap in d.get("kapitel") or []:
                    saetze = [x for ab in kap.get("absaetze", []) for x in saetze_aus(ab)]
                    if not saetze:
                        continue
                    e = sichern("doku", saetze, kap.get("ton") or [])
                    if e:
                        kap["ton"] = [e]
        except Exception as ex:
            log("Doku nicht vertont: " + str(ex))
            doku = None

    # 2b. Ganze Folgen fuer den Podcast zusammenbauen
    try:
        folgen_sammeln(daten, wissen, doku, gebraucht)
    except Exception as ex:
        log("Podcast-Folgen nicht gebaut: " + str(ex))

    # 3. Aufräumen: nur behalten, was noch gebraucht wird
    behalten = set(gebraucht)
    for n in daten.get("nachrichten", []):
        n["ton"] = [e for e in (n.get("ton") or []) if e.get("d") in behalten]
        if not n["ton"]:
            n.pop("ton", None)
    if daten.get("wetter", {}).get("ton", {}).get("d") not in behalten:
        daten.get("wetter", {}).pop("ton", None)
    if wissen:
        for st in wissen.get("stuecke") or []:
            st["ton"] = [e for e in (st.get("ton") or []) if e.get("d") in behalten]
            if not st["ton"]:
                st.pop("ton", None)
        wissen_datei.write_text(json.dumps(wissen, ensure_ascii=False, indent=1), encoding="utf8")
    if doku:
        for d in doku.get("fertig") or []:
            for kap in d.get("kapitel") or []:
                kap["ton"] = [e for e in (kap.get("ton") or []) if e.get("d") in behalten]
                if not kap["ton"]:
                    kap.pop("ton", None)
            d["vertont"] = all(k.get("ton") for k in (d.get("kapitel") or []))
        doku_datei.write_text(json.dumps(doku, ensure_ascii=False, indent=1), encoding="utf8")
    weg = 0
    for p in TON.glob("*.mp3"):
        if p.name not in behalten:
            p.unlink()
            weg += 1

    repo = os.environ.get("GITHUB_REPOSITORY", "")
    daten["ton"] = {
        "basis": f"https://raw.githubusercontent.com/{repo}/ton/" if repo else "ton/",
        "stimmen": sprecher.namen(),
        "zuordnung": sprecher.zuordnung,
        "ansagen": ansagen
    }
    DATEN.write_text(json.dumps(daten, ensure_ascii=False, indent=1), encoding="utf8")
    log(f"Ton fertig: {neu} neue Aufnahmen, {len(behalten)} Dateien, {weg} gelöscht.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log("Ton abgebrochen: " + str(e))
        sys.exit(0)   # der Nachrichten-Lauf soll davon nie scheitern
