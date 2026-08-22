# Uberapp

*[Deutsche Fassung](README.md)*

Run an [Uberspace 7](https://uberspace.de) account from your phone: restart
services, create mailboxes, set up domains and backends, restore backups —
without a terminal, an SSH client, or typing command lines.

An Expo app for **Android, iOS and web** that talks to a small agent running on
the Uberspace itself.

---

## Contents

- [How the pieces fit](#how-the-pieces-fit)
- [Security model](#security-model)
- [Setup](#setup)
- [Pairing a browser](#pairing-a-browser)
- [What it can do](#what-it-can-do)
- [Development](#development)
- [SSH on Hermes](#ssh-on-hermes)
- [Known limits](#known-limits)

---

## How the pieces fit

Three things run on the Uberspace, each with a reason for its address:

```
   Phone (native)                             Uberspace
  ┌──────────────┐                      ┌────────────────────────┐
  │  Expo app    │ ── wss:// ─────────▶ │  Agent  :8399          │ ──▶ uberspace CLI
  │              │                      │  <user>.uber.space     │     supervisorctl
  │              │                      │  /uberapp              │     mysql, rsync …
  │   Camera ────┼── scans ───┐         └────────────────────────┘
  └──────────────┘            │
                              │         ┌────────────────────────┐
   Browser (desktop)          └────────▶│  Broker  :8400         │
  ┌──────────────┐  shows QR            │  uberapp.<user>        │
  │  Web view    │ ◀── collects ────────│  .uber.space/connect   │
  │              │                      └────────────────────────┘
  │              │ ── wss:// ──────────▶  straight to the agent
  └──────────────┘
```

| Address | What | Why there |
| --- | --- | --- |
| `<user>.uber.space/uberapp` | agent | a path on the default domain — no DNS needed, the certificate already exists |
| `uberapp.<user>.uber.space/` | web view | its own DocumentRoot, so an existing website is left alone |
| `uberapp.<user>.uber.space/connect` | broker | same origin as the view, so the browser derives it from its own address |

A subdomain rather than a subdirectory, because the exported web bundle
references its assets from `/`. A subdomain of the *default* domain, because
Uberspace resolves any label under it: no DNS record required, certificate
issued on the spot.

### Why an agent and not SSH directly

The app *can* speak SSH now (see [SSH on Hermes](#ssh-on-hermes)) and uses it for
first-time setup. For everyday use the agent is still the better route, because
of reach: an agent token can do exactly what the method catalogue lists and is
revoked with one tap. SSH access is a shell.

---

## Security model

Four decisions that explain the rest.

### 1. No command lines are transmitted

The app sends method names and typed parameters, never shell strings:

```json
{ "t": "call", "id": "c1", "method": "services.control",
  "params": { "name": "my-daemon", "action": "restart" } }
```

The agent maps that onto a fixed `argv` array. Every value passes an allowlist
first — a service name like `evil; rm -rf ~` is **rejected, not escaped**. There
is no path by which input reaches a shell.

One exception is named and argued: the command inside a supervisord `.ini`.
supervisord executes it, not the agent, and it is exactly what writing the file
by hand would produce. Even there a newline is refused, since it would inject
further directives.

### 2. Tokens are bounded and revocable

| | Master token | Pairing token |
| --- | --- | --- |
| lives in | `~/.config/uberapp/token`, mode 600 | hashed in `tokens.json` |
| may | everything in the catalogue, incl. issuing tokens | everything in the catalogue, **no** further tokens |
| expires | never | after the chosen period |
| revocable | only by replacing the file | one tap in the app |

A paired browser never receives the master token, only its own expiring one. It
cannot hand out further access either — otherwise revoking one would achieve
nothing, because it would already have issued more.

### 3. The SSH password is discarded

The simple setup needs it once, to install the agent. Afterwards it is thrown
away and stored nowhere. What remains is the agent token, a secret with a much
smaller blast radius.

### 4. The broker cannot read what it holds

When pairing a browser, **the browser** generates a slot id and a key and shows
both as a QR code. The phone reads it, mints an expiring token, and leaves the
**sealed** connection details with the broker. The browser collects them once
and then talks straight to the agent.

The key leaves the browser only as pixels — it never crosses a network. The
broker therefore holds bytes it cannot read, which makes it an uninteresting
target. It forgets every slot after two minutes, hands one out exactly once, and
never overwrites one.

### Further measures

- token comparison is constant-time
- unauthenticated connections are dropped after 10 seconds
- 120 calls per minute per connection
- `files.*` is confined to the home directory; symlinks are resolved **before**
  the check, so nobody walks out through a link

> **The agent can do anything you can do in a shell. So can whoever holds the
> master token.** On the phone it sits in the keychain; in a browser only in
> `localStorage` — which is why a browser gets its own, expiring token.

---

## Setup

### Path A — from the app (recommended)

Open the app → **Einfach einrichten** → enter host, username and password. The
app connects over SSH and runs five steps: check the host, fetch the project,
build and start the agent, expose it, confirm it answers. It then fills in the
address and token itself.

This needs a custom dev build — Expo Go does not ship the native modules SSH
requires.

### Path B — from your machine

```bash
git clone https://github.com/conct/uberapp.git && cd uberapp
npm install
npm run build:web -w @uberapp/mobile   # the web view, shipped along
npm run setup -- isabell@stardust.uberspace.de
```

### Path C — on the Uberspace itself

```bash
git clone https://github.com/conct/uberapp.git ~/uberapp && cd ~/uberapp
bash packages/agent/deploy/install.sh
```

`install.sh` checks the Node version, builds protocol, agent and broker, creates
the token (mode 600, deliberately **not** in the supervisord `.ini`), installs
both services, publishes the web view, and prints the address and token at the
end. Re-running is safe: an existing token is kept.

Check it:

```bash
curl https://<user>.uber.space/uberapp/healthz
curl https://uberapp.<user>.uber.space/connect/healthz
```

### Several Uberspaces

The app holds as many as you like. The start screen shows them as tiles, each
with its own token in the keychain. Tap to switch, long-press to remove — which
deletes only the token on the device; the agent on the host keeps running.

---

## Pairing a browser

1. Open `https://uberapp.<user>.uber.space` on the computer. The page shows a
   code and waits.
2. In the app: **Übersicht → Gerät koppeln → Code im Browser scannen**.
3. The browser connects by itself.

The browser is deliberately a **view**: running and failing services, usage,
status. Setup is not offered there — SSH needs raw TCP connections, which a
browser cannot open.

---

## What it can do

**Overview** — disk usage per directory, hungriest processes, host uptime and
load, a warning when a service is down.

**Services** — live status, start/stop/restart with confirmation,
`reread`+`update`, live logs, editing the `.ini`. A wizard creates new services
and sets up the port and web backend along the way.

**Web** — add and remove domains, show DNS records, map backends onto ports
(including `--remove-prefix`), toggle logs, certificate expiry, HTTP headers,
error page, permission repair.

**Mail** — mail domains, create and delete mailboxes, change passwords,
forwarding, catch-all, spam folder, and Sieve rules and filters.

**Databases** — create and drop MySQL databases, browse tables, take and restore
dumps.

**Backup** — browse snapshots, preview, restore, databases included.

**Ports** — list, open and close firewall ports. The list is joined with the
socket table (`ss`) so you can see whether anything is actually listening behind
an open port — and whether it listens on `0.0.0.0`/`::` rather than localhost.

**Files** — browse the home directory, view and edit text files, create, delete
and move.

**Cron & diagnostics** — cron entries in readable form, disk usage,
deleted-but-open files, memory, changing the shell.

---

## Development

```bash
npm install
npm run build          # protocol, agent, connect
npm test               # 165 tests
npm run typecheck
npm run app            # Metro for the app
```

> `npm run app` goes through the workspace and therefore always starts in the
> right directory. `npx expo start` from the repository root fails with
> `Unable to resolve "../../App"` — there is no `app.json` there.

### Layout

| Path | Contents |
| --- | --- |
| `packages/protocol` | message types, method catalogue, shared validation, handoff format |
| `packages/agent` | WebSocket server for the Uberspace |
| `packages/connect` | broker for browser pairing |
| `apps/mobile` | Expo app (Android / iOS / web) |

### Building Android locally

```bash
cd apps/mobile && npx expo run:android
```

Prerequisites on a Windows machine, each worth settling once:

- **CMake 3.30+** from the SDK Manager. Otherwise the Android Gradle Plugin uses
  its own default of 3.22.1, whose ninja 1.10 rejects paths over 260 characters —
  regardless of whether Windows has long paths enabled.
- **JDK 17 or 21**, not 24. From JDK 24 onward `System.load()` is restricted
  (JEP 472), which breaks the plugin's CMake integration.
- `android/local.properties` with `sdk.dir=…`. An `expo prebuild` creates the
  file empty; without the SDK path `expo run:android` hangs **with no output at
  all**.

A cold build compiles every native module once per architecture — the same work
four times, measured at 1 h 22 min. With

```
UBERAPP_ANDROID_ABIS=arm64-v8a
```

in `apps/mobile/.env` it stays at one. Off by default, because a package built
that way installs on no common emulator (those are x86_64).

### Building the web view

```bash
npm run build:web -w @uberapp/mobile
```

The result is committed under `apps/mobile/web-dist` and deployed by
`install.sh`. Shipped rather than built on the host on purpose: setup driven
from the phone only fetches what is in the repository, and building there would
pull in the app's entire dependency tree for a six megabyte result.

---

## SSH on Hermes

The simple setup speaks SSH straight from the app — using `ssh2`, a Node
library, on a JavaScript engine that is not Node. Six gaps sat between the two,
each documented where it was closed, in `src/shims/`:

| | Problem | Symptom |
| --- | --- | --- |
| 1 | `pause()` reaches for the native socket before it exists | `No socket with id 0` |
| 2 | `setMaxListeners` missing — the class extends eventemitter3 | `undefined is not a function` |
| 3 | `writable`/`_readableState` missing | ssh2 **never** sent a byte |
| 4 | Buffer's undocumented internals (`utf8Write` and friends) | died reading the server banner |
| 5 | Hermes has no `Symbol.species` | died on the first encrypted packet |
| 6 | offered algorithms with no overlap with the host | "no matching key exchange algorithm" |

Number 3 is the instructive one: ssh2 sends every byte through
`if (isWritable(sock))`, and that check reads Node internals. It was always
false, so the connection stayed mute — the server banner arrived and then
nothing. Nothing reported an error.

What is usable is therefore `ecdh-sha2-nistp*` and
`diffie-hellman-group-exchange-sha256`; not curve25519, because `ssh2` gates it
on `crypto.diffieHellman`, which quick-crypto does not provide.

---

## Known limits

- **No quota on the overview.** `quota -g` reports nothing from a supervisord
  service: the Uberspace quota is a group quota, and supervisord starts services
  with no supplementary groups. The app measures the account's own directories
  instead and says that this is not your limit.
- **No file upload.** `files.read` returns text up to 1 MB and refuses binary
  files outright. For deployments `rsync` over SSH beats anything a phone can
  offer.
- **Node 22.13+ recommended.** React Native 0.86 asks for it; 22.11 works but
  prints an engine warning.
- **`uberspace tools version`** is the one parser whose output was never checked
  against the manual — the version list may come back empty.
- **`.qmail` files are not edited.** The manual advises against it, and
  `.qmail-default` belongs to Uberspace itself. Rules and filters go through
  Sieve.

---

## License

See [LICENSE](LICENSE) if present — otherwise: private project.
