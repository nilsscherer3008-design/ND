# Nachrichten-Heft · neutral

Eine Nachrichten-App für den Gemeinschaftskunde-Unterricht. Sie sammelt Meldungen großer Medien, vergleicht sie und fasst Themen, über die mehrere Medien berichten, neutral zusammen.

**So funktioniert es:**

- **GitHub Actions** startet alle 3 Stunden zwischen 6 und 21 Uhr das Programm `scripts/update.mjs`.
- Das Programm liest die Nachrichten-Feeds (siehe `config.json`), findet gemeinsame Themen und lässt sie von einer KI zusammenfassen – standardmäßig kostenlos mit Google Gemini.
- Das Ergebnis landet in `data/news.json`. **GitHub Pages** zeigt die App `index.html` an.
- Bei neuen **Eilmeldungen** geht eine Push-Nachricht über **ntfy** raus.
- Der **Wachhalter** (`.github/workflows/wachhalter.yml`) verhindert, dass GitHub die Zeitsteuerung abschaltet.

---

## Einrichtung (ca. 20 Minuten)

### 1. Repository anlegen
1. Auf github.com → **New repository**, z. B. Name `nachrichten-heft`, **Public**.
   Öffentliche Repositories haben kostenlose Actions-Minuten.
2. Alle Dateien aus diesem Ordner hochladen – **auch den Ordner `.github`**.
   Tipp: Im Browser den ganzen Ordner per Drag & Drop auf „uploading an existing file“ ziehen. Danach prüfen, ob `.github/workflows/update.yml` im Repository zu sehen ist.

### 2. Kostenlosen Gemini-Schlüssel besorgen
1. Auf **aistudio.google.com** mit einem Google-Konto anmelden (am besten ein eigenes Konto für das Projekt, nicht das private).
2. Links auf **Get API key** → **Create API key**. Den Schlüssel kopieren.
3. Keine Kreditkarte nötig. Solange du kein Guthaben einzahlst, bleibt es kostenlos.
4. Den Schlüssel **niemals** in eine Datei im Repository schreiben.

### 3. Schlüssel und Einstellungen bei GitHub eintragen
Im Repository: **Settings → Secrets and variables → Actions**

- Reiter **Secrets** → **New repository secret**:
  - `GEMINI_API_KEY` = dein Gemini-Schlüssel
- Reiter **Variables** → **New repository variable**:
  - `NTFY_TOPIC` = ein langer, schwer zu erratender Name, z. B. `heft-gk-8f3k2q9x`
  - `SITE_URL` = die Adresse der App, z. B. `https://DEINNAME.github.io/nachrichten-heft`

### 4. Schreibrechte für den Ablauf erlauben
**Settings → Actions → General → Workflow permissions** → **Read and write permissions** → Save.

### 5. GitHub Pages einschalten
**Settings → Pages** → Source: **Deploy from a branch** → Branch **main**, Ordner **/ (root)** → Save.
Nach 1–2 Minuten ist die App unter `https://DEINNAME.github.io/nachrichten-heft` erreichbar.

### 6. Ersten Lauf starten
**Actions → Nachrichten aktualisieren → Run workflow**.
Im Protokoll siehst du für jede Quelle ✓ (Feed gelesen) oder ✗ (nicht erreichbar) und am Ende, wie viele Themen erstellt wurden.
Danach läuft alles automatisch.

### 7. Eilmeldungen aufs Handy
1. App **ntfy** installieren (App Store / Google Play, kostenlos, keine Anmeldung nötig).
2. In ntfy auf **+** tippen und den Kanalnamen aus `NTFY_TOPIC` eintragen.
   Der Name steht auch unten auf der Startseite der App.

---

## Wichtige Hinweise

**Kosten:** GitHub Pages, Actions (bei öffentlichen Repositories), ntfy und die kostenlose Gemini-Stufe kosten nichts.
Einschränkungen der kostenlosen Gemini-Stufe:
- Google legt die Grenzen (Anfragen pro Minute/Tag) selbst fest und kann sie ändern. Das Programm wartet zwischen den Anfragen und probiert es bei „Limit erreicht“ nach einer Minute erneut. Werden Themen übersprungen, in `config.json` `maxNeueThemenProLauf` verringern.
- In der kostenlosen Stufe darf Google die Anfragen zur Verbesserung seiner Produkte nutzen. Das Programm schickt nur öffentliche Zeitungsartikel, keine Daten von Schülerinnen und Schülern.
- Meldet das Protokoll einen Fehler zum Modellnamen, in AI Studio nachsehen, welche Flash-Modelle kostenlos verfügbar sind, und den Namen in `config.json` bei `modelle.gemini` eintragen.

**Später zu Claude wechseln (kostenpflichtig):** In `config.json` `"anbieter": "anthropic"` setzen und bei GitHub das Secret `ANTHROPIC_API_KEY` anlegen (Schlüssel von console.anthropic.com, Ausgabenlimit setzen).

**Sicherheit bei ntfy:** Ein ntfy-Kanal auf ntfy.sh ist öffentlich. Wer den Namen kennt, kann ihn abonnieren – und theoretisch auch selbst Nachrichten hineinschicken. Deshalb einen langen, zufälligen Namen wählen. Für echten Schutz kann man bei ntfy.sh einen Kanal reservieren (kostenpflichtiges Konto). Dann einen Zugangs-Token erzeugen und als Secret `NTFY_TOKEN` eintragen.

**Quellen:** dpa, Reuters und AP bieten keine frei nutzbaren Feeds an und sind deshalb nicht automatisch dabei. Feed-Adressen können sich ändern. Wenn im Protokoll dauerhaft ✗ steht, die Adresse in `config.json` prüfen oder die Quelle entfernen. Bei Artikeln hinter einer Bezahlschranke kann das Programm oft nur den Anreißer lesen.

**Zeitplan:** GitHub startet zeitgesteuerte Abläufe manchmal mit Verspätung, vor allem zu vollen Stunden. Das Programm gleicht das aus. Es läuft, wenn es in Berlin zwischen 6 und 21 Uhr ist und seit dem letzten Lauf mindestens 2,5 Stunden vergangen sind.

**Qualität:** Das Programm prüft automatisch, dass jeder Punkt unter „einig“ von mindestens zwei echten Quellen stammt. Links und Quellenangaben kommen immer direkt aus den Feeds, nicht von der KI. Trotzdem schreibt eine KI die Texte, und sie kann Fehler machen. Im Unterricht lohnt sich deshalb der Blick in die Originalberichte.

**Recht:** Die App gibt Inhalte in eigenen Worten wieder und verlinkt auf die Originale. Wer sie über die eigene Klasse hinaus öffentlich macht, sollte Urheberrecht, Leistungsschutzrecht der Presseverlage, Impressumspflicht und Datenschutz rechtlich prüfen lassen.

## Dateien
| Datei | Zweck |
|---|---|
| `index.html` | Die App (lädt `data/news.json`) |
| `data/news.json` | Aktuelle Nachrichten (wird automatisch überschrieben) |
| `config.json` | Quellen, Modell, Zeitfenster, Grenzen |
| `scripts/update.mjs` | Sammeln, Vergleichen, Zusammenfassen, Push |
| `.github/workflows/update.yml` | Zeitplan für die Aktualisierung |
| `.github/workflows/wachhalter.yml` | Hält die Zeitsteuerung aktiv |
