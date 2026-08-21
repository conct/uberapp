# Uberapp

Eine Helper-App für Uberspace 7: Services neu starten, Postfächer anlegen, Domains
und Backends verwalten — vom Handy aus, ohne SSH-Client.

Expo-App für **Android, iOS und Web**, die über WebSocket mit einem kleinen Agenten
spricht, der auf dem Uberspace selbst läuft.

## Warum ein Agent?

React Native kann kein SSH — es gibt keine brauchbare Library dafür, und SSH-Keys
auf einem Handy sind ohnehin heikel. Stattdessen:

```
Expo-App  ──wss://──▶  Uberspace-Webserver  ──http──▶  Agent (Node)  ──▶  uberspace-CLI
 (Handy)              (Let's-Encrypt-TLS)         (supervisord-Service)     supervisorctl
```

Der Agent läuft als supervisord-Service und hängt hinter einem Web-Backend. Damit
bekommt er das Let's-Encrypt-Zertifikat des Accounts geschenkt — kein eigenes
TLS-Handling nötig.

### Keine rohen Shell-Kommandos

Die App schickt **keine** Kommandozeilen, sondern typisierte RPC-Calls:

```json
{ "t": "call", "id": "c1", "method": "services.control",
  "params": { "name": "my-daemon", "action": "restart" } }
```

Der Agent bildet das auf ein festes argv-Array ab. Jeder Wert läuft vorher durch
eine strikte Allowlist-Regex — ein Service-Name wie `evil; rm -rf ~` wird
abgelehnt, nicht escaped. Es gibt keinen Pfad, auf dem Nutzereingaben in eine
Shell gelangen.

## Aufbau

| Ort | Inhalt |
| --- | --- |
| `packages/protocol` | Nachrichtentypen, Methodenkatalog, geteilte Validierung |
| `packages/agent` | WebSocket-Server für den Uberspace |
| `apps/mobile` | Expo-App (Android / iOS / Web) |

## Installation auf dem Uberspace

```bash
git clone <dieses-repo> ~/uberapp && cd ~/uberapp
bash packages/agent/deploy/install.sh
```

Das Skript prüft die Node-Version, baut den Agenten, erzeugt ein Token unter
`~/.config/uberapp/token` (Modus 600), installiert den supervisord-Service und
zeigt am Ende an, wie das Web-Backend gesetzt wird:

```bash
uberspace web domain add uberapp.deine-domain.de
uberspace web backend set uberapp.deine-domain.de/ --http --port 8399
```

Prüfen:

```bash
curl https://uberapp.deine-domain.de/healthz
```

Dann in der App Adresse und Token eintragen.

## App starten

```bash
npm install
npm run build:protocol
npm run app
```

`npm run app` startet den Expo-Dev-Server; von dort aus per QR-Code aufs Handy
oder mit `w` in den Browser.

> Der Protokoll-Layer muss gebaut sein, bevor Metro bundelt — die App importiert
> `@uberapp/protocol` aus `dist/`.

## Tests

```bash
npm test
```

38 Tests: Parser für die CLI-Textausgaben (`supervisorctl status`, `uberspace web
backend list`, `quota -gs`, `uberspace port list`, `ss -ltunp`) und ein
End-to-End-Test, der den Agenten hochfährt und Handshake, Auth, Pfad-Confinement
und Parametervalidierung über einen echten Socket prüft.

## Funktionsumfang

**Services** — Liste mit Live-Status, Start/Stop/Neustart mit Bestätigung,
`reread`+`update`, Live-Log-Tail (stdout/stderr), .ini-Datei bearbeiten.

**Web** — Domains anlegen/löschen, DNS-Records anzeigen, Backends auf Ports
mappen (inkl. `--remove-prefix`), Access-/Error-Logs an- und abschalten.

**Mail** — Mail-Domains verwalten, Postfächer anlegen und löschen, Passwörter
ändern.

**Ports** — Firewall-Freigaben auflisten, öffnen und schließen. Die Liste wird
mit der Socket-Tabelle (`ss`) verknüpft, damit sichtbar ist, ob hinter einem
offenen Port überhaupt etwas lauscht — und ob es auf `0.0.0.0`/`::` lauscht
statt auf localhost.

**Dateien** — Home-Verzeichnis browsen, Textdateien ansehen und bearbeiten,
Ordner anlegen, löschen.

**Übersicht** — Quota mit Auslastungsbalken, Speicherhungrigste Prozesse,
Host-Last, Warnung bei fehlerhaften Services.

## Drei Details, die beim Bauen wichtig waren

**Der offene Port, hinter dem nichts lauscht.** Die häufigste Ursache für „mein
Dienst ist nicht erreichbar" ist nicht die Firewall, sondern ein Prozess, der
sich an `127.0.0.1` gebunden hat. `ports.list` verknüpft deshalb jede Freigabe
mit `ss` und markiert sie als erreichbar oder nicht. Ist die Socket-Tabelle
nicht lesbar, meldet der Agent `null` — „unbekannt" darf nicht als „da lauscht
nichts" dargestellt werden.

**Der 3-Minuten-Timeout.** Uberspace kappt untätige HTTP-Verbindungen nach drei
Minuten. Beide Seiten senden deshalb alle 45 Sekunden einen Heartbeat; ohne das
stirbt jeder Socket, den man offen liegen lässt.

**Das Passwort-Prompt-Problem.** `uberspace mail user add` liest das Passwort mit
`getpass()` von `/dev/tty` und fragt zweimal. Ein Daemon hat kein Controlling
Terminal, ein simples Pipe scheitert also. Der Agent startet den Befehl deshalb
unter `script -qec`, das ihm ein Pseudo-Terminal gibt, und beantwortet beide
Prompts. Nach außen ist das *ein* Call: die App sammelt Name und Passwort in
einem Formular und schickt beides zusammen.

Ist `script` auf dem Host nicht vorhanden, meldet der Agent die Capability
`interactive` nicht — die App blendet das Anlegen dann aus und erklärt warum,
statt einen Button anzubieten, der nicht funktionieren kann.

## Sicherheit

Das Token gibt **vollen Zugriff auf den Account**. Behandle es wie ein Passwort.

- Auf dem Server liegt es in `~/.config/uberapp/token` (Modus 600), bewusst
  *nicht* in der supervisord-.ini
- Auf dem Handy in Keychain/Keystore (`expo-secure-store`)
- Im Browser im `localStorage` — die App weist im Verbindungs-Screen darauf hin
- Vergleich des Tokens läuft konstantzeitig, unauthentifizierte Sockets fliegen
  nach 10 Sekunden raus, 120 Calls/Minute pro Verbindung
- `files.*` ist auf das Home-Verzeichnis eingesperrt; Symlinks werden vor der
  Prüfung aufgelöst, damit man nicht über einen Link herausspaziert

Der Agent kann alles, was du in der Shell kannst. Wer das Token hat, auch.

## Bekannte Einschränkungen

- **Node 22.13+ empfohlen.** React Native 0.86 verlangt es; mit 22.11 läuft der
  Build durch, gibt aber eine Engine-Warnung aus.
- `uberspace tools version` ist der einzige Aufruf, dessen genaue Ausgabe nicht
  gegen das Manual verifiziert wurde — die Versionsliste kann leer bleiben, wenn
  das Format abweicht. Der Rest der Parser ist an dokumentierten Ausgaben geprüft.
- Kein Datei-Upload. Für Deployments ist `rsync` über SSH besser als alles, was
  ein Handy anbieten kann.
- Der Agent ist auf einen Uberspace-Account ausgelegt, nicht auf mehrere.
