#!/usr/bin/env bash
#
# Install the Uberapp agent on an Uberspace 7 account.
# Run this ON the Uberspace host, from the repository root:
#
#   bash packages/agent/deploy/install.sh
#
# It is safe to re-run: an existing token is kept.

set -euo pipefail

PORT="${UBERAPP_PORT:-8399}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TOKEN_FILE="$HOME/.config/uberapp/token"
SERVICE_FILE="$HOME/etc/services.d/uberapp-agent.ini"

# The handoff broker, installed alongside. It is a separate process on a
# separate port with no token and no state, so it neither shares the agent's
# credentials nor takes them down with it if it crashes.
CONNECT_PORT="${UBERAPP_CONNECT_PORT:-8400}"
CONNECT_SERVICE_FILE="$HOME/etc/services.d/uberapp-connect.ini"

# The web view and the broker share one subdomain of the default domain.
# Sharing an origin means the browser derives the broker from its own
# address and needs no configuration; a subdomain rather than a path means
# the exported bundle's absolute asset paths resolve, and a subdomain of
# the *default* domain means no DNS record has to exist anywhere.
#
# Its own DocumentRoot, deliberately: the account's html/ directory usually
# holds a real site, and this must not go anywhere near it.
WEB_DOMAIN="uberapp.${USER}.uber.space"
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

# --- build -----------------------------------------------------------------

say "Installing dependencies"
cd "$REPO_DIR"
# Only the two workspaces the agent needs: pulling in the Expo app as well
# would cost several hundred megabytes of a 10 GB quota for nothing.
#
# devDependencies are required, not optional — the agent is compiled here, and
# --omit=dev would leave tsc without @types/ws and friends.
npm install --include-workspace-root -w @uberapp/protocol -w @uberapp/agent

say "Building agent"
npm run build

if [ ! -f "$REPO_DIR/packages/agent/dist/index.js" ]; then
  echo "Build did not produce packages/agent/dist/index.js" >&2
  exit 1
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

say "Installing the supervisord service"
mkdir -p "$HOME/etc/services.d" "$HOME/logs"
sed "s|UBERAPP_PORT=\"8399\"|UBERAPP_PORT=\"$PORT\"|" \
  "$REPO_DIR/packages/agent/deploy/uberapp-agent.ini" > "$SERVICE_FILE"

supervisorctl reread
supervisorctl update

# update only starts a service whose config changed. On a re-run the .ini is
# usually identical while the code underneath is new, so restart explicitly —
# otherwise the old build keeps running and the install looks like a no-op.
if supervisorctl status uberapp-agent >/dev/null 2>&1; then
  supervisorctl restart uberapp-agent || true
fi

sleep 3
supervisorctl status uberapp-agent || true

say "Installing the handoff broker"
sed "s|PORT=\"8400\"|PORT=\"$CONNECT_PORT\"|"   "$REPO_DIR/packages/connect/deploy/uberapp-connect.ini" > "$CONNECT_SERVICE_FILE"

supervisorctl reread
supervisorctl update

if supervisorctl status uberapp-connect >/dev/null 2>&1; then
  supervisorctl restart uberapp-connect || true
fi

sleep 3
supervisorctl status uberapp-connect || true

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

  echo "  https://$WEB_DOMAIN"
else
  say "No web view to publish"
  echo "  $WEB_SOURCE does not exist. Build it with:"
  echo "    npm run build:web -w @uberapp/mobile"
fi

# --- web backend -----------------------------------------------------------

say "Web backend"
cat <<INSTRUCTIONS
The agent is listening on port $PORT, but only inside the host. To reach it
from the app, route a path (or a whole domain) to it. Pick ONE:

  # a) a dedicated subdomain -- cleanest, nothing else on that domain
  uberspace web domain add uberapp.YOUR-DOMAIN.tld
  uberspace web backend set uberapp.YOUR-DOMAIN.tld/ --http --port $PORT

  # b) a path on a domain you already use
  uberspace web backend set /uberapp --http --port $PORT --remove-prefix

Then check it:
  curl https://uberapp.YOUR-DOMAIN.tld/healthz

INSTRUCTIONS

say "Connection details for the app"
echo "  URL:   wss://<the domain or path you configured>"
echo "  Token: $(cat "$TOKEN_FILE")"
echo
echo "Treat that token like a password: it grants full control of this account."
