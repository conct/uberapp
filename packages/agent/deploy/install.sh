#!/usr/bin/env bash
#
# Install the uberCTRL agent on an Uberspace 7 account.
# Run this ON the Uberspace host, from the repository root:
#
#   bash packages/agent/deploy/install.sh
#
# It is safe to re-run: an existing token is kept.

set -euo pipefail

PORT="${UBERCTRL_PORT:-8399}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TOKEN_FILE="$HOME/.config/uberctrl/token"
SERVICE_FILE="$HOME/etc/services.d/uberctrl-agent.ini"

# The handoff broker, installed alongside. It is a separate process on a
# separate port with no token and no state, so it neither shares the agent's
# credentials nor takes them down with it if it crashes.
CONNECT_PORT="${UBERCTRL_CONNECT_PORT:-8400}"
CONNECT_SERVICE_FILE="$HOME/etc/services.d/uberctrl-connect.ini"

# The web view and the broker share one subdomain of the default domain.
# Sharing an origin means the browser derives the broker from its own
# address and needs no configuration; a subdomain rather than a path means
# the exported bundle's absolute asset paths resolve, and a subdomain of
# the *default* domain means no DNS record has to exist anywhere.
#
# Its own DocumentRoot, deliberately: the account's html/ directory usually
# holds a real site, and this must not go anywhere near it.
WEB_DOMAIN="uberctrl.${USER}.uber.space"
WEB_ROOT="/var/www/virtual/${USER}/${WEB_DOMAIN}"
WEB_SOURCE="$REPO_DIR/apps/mobile/web-dist"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# --- sanity checks ---------------------------------------------------------

if [ ! -f "$REPO_DIR/package.json" ]; then
  echo "Could not find the repository root (looked in $REPO_DIR)." >&2
  exit 1
fi

if ! command -v uberspace >/dev/null 2>&1; then
  echo "This does not look like an Uberspace host: no 'uberspace' command." >&2
  exit 1
fi

say "Checking Node version"
NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node $NODE_MAJOR is too old. Switching to Node 22..."
  uberspace tools version use node 22
  echo "Node switched. Open a new shell (or re-source your profile) and run this script again."
  exit 1
fi
echo "Node $(node -v) OK"

# supervisord spawns without a login shell, so PATH does not carry the Node
# version the account selected - a service whose command is a bare `node`
# dies with "ERROR (spawn error)" and keeps the reason to itself. Bake the
# path in at install time, while a login shell is what we are running under.
NODE_BIN="$(command -v node)"

# The same reasoning covers everything the agent itself starts - npm and git
# during a self-update. supervisord hands its own environment to the process,
# so the PATH this script has, which is a login shell's, is recorded in the
# service file. supervisord expands %(...)s in its configs, so a literal
# percent has to be doubled on the way in.
AGENT_PATH="$(printf '%s' "$PATH" | sed 's/%/%%/g')"

# --- build -----------------------------------------------------------------

say "Installing dependencies"
cd "$REPO_DIR"
# Only the two workspaces the agent needs: pulling in the Expo app as well
# would cost several hundred megabytes of a 10 GB quota for nothing.
#
# devDependencies are required, not optional — the agent is compiled here, and
# --omit=dev would leave tsc without @types/ws and friends.
npm install --include-workspace-root -w @uberctrl/protocol -w @uberctrl/agent

say "Building agent"
npm run build

if [ ! -f "$REPO_DIR/packages/agent/dist/index.js" ]; then
  echo "Build did not produce packages/agent/dist/index.js" >&2
  exit 1
fi

# --- carried over from the old name ----------------------------------------

# This project was called uberapp until 2026-08-24. A host installed under that
# name keeps its token, registrar credentials and orders in ~/.config/uberapp,
# and runs its services and web route under the old name. None of that survives
# a rename by itself, so move what matters and clear away what is now broken.
# All of it is conditional: on a fresh host this whole block is a handful of
# failed tests.

LEGACY_CONFIG="$HOME/.config/uberapp"
NEW_CONFIG="$HOME/.config/uberctrl"

if [ -d "$LEGACY_CONFIG" ] && [ ! -d "$NEW_CONFIG" ]; then
  say "Carrying your settings over from the old name"
  mkdir -p "$(dirname "$NEW_CONFIG")"
  mv "$LEGACY_CONFIG" "$NEW_CONFIG"
  echo "Moved $LEGACY_CONFIG to $NEW_CONFIG - token and credentials kept."
fi

for legacy_service in uberapp-agent uberapp-connect; do
  legacy_ini="$HOME/etc/services.d/${legacy_service}.ini"
  if [ -f "$legacy_ini" ]; then
    say "Removing the old service $legacy_service"
    supervisorctl stop "$legacy_service" >/dev/null 2>&1 || true
    rm -f "$legacy_ini"
    supervisorctl reread >/dev/null 2>&1 || true
    supervisorctl update >/dev/null 2>&1 || true
  fi
done

# The old route points at a port nothing listens on any more, so it answers 502
# rather than nothing - worth removing rather than leaving to puzzle over.
if command -v uberspace >/dev/null 2>&1; then
  if uberspace web backend list 2>/dev/null | grep -q "^/uberapp "; then
    say "Removing the old web route /uberapp"
    uberspace web backend del /uberapp >/dev/null 2>&1 || true
  fi

  LEGACY_WEB="uberapp.${USER}.uber.space"
  if uberspace web domain list 2>/dev/null | grep -qx "$LEGACY_WEB"; then
    say "Removing the old web address $LEGACY_WEB"
    uberspace web backend del "$LEGACY_WEB/connect" >/dev/null 2>&1 || true
    uberspace web domain del "$LEGACY_WEB" >/dev/null 2>&1 || true
  fi

  # Reported rather than deleted, both of them. Removing a directory under
  # /var/www from a shell variable is how the wrong thing gets deleted, and
  # neither of these holds anything that is not reproducible.
  if [ -d "$HOME/uberapp/.git" ] && [ "$REPO_DIR" != "$HOME/uberapp" ]; then
    echo "Left behind: $HOME/uberapp - the old checkout, nothing of yours in it."
  fi
  if [ -d "/var/www/virtual/${USER}/$LEGACY_WEB" ]; then
    echo "Left behind: /var/www/virtual/${USER}/$LEGACY_WEB - the old web bundle."
    echo "Remove either yourself once you are sure, with rm -rf."
  fi
fi

# --- token -----------------------------------------------------------------

say "Setting up the access token"
mkdir -p "$(dirname "$TOKEN_FILE")"
if [ -s "$TOKEN_FILE" ]; then
  echo "Keeping the existing token in $TOKEN_FILE"
else
  head -c 32 /dev/urandom | base64 | tr -d '\n' > "$TOKEN_FILE"
  echo "Generated a new token."
fi
chmod 600 "$TOKEN_FILE"

# --- service ---------------------------------------------------------------

# supervisorctl reports a failed start as "ERROR (spawn error)" and puts the
# actual reason in supervisord's own log. Somebody setting up from the phone
# sees only this output, so fetch it rather than leaving them with two words.
report_service() {
  service_status="$(supervisorctl status "$1" 2>&1 || true)"
  echo "$service_status"
  case "$service_status" in
    *BACKOFF*|*FATAL*|*EXITED*|*"spawn error"*)
      echo "$1 did not start. supervisord's reason:"
      grep -F "$1" "$HOME/logs/supervisord/supervisord.log" 2>/dev/null | tail -n 10 || true
      tail -n 20 "$HOME/logs/$1.log" 2>/dev/null || true
      ;;
  esac
}

say "Installing the supervisord service"
mkdir -p "$HOME/etc/services.d" "$HOME/logs"
sed -e "s|UBERCTRL_PORT=\"8399\"|UBERCTRL_PORT=\"$PORT\"|" \
    -e "s|^command=node |command=$NODE_BIN |" \
    -e "s|PATH=\"AGENT_PATH\"|PATH=\"$AGENT_PATH\"|" \
  "$REPO_DIR/packages/agent/deploy/uberctrl-agent.ini" > "$SERVICE_FILE"

supervisorctl reread
supervisorctl update

# update only starts a service whose config changed. On a re-run the .ini is
# usually identical while the code underneath is new, so restart explicitly —
# otherwise the old build keeps running and the install looks like a no-op.
if supervisorctl status uberctrl-agent >/dev/null 2>&1; then
  supervisorctl restart uberctrl-agent || true
fi

sleep 3
report_service uberctrl-agent

say "Installing the handoff broker"
sed -e "s|PORT=\"8400\"|PORT=\"$CONNECT_PORT\"|" \
    -e "s|^command=node |command=$NODE_BIN |" \
  "$REPO_DIR/packages/connect/deploy/uberctrl-connect.ini" > "$CONNECT_SERVICE_FILE"

supervisorctl reread
supervisorctl update

if supervisorctl status uberctrl-connect >/dev/null 2>&1; then
  supervisorctl restart uberctrl-connect || true
fi

sleep 3
report_service uberctrl-connect

# --- web view --------------------------------------------------------------

if [ -d "$WEB_SOURCE" ]; then
  say "Publishing the web view"

  # Adding a domain that is already there is not an error worth stopping for.
  uberspace web domain add "$WEB_DOMAIN" >/dev/null 2>&1 || true
  uberspace web backend set "$WEB_DOMAIN/connect" --http --port "$CONNECT_PORT" --remove-prefix     >/dev/null 2>&1 || true

  mkdir -p "$WEB_ROOT"
  # --delete so a renamed bundle does not leave its predecessor behind; the
  # target is a directory this script created and owns.
  rsync -a --delete "$WEB_SOURCE/" "$WEB_ROOT/"

  # After the rsync, not before: --delete would take these with it. They are
  # the two pages a paying customer is sent back to, and they have to exist
  # before a payment provider is ever pointed at them.
  mkdir -p "$WEB_ROOT/kasse"
  cp "$REPO_DIR/packages/agent/deploy/checkout/danke.html" "$WEB_ROOT/kasse/danke.html"
  cp "$REPO_DIR/packages/agent/deploy/checkout/abgebrochen.html" "$WEB_ROOT/kasse/abgebrochen.html"

  echo "  https://$WEB_DOMAIN"
  echo "  https://$WEB_DOMAIN/kasse/danke.html       <- successUrl"
  echo "  https://$WEB_DOMAIN/kasse/abgebrochen.html <- cancelUrl"
else
  say "No web view to publish"
  echo "  $WEB_SOURCE does not exist. Build it with:"
  echo "    npm run build:web -w @uberctrl/mobile"
fi

# --- web backend -----------------------------------------------------------

say "Web backend"
cat <<INSTRUCTIONS
The agent is listening on port $PORT, but only inside the host. To reach it
from the app, route a path (or a whole domain) to it. Pick ONE:

  # a) a dedicated subdomain -- cleanest, nothing else on that domain
  uberspace web domain add uberctrl.YOUR-DOMAIN.tld
  uberspace web backend set uberctrl.YOUR-DOMAIN.tld/ --http --port $PORT

  # b) a path on a domain you already use
  uberspace web backend set /uberctrl --http --port $PORT --remove-prefix

Then check it:
  curl https://uberctrl.YOUR-DOMAIN.tld/healthz

INSTRUCTIONS

say "Connection details for the app"
echo "  URL:   wss://<the domain or path you configured>"
echo "  Token: $(cat "$TOKEN_FILE")"
echo
echo "Treat that token like a password: it grants full control of this account."
