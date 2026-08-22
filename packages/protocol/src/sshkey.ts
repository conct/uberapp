/**
 * An ed25519 key pair, in the two shapes SSH actually wants.
 *
 * The point of this file is to end the password. The simple setup needs an
 * account password once, to log in and install the agent; every later run —
 * a re-install, a repair, adding the same host again — asked for it afresh,
 * because nothing was left behind that could stand in for it. A key can: the
 * public half goes into ~/.ssh/authorized_keys on the host, the private half
 * stays in the device keystore, and no password is ever needed again.
 *
 * Why ed25519, and why this encoding, are both forced rather than chosen:
 *
 *   - react-native-quick-crypto generates ed25519 and nothing else. Its
 *     generateKeyPair falls through to an unimplemented branch for 'rsa',
 *     'ec' and the rest, so RSA was never an option on the device.
 *   - ssh2's parseKey rejects a PKCS#8 ed25519 PEM ("Unsupported key format"),
 *     which is the only PEM quick-crypto can export. So the private key has to
 *     be written in OpenSSH's own container, built here from the raw 32-byte
 *     seed and public key.
 *
 * The result parses in ssh2, reports itself as ssh-ed25519, and signs and
 * verifies — checked against ssh2 directly before this was written.
 */

/** Standard base64 with padding, which is what both SSH encodings use. */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function uint32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

/** SSH's one composite type: a 32-bit length followed by that many bytes. */
function sshString(value: Uint8Array | string): Uint8Array {
  const bytes =
    typeof value === 'string' ? new Uint8Array([...value].map((c) => c.charCodeAt(0))) : value;
  return concat([uint32(bytes.length), bytes]);
}

const KEY_TYPE = 'ssh-ed25519';

/** The wire form of the public key: the type name, then the 32 raw bytes. */
function publicBlob(publicKey: Uint8Array): Uint8Array {
  return concat([sshString(KEY_TYPE), sshString(publicKey)]);
}

/** The single line that goes into ~/.ssh/authorized_keys. */
export function authorizedKeyLine(publicKey: Uint8Array, comment: string): string {
  return `${KEY_TYPE} ${toBase64(publicBlob(publicKey))} ${comment}`;
}

/**
 * The private key, in OpenSSH's container.
 *
 * Unencrypted — cipher "none", kdf "none". The file never touches disk in the
 * clear: it lives in the device keystore and is handed to ssh2 in memory. A
 * passphrase would have to be stored beside it to be usable unattended, which
 * protects nothing.
 *
 * `check1` and `check2` are OpenSSH's way of telling a wrong passphrase from a
 * corrupt file: they must match after decryption. With no encryption they are
 * simply two equal values, and since nothing here is secret, a counter would
 * do — but they are the caller's random bytes, because that is what every
 * other implementation writes and a reader comparing files should not find a
 * surprise.
 */
export function opensshPrivateKey(
  seed: Uint8Array,
  publicKey: Uint8Array,
  comment: string,
  check: Uint8Array,
): string {
  if (seed.length !== 32) throw new Error(`ed25519 seed must be 32 bytes, got ${seed.length}`);
  if (publicKey.length !== 32) {
    throw new Error(`ed25519 public key must be 32 bytes, got ${publicKey.length}`);
  }
  if (check.length !== 4) throw new Error(`check bytes must be 4, got ${check.length}`);

  let inner = concat([
    check,
    check,
    sshString(KEY_TYPE),
    sshString(publicKey),
    // OpenSSH keeps seed and public key together as "the private key".
    sshString(concat([seed, publicKey])),
    sshString(comment),
  ]);

  // Padded to the cipher's block size, 8 for "none", with 1,2,3… — the bytes
  // are what OpenSSH writes and what it checks when reading back.
  for (let i = 1; inner.length % 8 !== 0; i += 1) {
    inner = concat([inner, new Uint8Array([i])]);
  }

  const blob = concat([
    new Uint8Array([...'openssh-key-v1'].map((c) => c.charCodeAt(0))),
    new Uint8Array([0]),
    sshString('none'),
    sshString('none'),
    sshString(new Uint8Array(0)),
    uint32(1),
    sshString(publicBlob(publicKey)),
    sshString(inner),
  ]);

  const body = (toBase64(blob).match(/.{1,70}/g) ?? []).join('\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;
}
