# Uberapp

*[English version](README.en.md)*

Einen [Uberspace 7](https://uberspace.de) vom Handy aus verwalten: Dienste neu starten,
Postfächer anlegen, Domains und Backends einrichten, Backups zurückspielen — ohne
Terminal, ohne SSH-Client, ohne Kommandozeilen abzutippen.

Eine Expo-App für **Android, iOS und Web**, die mit einem kleinen Agenten spricht,
der auf dem Uberspace selbst läuft.

---

## Inhalt

- [Wie es zusammenhängt](#wie-es-zusammenhängt)
- [Sicherheitsmodell](#sicherheitsmodell)
- [Einrichtung](#einrichtung)
- [Einen Browser koppeln](#einen-browser-koppeln)
- [Funktionsumfang](#funktionsumfang)
- [Entwicklung](#entwicklung)
- [SSH unter Hermes](#ssh-unter-hermes)
- [Bekannte Grenzen](#bekannte-grenzen)

---

## Wie es zusammenhängt

Drei Teile laufen auf dem Uberspace, jeder mit einem eigenen Grund für seine Adresse:

```
   Handy (nativ)                              Uberspace
  ┌──────────────┐                      ┌────────────────────────┐
  │  Expo-App    │ ── wss:// ─────────▶ │  Agent  :8399          │ ──▶ uberspace-CLI
  │              │                      │  <user>.uber.space     │     supervisorctl
  │              │                      │  /uberapp              │     mysql, rsync …
  │   Kamera ────┼── scannt ──┐         └────────────────────────┘
  └──────────────┘            │
                              │         ┌────────────────────────┐
   Browser (Desktop)          └────────▶│  Vermittler  :8400     │
  ┌──────────────┐  zeigt QR            │  uberapp.<user>        │
  │  Web-Ansicht │ ◀── holt ab ─────────│  .uber.space/connect   │
  │              │                      └────────────────────────┘
  │              │ ── wss:// ──────────▶  direkt zum Agenten
  └──────────────┘
```

| Adresse | Was | Warum dort |
| --- | --- | --- |
| `<user>.uber.space/uberapp` | Agent | Pfad auf der Standard-Domain — braucht kein DNS, das Zertifikat ist schon da |
| `uberapp.<user>.uber.space/` | Web-Ansicht | eigene DocumentRoot, damit die bestehende Website unberührt bleibt |
| `uberapp.<user>.uber.space/connect` | Vermittler | gleiche Herkunft wie die Ansicht — der Browser leitet ihn aus der eigenen Adresse ab |

Eine Unterdomain statt eines Unterordners, weil der gebaute Web-Export seine
Dateien ab `/` referenziert. Eine Unterdomain der *Standard*-Domain, weil
Uberspace dort jede Bezeichnung auflöst: kein DNS-Eintrag nötig, Zertifikat
sofort.

### Warum ein Agent und nicht direkt SSH

Die App *kann* inzwischen SSH (siehe [SSH unter Hermes](#ssh-unter-hermes)) und
benutzt es für die Ersteinrichtung. Für den Alltag ist der Agent trotzdem der
bessere Weg, und zwar wegen der Reichweite: ein Agent-Token kann genau das, was
im Methodenkatalog steht, und lässt sich mit einem Tipp zurücknehmen. SSH-Zugang
ist eine Shell.

---

## Sicherheitsmodell

Vier Festlegungen, die den Rest erklären.

### 1. Es werden keine Kommandozeilen übertragen

Die App schickt Methodennamen und typisierte Parameter, keine Shell-Strings:

```json
{ "t": "call", "id": "c1", "method": "services.control",
  "params": { "name": "mein-dienst", "action": "restart" } }
```

Der Agent bildet das auf ein festes `argv`-Array ab. Jeder Wert läuft vorher
durch eine Allowlist — ein Dienstname wie `evil; rm -rf ~` wird **abgelehnt,
nicht maskiert**. Es gibt keinen Pfad, auf dem Eingaben in eine Shell geraten.

Eine Ausnahme ist benannt und begründet: der Befehl in einer supervisord-`.ini`.
Den führt supervisord aus, nicht der Agent, und es ist genau das, was
Handschreiben der Datei ergäbe. Auch dort darf kein Zeilenumbruch hinein, der
weitere Direktiven einschleusen würde.

### 2. Token sind begrenzt und rücknehmbar

| | Master-Token | Kopplungs-Token |
| --- | --- | --- |
| liegt in | `~/.config/uberapp/token` (Modus 600) | gehasht in `tokens.json` |
| darf | alles im Katalog, inkl. Token ausgeben | alles im Katalog, **keine** weiteren Token |
| läuft ab | nie | nach gewählter Frist |
| zurücknehmbar | nur durch Ersetzen der Datei | ein Tipp in der App |

Ein gekoppelter Browser bekommt nie das Master-Token, sondern ein eigenes,
befristetes. Er kann damit auch keine weiteren Zugänge verteilen — sonst wäre
ein zurückgenommener Zugang wirkungslos, weil er längst neue ausgegeben hätte.

### 3. Das SSH-Passwort wird weggeworfen

Die einfache Einrichtung braucht es einmal, um den Agenten zu installieren.
Danach wird es verworfen — es wird nirgends gespeichert. Was bleibt, ist das
Agent-Token, und das ist ein Geheimnis mit deutlich kleinerer Reichweite.

### 4. Der Vermittler kann nicht mitlesen

Beim Koppeln eines Browsers erzeugt **der Browser** eine Platzkennung und einen
Schlüssel und zeigt beides als QR-Code. Das Handy liest ihn, prägt ein
befristetes Token und legt die **verschlüsselte** Verbindungsangabe beim
Vermittler ab. Der Browser holt sie einmal ab und spricht danach direkt mit dem
Agenten.

Der Schlüssel verlässt die Browserseite nur als Bildpunkte — er geht nie über
ein Netz. Der Vermittler hält damit Bytes, die er nicht lesen kann, und wird zu
einem uninteressanten Ziel. Er vergisst jeden Platz nach zwei Minuten, gibt ihn
genau einmal heraus und überschreibt ihn nie.

### Weitere Maßnahmen

- Token-Vergleich läuft konstantzeitig
- unauthentifizierte Verbindungen fliegen nach 10 Sekunden raus
- 120 Aufrufe pro Minute und Verbindung
- `files.*` ist auf das Home-Verzeichnis eingesperrt; Symlinks werden **vor**
  der Prüfung aufgelöst, damit man nicht über einen Link herausspaziert

> **Der Agent kann alles, was du in der Shell kannst. Wer das Master-Token hat,
> auch.** Auf dem Handy liegt es im Schlüsselbund, im Browser nur im
> `localStorage` — deshalb bekommt ein Browser ein eigenes, ablaufendes Token.

---

## Einrichtung

### Weg A — aus der App heraus (empfohlen)

App öffnen → **Einfach einrichten** → Uberspace-Host, Benutzername und Passwort
eintragen. Die App meldet sich per SSH an und erledigt fünf Schritte: Host
prüfen, Projekt holen, Agenten bauen und starten, erreichbar machen, Antwort
prüfen. Adresse und Token trägt sie danach selbst ein.

Ein eigener Dev-Build ist dafür nötig — Expo Go bringt die nativen Module für
SSH nicht mit.

### Weg B — von deinem Rechner

```bash
git clone https://github.com/conct/uberapp.git && cd uberapp
npm install
npm run build:web -w @uberapp/mobile   # die Web-Ansicht, wird mitgeliefert
npm run setup -- isabell@stardust.uberspace.de
```

### Weg C — auf dem Uberspace selbst

```bash
git clone https://github.com/conct/uberapp.git ~/uberapp && cd ~/uberapp
bash packages/agent/deploy/install.sh
```

`install.sh` prüft die Node-Version, baut Protokoll, Agent und Vermittler, legt
das Token an (Modus 600, bewusst **nicht** in der supervisord-`.ini`),
installiert beide Dienste, veröffentlicht die Web-Ansicht und gibt am Ende
Adresse und Token aus. Erneutes Ausführen ist gefahrlos: ein vorhandenes Token
bleibt.

Prüfen:

```bash
curl https://<user>.uber.space/uberapp/healthz
curl https://uberapp.<user>.uber.space/connect/healthz
```

### Mehrere Uberspaces

Die App hält beliebig viele. Der Startbildschirm zeigt sie als Kacheln; jede
trägt ihr eigenes Token im Schlüsselbund. Antippen wechselt, langes Drücken
entfernt — das löscht nur das Token auf dem Gerät, der Agent auf dem Host läuft
weiter.

---

## Einen Browser koppeln

1. Am Rechner `https://uberapp.<user>.uber.space` öffnen. Die Seite zeigt einen
   Code und wartet.
2. In der App **Übersicht → Gerät koppeln → Code im Browser scannen**.
3. Der Browser verbindet sich von selbst.

Der Browser ist bewusst nur eine **Ansicht**: laufende und fehlerhafte Dienste,
Auslastung, Status. Die Einrichtung gibt es dort nicht — SSH braucht rohe
TCP-Verbindungen, die ein Browser nicht öffnen kann.

---

## Funktionsumfang

**Übersicht** — belegter Speicher je Verzeichnis, hungrigste Prozesse,
Host-Laufzeit und -Last, Warnung bei fehlerhaften Diensten.

**Services** — Liste mit Live-Status, Start/Stop/Neustart mit Rückfrage,
`reread`+`update`, Live-Log, `.ini` bearbeiten. Ein Assistent legt neue Dienste
an und richtet Port und Web-Backend gleich mit ein.

**Web** — Domains anlegen und löschen, DNS-Einträge anzeigen, Backends auf Ports
legen (auch mit `--remove-prefix`), Logs an- und abschalten, Zertifikatslaufzeiten,
HTTP-Header, Fehlerseite, Rechte-Reparatur.

**Mail** — Mail-Domains, Postfächer anlegen, löschen, Passwort ändern,
Weiterleitungen, Catch-all, Spam-Ordner sowie Sieve-Regeln und -Filter.

**Datenbanken** — MySQL-Datenbanken anlegen und löschen, Tabellen ansehen,
Dumps ziehen und einspielen.

**Backup** — Snapshots durchsuchen, Vorschau, Wiederherstellung, auch für
Datenbanken.

**Ports** — Freigaben auflisten, öffnen und schließen. Die Liste wird mit der
Socket-Tabelle (`ss`) verknüpft, damit sichtbar ist, ob hinter einer Freigabe
überhaupt etwas lauscht — und ob auf `0.0.0.0`/`::` statt auf localhost.

**Dateien** — Home-Verzeichnis durchsuchen, Textdateien ansehen und bearbeiten,
Ordner anlegen, löschen, verschieben.

**Cron & Diagnose** — Cron-Einträge lesbar darstellen und ändern; belegter
Platz, gelöschte-aber-offene Dateien, Speicher, Shell wechseln.

---

## Entwicklung

```bash
npm install
npm run build          # protocol, agent, connect
npm test               # 165 Tests
npm run typecheck
npm run app            # Metro für die App
```

> `npm run app` läuft über den Workspace und startet damit immer im richtigen
> Verzeichnis. `npx expo start` im Repo-Stamm scheitert mit
> `Unable to resolve "../../App"` — dort gibt es kein `app.json`.

### Aufbau

| Ort | Inhalt |
| --- | --- |
| `packages/protocol` | Nachrichtentypen, Methodenkatalog, geteilte Validierung, Übergabe-Format |
| `packages/agent` | WebSocket-Server für den Uberspace |
| `packages/connect` | Vermittler für die Browser-Kopplung |
| `apps/mobile` | Expo-App (Android / iOS / Web) |

### Android lokal bauen

```bash
cd apps/mobile && npx expo run:android
```

Voraussetzungen auf einer Windows-Maschine, die einmal geklärt sein wollen:

- **CMake 3.30+** aus dem SDK Manager. Der Android-Gradle-Plugin nimmt sonst
  seine Voreinstellung 3.22.1, deren ninja 1.10 Pfade über 260 Zeichen ablehnt —
  unabhängig davon, ob Windows lange Pfade erlaubt.
- **JDK 17 oder 21**, nicht 24. Ab JDK 24 ist `System.load()` eingeschränkt
  (JEP 472), womit die CMake-Anbindung des Plugins bricht.
- `android/local.properties` mit `sdk.dir=…`. Ein `expo prebuild` legt die Datei
  leer an; ohne SDK-Pfad hängt `expo run:android` **ohne jede Ausgabe**.

Ein Kaltbau übersetzt jedes native Modul einmal pro Architektur — viermal
dieselbe Arbeit, gemessene 1 h 22 min. Mit

```
UBERAPP_ANDROID_ABIS=arm64-v8a
```

in `apps/mobile/.env` bleibt es bei einer. Standardmäßig aus, denn ein so
gebautes Paket installiert auf keinem üblichen Emulator (die sind x86_64).

### Web-Ansicht bauen

```bash
npm run build:web -w @uberapp/mobile
```

Das Ergebnis liegt versioniert in `apps/mobile/web-dist` und wird von
`install.sh` ausgeliefert. Absichtlich mitgeliefert statt auf dem Host gebaut:
die Einrichtung aus der App holt nur, was im Repo liegt, und ein Bau auf dem
Host bräuchte den kompletten Abhängigkeitsbaum der App für 6 MB Ergebnis.

---

## SSH unter Hermes

Die einfache Einrichtung spricht SSH direkt aus der App — mit `ssh2`, einer
Node-Bibliothek, auf einer JavaScript-Engine, die kein Node ist. Zwischen beidem
lagen sechs Lücken, jede davon in `src/shims/` dokumentiert:

| | Problem | Symptom |
| --- | --- | --- |
| 1 | `pause()` greift auf den nativen Socket zu, bevor es ihn gibt | `No socket with id 0` |
| 2 | `setMaxListeners` fehlt — die Klasse erbt von eventemitter3 | `undefined is not a function` |
| 3 | `writable`/`_readableState` fehlen | ssh2 sendete **nie** ein Byte |
| 4 | Buffers undokumentierte Interna (`utf8Write` u. a.) | Tod beim Server-Banner |
| 5 | `Symbol.species` gibt es in Hermes nicht | Tod beim ersten verschlüsselten Paket |
| 6 | Angebotene Verfahren ohne Überschneidung mit dem Host | „no matching key exchange algorithm" |

Nummer 3 ist die lehrreichste: ssh2 schickt jedes Byte durch
`if (isWritable(sock))`, und diese Prüfung liest Node-Interna. Sie war immer
falsch, also blieb die Verbindung stumm — der Server-Banner kam an, danach
nichts. Nichts meldete einen Fehler.

Nutzbar sind daher `ecdh-sha2-nistp*` und `diffie-hellman-group-exchange-sha256`;
curve25519 nicht, weil `ssh2` es an `crypto.diffieHellman` knüpft, das
quick-crypto nicht mitbringt.

---

## Bekannte Grenzen

- **Kein Kontingent auf der Übersicht.** `quota -g` liefert aus einem
  supervisord-Dienst nichts: das Uberspace-Kontingent ist ein Gruppen-Kontingent,
  und supervisord startet Dienste ohne Gruppenzugehörigkeit. Die App misst
  stattdessen die eigenen Verzeichnisse und sagt dazu, dass das nicht dein Limit
  ist.
- **Kein Datei-Upload.** `files.read` liefert nur Text bis 1 MB und lehnt
  Binärdateien ausdrücklich ab. Für Deployments ist `rsync` über SSH besser als
  alles, was ein Handy anbieten kann.
- **Node 22.13+ empfohlen.** React Native 0.86 verlangt es; mit 22.11 läuft alles,
  gibt aber eine Engine-Warnung aus.
- **`uberspace tools version`** ist der einzige Parser, dessen Ausgabe nicht
  gegen das Handbuch geprüft ist — die Versionsliste kann leer bleiben.
- **`.qmail` wird nicht bearbeitet.** Das Handbuch rät davon ab, und
  `.qmail-default` gehört Uberspace selbst. Regeln und Filter laufen über Sieve.

---

## Lizenz

Siehe [LICENSE](LICENSE), falls vorhanden — sonst: privates Projekt.
