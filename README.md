# Uberapp

*[English](README.en.md)*

Einen [Uberspace 7](https://uberspace.de) vom Handy verwalten: Dienste, Domains,
Postfächer, Datenbanken, Backups — ohne Terminal.

Expo-App für **Android, iOS und Web**, die mit einem Agenten spricht, der auf dem
Uberspace läuft.

## Aufbau

```
 Handy ── wss:// ─▶ Agent :8399                <user>.uber.space/uberapp
   │                                           
   └── scannt QR ─▶ Vermittler :8400           uberapp.<user>.uber.space/connect
                          ▲
 Browser ── zeigt QR, holt Übergabe ──┘        uberapp.<user>.uber.space/
```

| Adresse | Was | Warum dort |
| --- | --- | --- |
| `<user>.uber.space/uberapp` | Agent | Pfad auf der Standard-Domain: kein DNS, Zertifikat vorhanden |
| `uberapp.<user>.uber.space/` | Web-Ansicht | eigene DocumentRoot — die bestehende Website bleibt unberührt |
| `uberapp.<user>.uber.space/connect` | Vermittler | gleiche Herkunft wie die Ansicht, nichts zu konfigurieren |

Unterdomain statt Unterordner, weil der Web-Export seine Dateien ab `/`
referenziert. Unterdomain der *Standard*-Domain, weil Uberspace dort jede
Bezeichnung auflöst.

| Paket | Inhalt |
| --- | --- |
| `packages/protocol` | Nachrichtentypen, Methodenkatalog, Validierung, Übergabe-Format |
| `packages/agent` | WebSocket-Server auf dem Uberspace |
| `packages/connect` | Vermittler für die Browser-Kopplung |
| `apps/mobile` | Expo-App |

## Sicherheit

**Keine Kommandozeilen über die Leitung.** Die App schickt Methodennamen und
typisierte Parameter; der Agent bildet sie auf feste `argv`-Arrays ab. Ein
Dienstname wie `evil; rm -rf ~` wird abgelehnt, nicht maskiert.

**Token sind begrenzt.** Das Master-Token liegt in `~/.config/uberapp/token`
(Modus 600). Ein gekoppelter Browser bekommt ein eigenes, ablaufendes Token und
darf damit keine weiteren ausgeben.

**Das SSH-Passwort wird verworfen.** Die einfache Einrichtung braucht es einmal
und speichert es nirgends.

**Der Vermittler kann nicht mitlesen.** Der Browser erzeugt Platzkennung und
Schlüssel und zeigt beides als QR. Das Handy legt die *verschlüsselte* Übergabe
ab, der Browser holt sie einmal. Der Schlüssel verlässt die Seite nur als
Bildpunkte.

Außerdem: konstantzeitiger Token-Vergleich, 10 s bis zum Rauswurf ohne Auth,
120 Aufrufe/Minute, `files.*` aufs Home eingesperrt (Symlinks vorher aufgelöst).

> Der Agent kann alles, was du in der Shell kannst. Wer das Master-Token hat, auch.

## Einrichtung

**Aus der App:** *Einfach einrichten* → Host, Benutzer, Passwort. Die App meldet
sich per SSH an, installiert den Agenten und trägt Adresse und Token selbst ein.
Braucht einen eigenen Dev-Build; Expo Go hat die nativen Module nicht.

**Vom Rechner:**

```bash
git clone https://github.com/conct/uberapp.git && cd uberapp
npm install && npm run build:web -w @uberapp/mobile
npm run setup -- isabell@stardust.uberspace.de
```

**Auf dem Host:**

```bash
git clone https://github.com/conct/uberapp.git ~/uberapp
bash ~/uberapp/packages/agent/deploy/install.sh
```

`install.sh` baut alles, legt das Token an, installiert Agent und Vermittler,
veröffentlicht die Web-Ansicht. Erneutes Ausführen behält ein vorhandenes Token.

```bash
curl https://<user>.uber.space/uberapp/healthz
curl https://uberapp.<user>.uber.space/connect/healthz
```

Mehrere Uberspaces: der Startbildschirm zeigt sie als Kacheln, jede mit eigenem
Token. Antippen wechselt, langes Drücken entfernt (nur auf dem Gerät).

## Browser koppeln

`https://uberapp.<user>.uber.space` öffnen, in der App *Übersicht → Gerät
koppeln → Code im Browser scannen*. Der Browser verbindet sich selbst.

Der Browser ist nur Ansicht — SSH braucht rohe TCP-Verbindungen, die er nicht hat.

## Funktionen

Dienste (Status, Start/Stop, Logs, `.ini`, Anlege-Assistent) · Web (Domains,
DNS, Backends, Logs, Zertifikate, Header, Fehlerseite) · Mail (Domains,
Postfächer, Weiterleitung, Catch-all, Sieve) · Datenbanken (anlegen, Tabellen,
Dump/Import) · Backup (Snapshots, Vorschau, Wiederherstellung) · Ports (mit
`ss`-Abgleich, ob überhaupt etwas lauscht) · Dateien · Cron · Diagnose.

## Entwicklung

```bash
npm install
npm run build      # protocol, agent, connect
npm test           # 222 Tests
npm run typecheck
npm run app        # Metro
```

`npm run app` startet über den Workspace im richtigen Verzeichnis. `npx expo
start` im Repo-Stamm scheitert mit `Unable to resolve "../../App"`.

**Android lokal:** `cd apps/mobile && npx expo run:android`. Drei Voraussetzungen:

- CMake 3.30+ aus dem SDK Manager — die Voreinstellung 3.22.1 bringt ninja 1.10,
  das Pfade über 260 Zeichen ablehnt
- JDK 17 oder 21, nicht 24 (JEP 472 bricht die CMake-Anbindung)
- `android/local.properties` mit `sdk.dir=…` — ein `prebuild` legt sie leer an,
  und ohne SDK-Pfad hängt der Build **ohne jede Ausgabe**

Kaltbau: 1 h 22 (alle vier ABIs) bzw. 28 min mit
`UBERAPP_ANDROID_ABIS=arm64-v8a` in `apps/mobile/.env`. Standardmäßig aus — so
gebaut läuft es auf keinem üblichen Emulator.

**Web-Ansicht:** `npm run build:web -w @uberapp/mobile`. Das Ergebnis liegt
versioniert in `apps/mobile/web-dist`, weil die Einrichtung aus der App nur holt,
was im Repo liegt.

## SSH unter Hermes

`ssh2` läuft auf Hermes, über sechs Ersatzstücke in `apps/mobile/src/shims/`:

| Lücke | Symptom |
| --- | --- |
| `pause()` vor `connect` | `No socket with id 0` |
| `setMaxListeners` fehlt (eventemitter3) | `undefined is not a function` |
| `writable`/`_readableState` fehlen | ssh2 sendete nie ein Byte |
| Buffer-Interna (`utf8Write` …) | Tod beim Server-Banner |
| kein `Symbol.species` | Tod beim ersten verschlüsselten Paket |
| Kex-Angebot ohne Überschneidung | „no matching key exchange algorithm" |

Nutzbar: `ecdh-sha2-nistp*` und `diffie-hellman-group-exchange-sha256`.
Curve25519 nicht — `ssh2` knüpft es an `crypto.diffieHellman`, das
quick-crypto nicht hat.

## Grenzen

- **Kein Kontingent auf der Übersicht.** `quota -g` liefert aus einem
  supervisord-Dienst nichts (Gruppen-Kontingent, Dienst ohne Gruppe). Die App
  misst stattdessen die Verzeichnisse.
- **Kein Datei-Upload.** `files.read` liefert Text bis 1 MB, Binärdateien gar nicht.
- **Node 22.13+** empfohlen (RN 0.86); 22.11 läuft mit Warnung.
- **`uberspace tools version`** ist der einzige ungeprüfte Parser.
- **`.qmail` wird nicht bearbeitet** — das Handbuch rät ab, `.qmail-default`
  gehört Uberspace. Regeln laufen über Sieve.

## Lizenz und Drittanbieter

[MIT](LICENSE) — benutzen, ändern, weitergeben und verkaufen ist erlaubt,
solange der Copyright-Vermerk mitgeht. Keine Pflicht, deine Änderungen
offenzulegen.

Die ausgelieferten Pakete — `apps/mobile/web-dist` und das APK — **enthalten
fremden Code**. MIT und Apache-2.0 verlangen, dass Lizenztext und
Copyright-Vermerk mitgehen. Siehe [THIRD-PARTY.md](THIRD-PARTY.md).
