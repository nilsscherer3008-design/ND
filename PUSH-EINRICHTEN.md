# Handy-Mitteilungen einrichten (einmalig, ca. 20 Minuten)

Danach gilt für alle Nutzer: **App öffnen → „Mitteilungen erlauben“ tippen → fertig.**
Keine zusätzliche App, keine Anmeldung.

## 1. Cloudflare-Konto anlegen (kostenlos)
1. Auf **dash.cloudflare.com** registrieren (E-Mail bestätigen).
2. Links auf **Compute (Workers)** → **Create** → **Start with Hello World** → Name z. B. `heft-push` → **Deploy**.
3. Oben auf **Edit code**. Den gesamten Inhalt der Datei `worker.js` aus deinem Repository hineinkopieren (alten Code vorher löschen) → **Deploy**.
4. Die Adresse deines Workers notieren, z. B. `https://heft-push.deinname.workers.dev`.

## 2. Speicher anlegen (KV)
1. Links **Storage & Databases → KV** → **Create Instance** → Name `ABOS` → **Create**.
2. Zurück zum Worker → **Settings → Bindings → Add → KV namespace**
   - Variable name: `ABOS`
   - KV namespace: die eben erstellte auswählen → **Deploy**.

## 3. Geheimwort setzen
Worker → **Settings → Variables and Secrets → Add → Secret**
- Name: `TOKEN`
- Wert: ein selbst ausgedachtes langes Passwort, z. B. `heft-7f3k9q2x8w`
→ **Deploy**

## 4. Bei GitHub eintragen
**Settings → Secrets and variables → Actions**

Secrets (Reiter *Secrets*):
| Name | Wert |
|---|---|
| `PUSH_TOKEN` | dasselbe Geheimwort wie oben |
| `VAPID_PRIVATE` | siehe Datei `vapid-schluessel.txt` |

Variables (Reiter *Variables*):
| Name | Wert |
|---|---|
| `PUSH_URL` | die Worker-Adresse, z. B. `https://heft-push.deinname.workers.dev` |
| `VAPID_PUBLIC` | siehe Datei `vapid-schluessel.txt` |

## 5. Workflow ergänzen
In `.github/workflows/update.yml` ist der Schritt „web-push installieren“ schon enthalten
und die vier Werte werden an das Programm übergeben. Einfach die mitgelieferte Fassung hochladen.

## 6. Ausprobieren
1. Einmal **Run workflow** starten.
2. App öffnen → **🔔 Nachrichten aufs Handy** → **Mitteilungen erlauben**.
3. Beim nächsten Lauf mit einer neuen Nachricht kommt die erste Mitteilung.

Im Protokoll steht dann: `Handy-Mitteilungen: 3 verschickt an 2 Geräte`.

## Gut zu wissen
- **iPhone:** Mitteilungen gehen nur, wenn die App über **Teilen → Zum Home-Bildschirm** installiert wurde (ab iOS 16.4).
- **Kosten:** Cloudflare Workers sind bis 100.000 Anfragen pro Tag kostenlos. Das reicht für eine Schule locker.
- **Datenschutz:** Gespeichert wird nur die anonyme Push-Adresse des Browsers, kein Name, keine E-Mail.
- **Rubriken:** Eilmeldungen gehen an alle. Normale Nachrichten nur an die, die die Rubrik ausgewählt haben.
- **ntfy** bleibt als Ausweichweg in der App erhalten, falls ein Gerät keine Mitteilungen erlaubt.
