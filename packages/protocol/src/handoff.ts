/**
 * Handing a connection from the phone to a browser, through a server that is
 * not trusted with it.
 *
 * The browser has nothing to start from: no token, and not even the address of
 * the Uberspace it should talk to. The phone has both. So the browser asks and
 * the phone answers, and a small server in the middle holds the answer for the
 * moment between the two.
 *
 *   1. The browser picks a slot id and a key, and shows both as a QR code.
 *   2. The phone scans it, mints a scoped token on its agent, seals the
 *      address and that token with the key, and deposits the result.
 *   3. The browser collects it once, unseals it, and from then on talks
 *      straight to the agent. The server is out of the picture.
 *
 * The sealing is the point. Without it the server would briefly hold a working
 * credential for someone else's host, which makes it worth attacking; with it
 * the server holds bytes it cannot read, and the key exists only in a QR code
 * that was never transmitted anywhere. A server that is dishonest, subpoenaed
 * or simply broken into learns nothing.
 *
 * What the server still must do is refuse to hand a slot to more than one
 * caller, and forget it quickly — a sealed payload is useless without the key,
 * but there is no reason to keep it lying around.
 *
 * Nothing here uses Buffer, btoa or any Node API: the same code runs in a
 * browser, in Hermes and in tests. The crypto is passed in rather than reached
 * for globally, because each of those three supplies it differently.
 */

/** What the browser shows. Ends up in a QR code, so it stays short. */
export interface HandoffRequest {
  v: 1;
  /** Base address of the broker, e.g. "https://connect.example.org". */
  broker: string;
  /**
   * The slot to deposit into. High entropy on purpose: it is the only thing
   * standing between an attacker and the sealed payload, and while they still
   * could not read it, they could take it and leave the browser waiting.
   */
  sid: string;
  /** base64url of a 256-bit AES-GCM key. Exists only inside the QR code. */
  key: string;
}

/** What the phone seals and the browser ends up with. */
export interface HandoffPayload {
  v: 1;
  /** The agent's WebSocket address. */
  url: string;
  /** A token minted for this browser, scoped and expiring. */
  token: string;
  /** Milliseconds since the epoch, or null when it does not expire. */
  exp: number | null;
  /** What to call this Uberspace in the browser's title bar. */
  label: string;
}

type BinaryInput = ArrayBuffer | ArrayBufferView;

/** AES-GCM, named so the calls below read as what they are. */
interface GcmParams {
  name: 'AES-GCM';
  iv: BinaryInput;
}

/**
 * A key handle, whatever the underlying implementation calls it. Nothing here
 * looks inside one; it only passes it back.
 */
export type OpaqueKey = object;

/**
 * The parts of WebCrypto used here — spelled out rather than pulled from the
 * DOM types, because this package is also compiled for the agent, where there
 * is no DOM. Described structurally so a browser's `crypto`, Node's
 * `webcrypto` and quick-crypto's all satisfy it without an adapter.
 */
export interface CryptoProvider {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  subtle: {
    importKey(
      format: 'raw',
      keyData: BinaryInput,
      algorithm: 'AES-GCM',
      extractable: boolean,
      usages: string[],
    ): Promise<OpaqueKey>;
    encrypt(algorithm: GcmParams, key: OpaqueKey, data: BinaryInput): Promise<ArrayBuffer>;
    decrypt(algorithm: GcmParams, key: OpaqueKey, data: BinaryInput): Promise<ArrayBuffer>;
  };
}

const KEY_BYTES = 32;
const SID_BYTES = 16;
const IV_BYTES = 12;

// ---------------------------------------------------------------------------
// base64url, by hand
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : undefined;
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : undefined;

    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += ALPHABET[c & 63];
  }
  return out;
}

/** Returns null on anything that is not base64url, rather than throwing. */
export function fromBase64Url(text: string): Uint8Array | null {
  const length = text.length;
  if (length % 4 === 1) return null;

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < length; i += 1) {
    const value = ALPHABET.indexOf(text[i] as string);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------
// The QR code
// ---------------------------------------------------------------------------

export function encodeHandoffRequest(request: HandoffRequest): string {
  return JSON.stringify(request);
}

/**
 * Returns null for anything that is not a handoff request.
 *
 * A camera pointed at the world supplies plenty of text that is not this, and
 * so does the *other* kind of code this app shows — the one carrying a token
 * directly. Both are JSON, so the version and the field shape decide.
 */
export function decodeHandoffRequest(text: string): HandoffRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const value = parsed as Partial<HandoffRequest>;
  if (value.v !== 1) return null;
  if (typeof value.broker !== 'string' || !/^https?:\/\/\S+$/.test(value.broker)) return null;
  if (typeof value.sid !== 'string' || value.sid.length < 16) return null;
  if (typeof value.key !== 'string') return null;

  const key = fromBase64Url(value.key);
  if (key === null || key.length !== KEY_BYTES) return null;

  return { v: 1, broker: value.broker.replace(/\/+$/, ''), sid: value.sid, key: value.key };
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

/** A fresh slot id and key for one handoff. Called by the browser. */
export async function newHandoffSecret(
  crypto: CryptoProvider,
): Promise<{ sid: string; key: string }> {
  const sid = crypto.getRandomValues(new Uint8Array(SID_BYTES));
  const key = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  return { sid: toBase64Url(sid), key: toBase64Url(key) };
}

async function importKey(crypto: CryptoProvider, encodedKey: string): Promise<OpaqueKey | null> {
  const raw = fromBase64Url(encodedKey);
  if (raw === null || raw.length !== KEY_BYTES) return null;
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Seal a payload for the browser that produced this key.
 *
 * The nonce goes in front of the ciphertext rather than alongside it: one
 * string travels, and there is no second field for a caller to forget.
 */
export async function sealHandoff(
  crypto: CryptoProvider,
  encodedKey: string,
  payload: HandoffPayload,
): Promise<string> {
  const key = await importKey(crypto, encodedKey);
  if (key === null) throw new Error('Handoff key is not a 256-bit base64url value');

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
  );

  const combined = new Uint8Array(iv.length + sealed.length);
  combined.set(iv, 0);
  combined.set(sealed, iv.length);
  return toBase64Url(combined);
}

/**
 * Unseal what the phone deposited. Returns null on anything that does not
 * decrypt and parse — a wrong key, a truncated slot, or a broker returning
 * something of its own invention.
 */
export async function openHandoff(
  crypto: CryptoProvider,
  encodedKey: string,
  sealed: string,
): Promise<HandoffPayload | null> {
  const key = await importKey(crypto, encodedKey);
  if (key === null) return null;

  const combined = fromBase64Url(sealed);
  if (combined === null || combined.length <= IV_BYTES) return null;

  const iv = combined.subarray(0, IV_BYTES);
  const body = combined.subarray(IV_BYTES);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, body);
  } catch {
    // Authentication failure. Nothing here distinguishes a wrong key from a
    // tampered payload, and nothing should: both mean do not use this.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const value = parsed as Partial<HandoffPayload>;
  if (value.v !== 1) return null;
  if (typeof value.url !== 'string' || !/^wss?:\/\/\S+$/.test(value.url)) return null;
  if (typeof value.token !== 'string' || value.token.length < 24) return null;

  return {
    v: 1,
    url: value.url,
    token: value.token,
    exp: typeof value.exp === 'number' ? value.exp : null,
    label: typeof value.label === 'string' ? value.label : value.url,
  };
}
