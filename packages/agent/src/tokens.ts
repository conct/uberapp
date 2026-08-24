/**
 * Pairing tokens.
 *
 * The token install.sh generates is the master key: it never expires, and the
 * only way to take it back is to replace the file and restart. That is fine
 * for the one device that set the agent up, and wrong for everything after —
 * a browser on a laptop, a second phone, a code scanned off a screen.
 *
 * So pairing mints separate tokens. They carry the same rights, because no
 * method in this protocol behaves differently depending on the client, but
 * they expire and they can be revoked one at a time.
 *
 * Only hashes are stored. A backup of ~/.config that leaks then hands over
 * nothing usable, which is not true of the master token file next to it.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AuthInfo, IssuedToken, IssuedTokenInfo } from '@uberctrl/protocol';
import { MAX_ISSUED_TOKENS } from '@uberctrl/protocol';
import type { AgentConfig } from './config.js';

interface StoredToken {
  id: string;
  /** sha256 of the token, hex. */
  hash: string;
  label: string | null;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
}

export function tokenStorePath(config: AgentConfig): string {
  return join(config.home, '.config', 'uberctrl', 'tokens.json');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Compare two hex digests without leaking where they differ. */
export function digestsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function isExpired(entry: { expiresAt: number | null }, now = Date.now()): boolean {
  return entry.expiresAt !== null && entry.expiresAt <= now;
}

export function toInfo(entry: StoredToken, now = Date.now()): IssuedTokenInfo {
  return {
    id: entry.id,
    label: entry.label,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    lastUsedAt: entry.lastUsedAt,
    expired: isExpired(entry, now),
  };
}

/**
 * Drop what is no longer usable.
 *
 * Expired entries are pruned on every read rather than on a timer: the file is
 * small, and a token that died while the agent was stopped should not come
 * back to life when it starts again.
 */
export function prune(entries: StoredToken[], now = Date.now()): StoredToken[] {
  return entries.filter((entry) => !isExpired(entry, now));
}

async function readStore(config: AgentConfig): Promise<StoredToken[]> {
  let raw: string;
  try {
    raw = await readFile(tokenStorePath(config), 'utf8');
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupted store must not lock the master token out.
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const entries: StoredToken[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const value = item as Partial<StoredToken>;
    if (typeof value.id !== 'string' || typeof value.hash !== 'string') continue;
    entries.push({
      id: value.id,
      hash: value.hash,
      label: typeof value.label === 'string' ? value.label : null,
      createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
      expiresAt: typeof value.expiresAt === 'number' ? value.expiresAt : null,
      lastUsedAt: typeof value.lastUsedAt === 'number' ? value.lastUsedAt : null,
    });
  }
  return entries;
}

async function writeStore(config: AgentConfig, entries: StoredToken[]): Promise<void> {
  const path = tokenStorePath(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(entries, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export async function listTokens(config: AgentConfig): Promise<IssuedTokenInfo[]> {
  const now = Date.now();
  const entries = prune(await readStore(config), now);
  await writeStore(config, entries);
  return entries
    .map((entry) => toInfo(entry, now))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function issueToken(
  config: AgentConfig,
  options: { label?: string | null; ttlSeconds: number | null },
): Promise<IssuedToken> {
  const now = Date.now();
  const entries = prune(await readStore(config), now);

  if (entries.length >= MAX_ISSUED_TOKENS) {
    throw new Error(`At most ${MAX_ISSUED_TOKENS} pairing tokens can exist at once`);
  }

  // 32 bytes of urandom, base64url so it survives a QR code and a URL alike.
  const token = randomBytes(32).toString('base64url');
  const entry: StoredToken = {
    id: randomBytes(8).toString('hex'),
    hash: hashToken(token),
    label: options.label ?? null,
    createdAt: now,
    expiresAt: options.ttlSeconds === null ? null : now + options.ttlSeconds * 1000,
    lastUsedAt: null,
  };

  await writeStore(config, [...entries, entry]);
  return { ...toInfo(entry, now), token };
}

export async function revokeToken(config: AgentConfig, id: string): Promise<boolean> {
  const entries = prune(await readStore(config));
  const remaining = entries.filter((entry) => entry.id !== id);
  if (remaining.length === entries.length) return false;
  await writeStore(config, remaining);
  return true;
}

/**
 * Authenticate a presented token.
 *
 * The master token is checked first and always compared, so a wrong token
 * costs the same work whether or not any pairing tokens exist.
 */
export async function authenticate(
  config: AgentConfig,
  presented: unknown,
): Promise<AuthInfo | null> {
  if (typeof presented !== 'string' || presented.length === 0) return null;

  const presentedHash = hashToken(presented);
  if (digestsMatch(presentedHash, hashToken(config.token))) {
    return { kind: 'master', id: null, label: null, expiresAt: null };
  }

  const now = Date.now();
  const entries = prune(await readStore(config), now);
  const match = entries.find((entry) => digestsMatch(presentedHash, entry.hash));
  if (!match) return null;

  match.lastUsedAt = now;
  await writeStore(config, entries);

  return {
    kind: 'issued',
    id: match.id,
    label: match.label,
    expiresAt: match.expiresAt,
  };
}
