/**
 * Running the setup over SSH, from inside the app.
 *
 * This exists so the simple path can install the agent without the user ever
 * opening a terminal. It is also the one place in this codebase where the app
 * holds a credential that is not the agent token, so the rules around it are
 * deliberately narrow:
 *
 *   - The credentials are used for one provisioning run and then dropped. They
 *     are never written to storage, not even the secure one. What survives the
 *     run is the agent URL and its token, which is what the app needs from
 *     then on.
 *   - Nothing here is reachable on web. Browsers have no raw TCP sockets, so
 *     SSH cannot exist there at all — the app offers the manual path instead.
 *   - On native it needs a real SSH stack, which is native code, which Expo Go
 *     does not carry. Detection is at runtime and the reason is reported, so
 *     the screen can explain the situation rather than fail obscurely.
 */

import { Platform } from 'react-native';

export interface SshCredentials {
  host: string;
  user: string;
  /** One of these two. A key is preferable and usually already on the device. */
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface SshResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface SshAvailability {
  available: boolean;
  /** Shown to the user verbatim when unavailable. */
  reason: string | null;
  /** What they would have to do about it, when there is something. */
  remedy: string | null;
}

/**
 * The transport, kept behind an interface on purpose.
 *
 * The orchestration above it — which commands, in what order, what counts as
 * success — is the part worth getting right and the part that does not care
 * how bytes reach the host. Swapping the SSH implementation should not touch
 * anything else.
 */
export interface SshRunner {
  /** Collect the output of one command. */
  run(credentials: SshCredentials, command: string): Promise<SshResult>;
  /** Stream it instead, for the long-running install. */
  stream(
    credentials: SshCredentials,
    command: string,
    onOutput: (chunk: string) => void,
  ): Promise<SshResult>;
}

/**
 * Load the native SSH module if this build has one.
 *
 * Deliberately a require inside a try: on Expo Go the module is simply absent,
 * and that has to be an answer the UI can render, not a crash at import time.
 */
function loadNativeRunner(): SshRunner | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require('./ssh.native') as { createRunner?: () => SshRunner };
    return module.createRunner?.() ?? null;
  } catch {
    return null;
  }
}

let cached: SshRunner | null | undefined;

export function getSshRunner(): SshRunner | null {
  if (Platform.OS === 'web') return null;
  if (cached === undefined) cached = loadNativeRunner();
  return cached;
}

export function sshAvailability(): SshAvailability {
  if (Platform.OS === 'web') {
    return {
      available: false,
      reason:
        'Im Browser gibt es kein SSH. Browser können keine rohen TCP-Verbindungen öffnen, und SSH ist eines.',
      remedy: 'Nimm die fortgeschrittene Einrichtung, oder richte über die Handy-App ein.',
    };
  }

  if (getSshRunner() === null) {
    return {
      available: false,
      reason:
        'Diese App-Variante enthält kein SSH. Expo Go bringt einen festen Satz nativer Module mit, und SSH gehört nicht dazu.',
      remedy: 'Mit "npx expo run:android" einen eigenen Build erzeugen, oder die fortgeschrittene Einrichtung nehmen.',
    };
  }

  return { available: true, reason: null, remedy: null };
}

// --- validation ------------------------------------------------------------

export const RE_SSH_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
export const RE_SSH_USER = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * Accept what people paste: "stardust", "stardust.uberspace.de", or a whole
 * "isabell@stardust.uberspace.de". A bare host gets the uberspace.de suffix,
 * which is the only thing it can mean here.
 */
export function parseSshTarget(input: string): { user: string | null; host: string } {
  const trimmed = input.trim().toLowerCase().replace(/^ssh:\/\//, '');
  const at = trimmed.lastIndexOf('@');

  const user = at === -1 ? null : trimmed.slice(0, at);
  let host = at === -1 ? trimmed : trimmed.slice(at + 1);
  if (host && !host.includes('.')) host = `${host}.uberspace.de`;

  return { user: user || null, host };
}

export function credentialsProblem(credentials: SshCredentials): string | null {
  if (!credentials.host) return 'Trag den Host ein, z.B. stardust.uberspace.de';
  if (!RE_SSH_HOST.test(credentials.host)) return 'Das ist kein gültiger Hostname.';
  if (!credentials.user) return 'Trag deinen Uberspace-Benutzernamen ein.';
  if (!RE_SSH_USER.test(credentials.user)) {
    return 'Der Benutzername darf nur Kleinbuchstaben, Ziffern, - und _ enthalten.';
  }
  if (!credentials.password && !credentials.privateKey) {
    return 'Ohne Passwort oder Schlüssel kommt die App nicht auf den Host.';
  }
  return null;
}
