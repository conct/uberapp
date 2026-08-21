/**
 * The SSH transport, on native.
 *
 * ssh2 is a Node library. It runs here because Metro points its Node imports
 * at replacements — node:net at react-native-tcp-socket, node:crypto at
 * react-native-quick-crypto — which is why this file exists separately and is
 * loaded through a guarded require: on a build without those native modules,
 * importing it throws, and the caller reports that as "not available here"
 * rather than crashing.
 *
 * The algorithm list below is not decoration. Left to itself ssh2 prefers
 * curve25519 key exchange and ed25519 host keys, and the crypto shim does not
 * implement those. Restricting the offer to classic Diffie-Hellman and RSA
 * keeps the handshake inside what is actually available — Uberspace hosts
 * offer both. If a future host does not, the failure is a clear "no matching
 * algorithm" rather than a mysterious hang.
 */

import { Client, type ConnectConfig } from 'ssh2';
import { Buffer } from 'buffer';

import type { SshCredentials, SshResult, SshRunner } from './ssh';

/** Everything here has a working implementation in the crypto shim. */
const ALGORITHMS: ConnectConfig['algorithms'] = {
  kex: ['diffie-hellman-group14-sha256', 'diffie-hellman-group16-sha512'],
  serverHostKey: ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
  cipher: ['aes256-ctr', 'aes192-ctr', 'aes128-ctr'],
  hmac: ['hmac-sha2-256', 'hmac-sha2-512'],
  // Compression would need zlib, which is stubbed out for this build.
  compress: ['none'],
};

const CONNECT_TIMEOUT_MS = 20_000;
/** Long enough for a build on a shared host, short enough to not hang forever. */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

function toConnectConfig(credentials: SshCredentials): ConnectConfig {
  const base: ConnectConfig = {
    host: credentials.host,
    port: 22,
    username: credentials.user,
    algorithms: ALGORITHMS,
    readyTimeout: CONNECT_TIMEOUT_MS,
  };

  if (credentials.privateKey) {
    return {
      ...base,
      privateKey: Buffer.from(credentials.privateKey, 'utf8'),
      ...(credentials.passphrase ? { passphrase: credentials.passphrase } : {}),
    };
  }

  return {
    ...base,
    password: credentials.password,
    // Uberspace answers password auth as keyboard-interactive on some hosts;
    // without this the connection fails with "All authentication methods
    // failed" even though the password is right.
    tryKeyboard: true,
  };
}

/**
 * Turn a failure into something a person can act on.
 *
 * ssh2's own messages are accurate and unhelpful in equal measure; these are
 * the three that actually happen.
 */
function describe(error: Error): string {
  const message = error.message || String(error);
  if (/All configured authentication methods failed/i.test(message)) {
    return 'Anmeldung abgelehnt. Stimmen Benutzername und Passwort? Bei einem Schlüssel: ist er auf dem Host hinterlegt?';
  }
  if (/no matching (key exchange|host key|cipher)/i.test(message)) {
    return `Der Host bietet keinen Algorithmus an, den diese App beherrscht (${message}).`;
  }
  if (/ETIMEDOUT|timed out|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(message)) {
    return `Der Host ist nicht erreichbar (${message}).`;
  }
  return message;
}

function withConnection<T>(
  credentials: SshCredentials,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const client = new Client();
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        /* already gone */
      }
      fn();
    };

    client.on('ready', () => {
      work(client).then(
        (value) => finish(() => resolve(value)),
        (err: Error) => finish(() => reject(new Error(describe(err)))),
      );
    });

    client.on('error', (err: Error) => finish(() => reject(new Error(describe(err)))));

    // Some hosts route password auth through keyboard-interactive.
    client.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finishPrompt) => {
      finishPrompt(credentials.password ? [credentials.password] : []);
    });

    try {
      client.connect(toConnectConfig(credentials));
    } catch (err) {
      finish(() => reject(new Error(describe(err as Error))));
    }
  });
}

function exec(
  client: Client,
  command: string,
  onOutput?: (chunk: string) => void,
): Promise<SshResult> {
  return new Promise<SshResult>((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }

      let stdout = '';
      let stderr = '';
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        stream.close();
        reject(new Error('Der Befehl hat zu lange gebraucht und wurde abgebrochen.'));
      }, COMMAND_TIMEOUT_MS);

      stream.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdout += text;
        onOutput?.(text);
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderr += text;
        onOutput?.(text);
      });
      stream.on('close', (code: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? null });
      });
    });
  });
}

export function createRunner(): SshRunner {
  return {
    run: (credentials, command) =>
      withConnection(credentials, (client) => exec(client, command)),
    stream: (credentials, command, onOutput) =>
      withConnection(credentials, (client) => exec(client, command, onOutput)),
  };
}
