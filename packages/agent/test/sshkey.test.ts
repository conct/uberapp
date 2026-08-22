import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { authorizedKeyLine, opensshPrivateKey, toBase64 } from '@uberapp/protocol';

/**
 * The encoder is checked against its own output rather than against ssh2:
 * ssh2 is the mobile app's dependency, not the agent's, and a test that
 * silently reaches across the workspace for it would fail for the wrong
 * reason the day that changes. It *was* verified against ssh2 by hand —
 * parseKey accepts the result, reports ssh-ed25519, and signs and verifies.
 * What is checked here is that the bytes stay the shape ssh2 accepted.
 */

const seed = new Uint8Array(32).fill(7);
const pub = new Uint8Array(32).map((_, i) => i);
const check = new Uint8Array([1, 2, 3, 4]);

/** Read an SSH string (uint32 length, then bytes) at `at`. */
function readString(buf: Buffer, at: number): { value: Buffer; next: number } {
  const length = buf.readUInt32BE(at);
  return { value: buf.subarray(at + 4, at + 4 + length), next: at + 4 + length };
}

describe('toBase64', () => {
  it('pads the way every other base64 does', () => {
    assert.equal(toBase64(new Uint8Array([102, 111, 111])), 'Zm9v');
    assert.equal(toBase64(new Uint8Array([102, 111])), 'Zm8=');
    assert.equal(toBase64(new Uint8Array([102])), 'Zg==');
    assert.equal(toBase64(new Uint8Array(0)), '');
  });
});

describe('authorizedKeyLine', () => {
  it('is the three fields sshd expects', () => {
    const parts = authorizedKeyLine(pub, 'uberapp@handy').split(' ');
    assert.equal(parts.length, 3);
    assert.equal(parts[0], 'ssh-ed25519');
    assert.equal(parts[2], 'uberapp@handy');

    // The blob repeats the type, then carries the 32 raw bytes.
    const blob = Buffer.from(parts[1] as string, 'base64');
    const type = readString(blob, 0);
    assert.equal(type.value.toString(), 'ssh-ed25519');
    assert.deepEqual(new Uint8Array(readString(blob, type.next).value), pub);
  });
});

describe('opensshPrivateKey', () => {
  const pem = opensshPrivateKey(seed, pub, 'uberapp@handy', check);

  it('wears the armour OpenSSH looks for', () => {
    assert.match(pem, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
    assert.match(pem, /\n-----END OPENSSH PRIVATE KEY-----\n$/);
    // Long base64 on one line is legal but nothing else writes it that way.
    const body = pem.split('\n').slice(1, -2);
    assert.ok(body.every((line) => line.length <= 70));
  });

  it('carries the header an unencrypted key must have', () => {
    const blob = Buffer.from(pem.split('\n').slice(1, -2).join(''), 'base64');
    assert.equal(blob.subarray(0, 15).toString('binary'), 'openssh-key-v1\0');

    const cipher = readString(blob, 15);
    assert.equal(cipher.value.toString(), 'none');
    const kdf = readString(blob, cipher.next);
    assert.equal(kdf.value.toString(), 'none');
    const kdfOptions = readString(blob, kdf.next);
    assert.equal(kdfOptions.value.length, 0);
    assert.equal(blob.readUInt32BE(kdfOptions.next), 1, 'exactly one key');
  });

  it('stores seed and public key the way OpenSSH reads them back', () => {
    const blob = Buffer.from(pem.split('\n').slice(1, -2).join(''), 'base64');
    const cipher = readString(blob, 15);
    const kdf = readString(blob, cipher.next);
    const kdfOptions = readString(blob, kdf.next);
    const publicBlob = readString(blob, kdfOptions.next + 4);
    const inner = readString(blob, publicBlob.next).value;

    // Two equal check words, so a reader can tell a bad passphrase from a
    // corrupt file. Nothing is encrypted here, but they still have to match.
    assert.deepEqual(inner.subarray(0, 4), inner.subarray(4, 8));

    const type = readString(inner, 8);
    assert.equal(type.value.toString(), 'ssh-ed25519');
    const innerPub = readString(inner, type.next);
    assert.deepEqual(new Uint8Array(innerPub.value), pub);

    const priv = readString(inner, innerPub.next);
    assert.equal(priv.value.length, 64, 'seed and public key together');
    assert.deepEqual(new Uint8Array(priv.value.subarray(0, 32)), seed);
    assert.deepEqual(new Uint8Array(priv.value.subarray(32)), pub);

    const comment = readString(inner, priv.next);
    assert.equal(comment.value.toString(), 'uberapp@handy');

    // Padded to the block size with 1,2,3…, which OpenSSH checks on read.
    assert.equal(inner.length % 8, 0);
    const padding = inner.subarray(comment.next);
    padding.forEach((byte, i) => assert.equal(byte, i + 1));
  });

  it('refuses anything that is not an ed25519 key', () => {
    assert.throws(() => opensshPrivateKey(new Uint8Array(16), pub, 'x', check), /32 bytes/);
    assert.throws(() => opensshPrivateKey(seed, new Uint8Array(31), 'x', check), /32 bytes/);
    assert.throws(() => opensshPrivateKey(seed, pub, 'x', new Uint8Array(3)), /4/);
  });
});
