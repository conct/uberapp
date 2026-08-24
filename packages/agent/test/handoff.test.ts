/**
 * The browser/phone handoff.
 *
 * These live here rather than in the protocol package because that is where
 * the test runner is; the code under test is `@uberctrl/protocol/handoff`.
 *
 * Node's webcrypto stands in for both ends. That is the point of taking the
 * provider as an argument: the browser passes its own `crypto`, the phone
 * passes quick-crypto's, and the agreement between them can still be checked
 * here without either.
 */

import { strict as assert } from 'node:assert';
import { webcrypto } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  decodeHandoffRequest,
  encodeHandoffRequest,
  fromBase64Url,
  newHandoffSecret,
  openHandoff,
  sealHandoff,
  toBase64Url,
  type CryptoProvider,
  type HandoffPayload,
} from '@uberctrl/protocol';

const crypto = webcrypto as unknown as CryptoProvider;

const payload: HandoffPayload = {
  v: 1,
  url: 'wss://isabell.uber.space/uberctrl',
  token: 'a'.repeat(43),
  exp: 1_800_000_000_000,
  label: 'isabell.uber.space',
};

describe('base64url', () => {
  it('round-trips every byte value', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) bytes[i] = i;
    assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes);
  });

  it('round-trips every length, so padding is not needed', () => {
    for (let length = 0; length <= 32; length += 1) {
      const bytes = new Uint8Array(length).fill(0xab);
      const encoded = toBase64Url(bytes);
      assert.equal(encoded.includes('='), false, `length ${length} produced padding`);
      assert.deepEqual(fromBase64Url(encoded), bytes, `length ${length} did not round-trip`);
    }
  });

  it('rejects characters outside the alphabet instead of guessing', () => {
    assert.equal(fromBase64Url('abc+'), null);
    assert.equal(fromBase64Url('ab/d'), null);
    assert.equal(fromBase64Url('ab=='), null);
  });
});

describe('the QR code the browser shows', () => {
  it('round-trips', async () => {
    const { sid, key } = await newHandoffSecret(crypto);
    const decoded = decodeHandoffRequest(
      encodeHandoffRequest({ v: 1, broker: 'https://connect.example.org', sid, key }),
    );
    assert.deepEqual(decoded, { v: 1, broker: 'https://connect.example.org', sid, key });
  });

  it('drops a trailing slash so the broker URL joins predictably', () => {
    const key = toBase64Url(new Uint8Array(32).fill(7));
    const decoded = decodeHandoffRequest(
      JSON.stringify({ v: 1, broker: 'https://connect.example.org/', sid: 'x'.repeat(22), key }),
    );
    assert.equal(decoded?.broker, 'https://connect.example.org');
  });

  it('returns null rather than throwing on things that are not one', () => {
    const key = toBase64Url(new Uint8Array(32));
    const sid = 'x'.repeat(22);

    assert.equal(decodeHandoffRequest('not json'), null);
    assert.equal(decodeHandoffRequest('"a string"'), null);
    assert.equal(decodeHandoffRequest(JSON.stringify({ v: 2, broker: 'https://a', sid, key })), null);
    // A key of the wrong size would fail later, in a place with less context.
    assert.equal(
      decodeHandoffRequest(
        JSON.stringify({ v: 1, broker: 'https://a', sid, key: toBase64Url(new Uint8Array(16)) }),
      ),
      null,
    );
    // Not https, so the sealed payload would travel in the clear.
    assert.equal(decodeHandoffRequest(JSON.stringify({ v: 1, broker: 'ftp://a', sid, key })), null);
    // A guessable slot is the one thing the scheme cannot tolerate.
    assert.equal(
      decodeHandoffRequest(JSON.stringify({ v: 1, broker: 'https://a', sid: 'short', key })),
      null,
    );
  });

  it('is not confused with the token-carrying pairing code', () => {
    const pairing = JSON.stringify({ v: 1, url: 'wss://host/uberctrl', token: 'a'.repeat(43) });
    assert.equal(decodeHandoffRequest(pairing), null);
  });
});

describe('sealing', () => {
  it('the browser reads back what the phone sealed', async () => {
    const { key } = await newHandoffSecret(crypto);
    const sealed = await sealHandoff(crypto, key, payload);
    assert.deepEqual(await openHandoff(crypto, key, sealed), payload);
  });

  it('reveals nothing to whoever is holding it', async () => {
    const { key } = await newHandoffSecret(crypto);
    const sealed = await sealHandoff(crypto, key, payload);
    assert.equal(sealed.includes(payload.token), false);
    assert.equal(sealed.includes('uber.space'), false);
    assert.equal(sealed.includes('wss'), false);
  });

  it('uses a fresh nonce, so the same payload does not seal to the same bytes', async () => {
    const { key } = await newHandoffSecret(crypto);
    const a = await sealHandoff(crypto, key, payload);
    const b = await sealHandoff(crypto, key, payload);
    assert.notEqual(a, b);
  });

  it('refuses another browser’s key', async () => {
    const mine = await newHandoffSecret(crypto);
    const theirs = await newHandoffSecret(crypto);
    const sealed = await sealHandoff(crypto, mine.key, payload);
    assert.equal(await openHandoff(crypto, theirs.key, sealed), null);
  });

  it('refuses a payload that was altered in transit', async () => {
    const { key } = await newHandoffSecret(crypto);
    const sealed = await sealHandoff(crypto, key, payload);

    // Flip one character of the ciphertext, past the nonce.
    const at = sealed.length - 5;
    const swapped = sealed[at] === 'A' ? 'B' : 'A';
    const tampered = sealed.slice(0, at) + swapped + sealed.slice(at + 1);

    assert.equal(await openHandoff(crypto, key, tampered), null);
  });

  it('returns null for a broker that answers with something of its own', async () => {
    const { key } = await newHandoffSecret(crypto);
    assert.equal(await openHandoff(crypto, key, 'not sealed at all'), null);
    assert.equal(await openHandoff(crypto, key, ''), null);
    // Long enough to get past the length check, still not ciphertext.
    assert.equal(await openHandoff(crypto, key, toBase64Url(new Uint8Array(64))), null);
  });

  it('rejects a decrypted payload that is not a usable connection', async () => {
    const { key } = await newHandoffSecret(crypto);

    const bad = [
      { ...payload, url: 'https://host/uberctrl' }, // not a WebSocket address
      { ...payload, token: 'too-short' },
      { ...payload, v: 2 },
    ];

    for (const value of bad) {
      const sealed = await sealHandoff(crypto, key, value as HandoffPayload);
      assert.equal(await openHandoff(crypto, key, sealed), null, JSON.stringify(value));
    }
  });
});
