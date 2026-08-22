# Uberapp

*[Deutsch](README.md)*

Run an [Uberspace 7](https://uberspace.de) account from your phone: services,
domains, mailboxes, databases, backups — without a terminal.

An Expo app for **Android, iOS and web** talking to an agent that runs on the
Uberspace.

## Layout

```
 Phone ── wss:// ─▶ Agent :8399                <user>.uber.space/uberapp
   │
   └── scans QR ──▶ Broker :8400               uberapp.<user>.uber.space/connect
                        ▲
 Browser ── shows QR, collects handoff ─┘      uberapp.<user>.uber.space/
```

| Address | What | Why there |
| --- | --- | --- |
| `<user>.uber.space/uberapp` | agent | a path on the default domain: no DNS, certificate already there |
| `uberapp.<user>.uber.space/` | web view | its own DocumentRoot — an existing site is untouched |
| `uberapp.<user>.uber.space/connect` | broker | same origin as the view, nothing to configure |

A subdomain rather than a subdirectory, because the web export references its
assets from `/`. A subdomain of the *default* domain, because Uberspace resolves
any label under it.

| Package | Contents |
| --- | --- |
| `packages/protocol` | message types, method catalogue, validation, handoff format |
| `packages/agent` | WebSocket server on the Uberspace |
| `packages/connect` | broker for browser pairing |
| `apps/mobile` | Expo app |

## Security

**No command lines on the wire.** The app sends method names and typed
parameters; the agent maps them onto fixed `argv` arrays. A service name like
`evil; rm -rf ~` is rejected, not escaped.

**Tokens are bounded.** The master token lives in `~/.config/uberapp/token`
(mode 600). A paired browser gets its own expiring token and cannot issue more.

**The SSH password is discarded.** The simple setup needs it once and stores it
nowhere.

**The broker cannot read what it holds.** The browser generates a slot id and a
key and shows both as a QR code. The phone deposits the *sealed* handoff; the
browser collects it once. The key leaves the page only as pixels.

Also: constant-time token comparison, 10 s before an unauthenticated socket is
dropped, 120 calls/minute, `files.*` confined to the home directory (symlinks
resolved first).

> The agent can do anything you can do in a shell. So can whoever holds the
> master token.

## Setup

**From the app:** *Einfach einrichten* → host, user, password. The app connects
over SSH, installs the agent and fills in address and token itself. Needs a
custom dev build; Expo Go does not ship the native modules.

**From your machine:**

```bash
git clone https://github.com/conct/uberapp.git && cd uberapp
npm install && npm run build:web -w @uberapp/mobile
npm run setup -- isabell@stardust.uberspace.de
```

**On the host:**

```bash
git clone https://github.com/conct/uberapp.git ~/uberapp
bash ~/uberapp/packages/agent/deploy/install.sh
```

`install.sh` builds everything, creates the token, installs agent and broker,
publishes the web view. Re-running keeps an existing token.

```bash
curl https://<user>.uber.space/uberapp/healthz
curl https://uberapp.<user>.uber.space/connect/healthz
```

Several Uberspaces: the start screen shows them as tiles, each with its own
token. Tap to switch, long-press to remove (on the device only).

## Pairing a browser

Open `https://uberapp.<user>.uber.space`, then in the app *Übersicht → Gerät
koppeln → Code im Browser scannen*. The browser connects by itself.

The browser is a view only — SSH needs raw TCP, which it cannot open.

## Features

Services (status, start/stop, logs, `.ini`, creation wizard) · Web (domains,
DNS, backends, logs, certificates, headers, error page) · Mail (domains,
mailboxes, forwarding, catch-all, Sieve) · Databases (create, tables,
dump/import) · Backup (snapshots, preview, restore) · Ports (joined with `ss`,
so you see whether anything is listening) · Files · Cron · Diagnostics.

## Development

```bash
npm install
npm run build      # protocol, agent, connect
npm test           # 171 tests
npm run typecheck
npm run app        # Metro
```

`npm run app` goes through the workspace and starts in the right directory.
`npx expo start` from the repository root fails with
`Unable to resolve "../../App"`.

**Android locally:** `cd apps/mobile && npx expo run:android`. Three
prerequisites:

- CMake 3.30+ from the SDK Manager — the default 3.22.1 ships ninja 1.10, which
  rejects paths over 260 characters
- JDK 17 or 21, not 24 (JEP 472 breaks the CMake integration)
- `android/local.properties` with `sdk.dir=…` — a `prebuild` creates it empty,
  and without the SDK path the build hangs **with no output at all**

Cold build: 1 h 22 for all four ABIs, 28 min with
`UBERAPP_ANDROID_ABIS=arm64-v8a` in `apps/mobile/.env`. Off by default — built
that way it installs on no common emulator.

**Web view:** `npm run build:web -w @uberapp/mobile`. The result is committed
under `apps/mobile/web-dist`, because setup driven from the phone only fetches
what is in the repository.

## SSH on Hermes

`ssh2` runs on Hermes through six shims in `apps/mobile/src/shims/`:

| Gap | Symptom |
| --- | --- |
| `pause()` before `connect` | `No socket with id 0` |
| `setMaxListeners` missing (eventemitter3) | `undefined is not a function` |
| `writable`/`_readableState` missing | ssh2 never sent a byte |
| Buffer internals (`utf8Write` …) | died on the server banner |
| no `Symbol.species` | died on the first encrypted packet |
| kex offer with no overlap | "no matching key exchange algorithm" |

Usable: `ecdh-sha2-nistp*` and `diffie-hellman-group-exchange-sha256`. Not
curve25519 — `ssh2` gates it on `crypto.diffieHellman`, which quick-crypto does
not provide.

## Limits

- **No quota on the overview.** `quota -g` reports nothing from a supervisord
  service (group quota, service without the group). The app measures the
  directories instead.
- **No file upload.** `files.read` returns text up to 1 MB, no binaries.
- **Node 22.13+** recommended (RN 0.86); 22.11 works with a warning.
- **`uberspace tools version`** is the one unverified parser.
- **`.qmail` is not edited** — the manual advises against it and
  `.qmail-default` belongs to Uberspace. Rules go through Sieve.

## Licence and third parties

**This project has no licence yet.** Without a LICENSE file, default copyright
applies: you may look, but not use or fork. Anyone releasing it should choose a
licence and record it in `package.json` too.

The built artefacts — `apps/mobile/web-dist` and the APK — **contain
third-party code**. MIT and Apache-2.0 require the licence text and copyright
notice to travel with them. See [THIRD-PARTY.md](THIRD-PARTY.md).
