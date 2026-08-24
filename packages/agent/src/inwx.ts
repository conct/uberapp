/**
 * Talking to INWX, the registrar, from the host.
 *
 * The credentials live beside the master token in ~/.config/uberctrl and never
 * leave the host — the same arrangement the MySQL credentials already have,
 * and for the same reason: the agent is the one process that already holds
 * secrets for this account, and putting a registrar login on every phone that
 * pairs with it would multiply the blast radius by the number of devices.
 *
 * Their absence is the switch. No file, no `domains` capability, and the app
 * shows nothing — which is how one code base serves both a build that sells
 * domains and one that has never heard of them.
 *
 * The protocol is JSON-RPC over POST. A login returns a session cookie that
 * every later call must carry, so a session is a small object rather than a
 * set of free functions.
 */

import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Live registrations cost money; the OT&E system is the same API for free. */
export const INWX_LIVE = 'https://api.domrobot.com/jsonrpc/';
export const INWX_OTE = 'https://api.ote.domrobot.com/jsonrpc/';

export interface InwxAccount {
  user: string;
  pass: string;
  /**
   * Base32 seed for the second factor, as INWX shows it when 2FA is switched
   * on. Optional: an account without 2FA does not need one, and one with 2FA
   * cannot log in without it.
   */
  sharedSecret?: string;
  /** Defaults to the test system, so a half-finished setup cannot buy a domain. */
  endpoint?: string;
}

export function accountPath(): string {
  return join(homedir(), '.config', 'uberctrl', 'inwx.json');
}

/**
 * The credentials, or null when there are none.
 *
 * Null is the ordinary case, not an error: most hosts have no registrar
 * account, and the capability list is built from exactly this answer.
 */
export async function readAccount(): Promise<InwxAccount | null> {
  let raw: string;
  try {
    raw = await readFile(accountPath(), 'utf8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<InwxAccount>;
    if (typeof parsed.user !== 'string' || typeof parsed.pass !== 'string') return null;
    return {
      user: parsed.user,
      pass: parsed.pass,
      ...(typeof parsed.sharedSecret === 'string' ? { sharedSecret: parsed.sharedSecret } : {}),
      // The test system unless the file says otherwise. A typo in the endpoint
      // should cost nothing, and defaulting the other way could cost a domain.
      endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : INWX_OTE,
    };
  } catch {
    return null;
  }
}

// --- the second factor ------------------------------------------------------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 as RFC 4648 writes it, which is how INWX hands out the seed. */
export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[=\s]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;

  for (const character of clean) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new Error(`"${character}" is not base32`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }

  return new Uint8Array(out);
}

/**
 * A time-based one-time password, RFC 6238.
 *
 * Written out rather than pulled in: it is twenty lines of HMAC and a shift,
 * the agent already has node:crypto, and a dependency that runs against a
 * registrar login is a dependency worth not having.
 */
export function totp(sharedSecret: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', Buffer.from(base32Decode(sharedSecret))).update(message).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);

  return String(binary % 1_000_000).padStart(6, '0');
}

// --- the session ------------------------------------------------------------

export interface InwxResponse<T = unknown> {
  code: number;
  msg?: string;
  resData?: T;
}

/** Everything INWX considers a success. Anything else is reported as-is. */
export const INWX_OK = 1000;

export class InwxError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'InwxError';
  }
}

/**
 * One logged-in conversation with INWX.
 *
 * Deliberately short-lived: opened for a call, closed after it. A session left
 * open would have to be kept warm and re-authenticated, and the cost of
 * logging in again is one request against an operation a person is watching.
 */
export class InwxSession {
  private cookie: string | null = null;

  private constructor(private readonly account: InwxAccount) {}

  static async open(account: InwxAccount): Promise<InwxSession> {
    const session = new InwxSession(account);
    await session.login();
    return session;
  }

  private async login(): Promise<void> {
    const login = await this.call<{ tfa?: string }>('account.login', {
      user: this.account.user,
      pass: this.account.pass,
    });

    // '0' means the account has no second factor. Anything else is a challenge
    // that the rest of the session is locked behind.
    const tfa = login.resData?.tfa;
    if (tfa !== undefined && tfa !== '0') {
      if (!this.account.sharedSecret) {
        throw new InwxError(
          login.code,
          'INWX asks for a second factor, but no sharedSecret is configured.',
        );
      }
      await this.call('account.unlock', { tan: totp(this.account.sharedSecret) });
    }
  }

  async close(): Promise<void> {
    if (!this.cookie) return;
    try {
      await this.call('account.logout');
    } catch {
      // A session we are abandoning anyway; INWX expires it on its own.
    }
    this.cookie = null;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<InwxResponse<T>> {
    const response = await fetch(this.account.endpoint ?? INWX_OTE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: JSON.stringify({ method, params }),
    });

    // The cookie only ever arrives with the login, and every later call needs
    // it; losing it here turns the next call into an unauthenticated one with
    // a confusing message about permissions.
    if (method === 'account.login') {
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) this.cookie = setCookie.split(';')[0] ?? null;
    }

    if (!response.ok) {
      throw new InwxError(response.status, `INWX answered HTTP ${response.status}`);
    }

    const body = (await response.json()) as InwxResponse<T>;
    if (body.code !== INWX_OK) {
      throw new InwxError(body.code, body.msg ?? `INWX returned code ${body.code}`);
    }
    return body;
  }
}

/**
 * Open a session, do one thing, close it.
 *
 * Every handler wants this shape, and the close matters: INWX counts open
 * sessions per account, and a handler that throws must not leave one behind.
 */
export async function withInwx<T>(
  account: InwxAccount,
  work: (session: InwxSession) => Promise<T>,
): Promise<T> {
  const session = await InwxSession.open(account);
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}
