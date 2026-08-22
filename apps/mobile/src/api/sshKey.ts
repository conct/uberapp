/**
 * The key that ends the password.
 *
 * Generated on the device during the one setup that still needs an account
 * password. The public half is appended to ~/.ssh/authorized_keys over that
 * same session; the private half goes into the OS keystore and is handed to
 * ssh2 in memory, never written anywhere else. Every later run — a repair, a
 * re-install, the same host added again — then needs nothing typed.
 *
 * The encoding lives in @uberapp/protocol, where it is tested. This file is
 * only the two things that cannot: reaching the device's crypto, and reaching
 * its keystore.
 */

import { Platform } from 'react-native';

import { authorizedKeyLine, opensshPrivateKey } from '@uberapp/protocol';

export interface GeneratedKey {
  /** OpenSSH private key text. For ssh2, and for the keystore. */
  privateKey: string;
  /** The one line that goes into the host's authorized_keys. */
  authorizedKey: string;
}

/**
 * Everything that ends up in the authorized_keys line beside the base64.
 *
 * Restricted rather than escaped: the line is placed in a shell command by the
 * setup, and a comment is the only part of it a person could influence. The
 * base64 alphabet holds no shell metacharacters, and after this neither does
 * the comment.
 */
function safeComment(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9@._-]/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 60) : 'uberapp';
}

/**
 * An ed25519 key pair from the device's own crypto.
 *
 * Required lazily for the same reason the SSH transport is: a build without
 * the native module must be able to say so rather than fail at import time.
 * Anything calling this is already inside the SSH setup, which has checked.
 */
export function generateKey(comment: string): GeneratedKey {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('react-native-quick-crypto') as {
    generateKeyPairSync: (type: 'ed25519') => {
      publicKey: { export: (options: { format: 'raw-public' }) => Uint8Array };
      privateKey: { export: (options: { format: 'raw-seed' }) => Uint8Array };
    };
    randomBytes: (size: number) => Uint8Array;
  };

  // ed25519 and not RSA because quick-crypto generates nothing else; see the
  // note in @uberapp/protocol's sshkey.ts for why that decided the format too.
  //
  // The raw bytes come off the key objects rather than out of generateKeyPair:
  // 'raw-public' and 'raw-seed' are formats export() understands, not encodings
  // the generator accepts. Passing them there throws, which is how this first
  // reached a host reporting nothing but "skipped".
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKey = new Uint8Array(pair.publicKey.export({ format: 'raw-public' }));
  const seed = new Uint8Array(pair.privateKey.export({ format: 'raw-seed' }));
  const label = safeComment(comment);

  return {
    privateKey: opensshPrivateKey(seed, publicKey, label, new Uint8Array(crypto.randomBytes(4))),
    authorizedKey: authorizedKeyLine(publicKey, label),
  };
}

/**
 * The shell that installs the public half, idempotently.
 *
 * Written so a second run changes nothing: `grep -qxF` matches the whole line
 * literally, so an existing entry is left alone rather than duplicated. The
 * directory and file modes are set every time because sshd refuses a key it
 * finds in a world-readable file, silently — it simply does not authenticate,
 * with nothing in the client's error to say why.
 */
export function installKeyCommand(authorizedKey: string): string {
  const line = `'${authorizedKey}'`;
  return [
    'mkdir -p ~/.ssh',
    'chmod 700 ~/.ssh',
    'touch ~/.ssh/authorized_keys',
    'chmod 600 ~/.ssh/authorized_keys',
    `if ! grep -qxF ${line} ~/.ssh/authorized_keys; then printf '%s\\n' ${line} >> ~/.ssh/authorized_keys; fi`,
  ].join(' && ');
}

/** Keys are only ever kept where the OS can protect them. */
export const canStoreKeys = Platform.OS !== 'web';
