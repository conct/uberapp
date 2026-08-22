/**
 * The slots a handoff passes through.
 *
 * Deliberately the smallest thing that can work: a map from slot id to opaque
 * bytes, with an expiry. There is no database because there is nothing here
 * worth persisting — every entry is meaningless without a key that only ever
 * existed in a QR code, and an entry that outlives the browser waiting for it
 * has already failed at its job.
 *
 * The rules that matter are about *not* keeping things:
 *
 *   - one read, then gone. A second reader means either a bug or an attacker,
 *     and either way the browser that asked has already been served.
 *   - one write. A slot that is already occupied is not overwritten, so a
 *     racing deposit cannot displace the one the browser is about to collect.
 *   - a short life. Two minutes is long enough to walk to a phone, and short
 *     enough that a forgotten slot does not linger.
 *
 * Kept separate from the server so all of that can be tested without sockets.
 */

export interface SlotStoreOptions {
  /** How long a deposit stays collectable. */
  ttlMs?: number;
  /** Refuse further deposits past this many live slots. */
  maxEntries?: number;
  /** Longest sealed payload accepted, in characters. */
  maxBytes?: number;
  /** Injectable so tests do not have to wait. */
  now?: () => number;
}

export type DepositResult =
  | { ok: true }
  | { ok: false; reason: 'occupied' | 'too-large' | 'full' | 'bad-slot' };

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_BYTES = 8 * 1024;

/**
 * Slot ids come from the browser, travel through a URL and are used as map
 * keys, so they are checked rather than trusted: base64url only, and long
 * enough that guessing one is not a strategy.
 */
export const SLOT_ID = /^[A-Za-z0-9_-]{16,64}$/;

interface Entry {
  sealed: string;
  expiresAt: number;
}

export class SlotStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(options: SlotStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = options.now ?? Date.now;
  }

  deposit(sid: string, sealed: string): DepositResult {
    if (!SLOT_ID.test(sid)) return { ok: false, reason: 'bad-slot' };
    if (sealed.length === 0 || sealed.length > this.maxBytes) {
      return { ok: false, reason: 'too-large' };
    }

    this.prune();

    // Checked after pruning: an expired occupant is not an occupant.
    if (this.entries.has(sid)) return { ok: false, reason: 'occupied' };
    if (this.entries.size >= this.maxEntries) return { ok: false, reason: 'full' };

    this.entries.set(sid, { sealed, expiresAt: this.now() + this.ttlMs });
    return { ok: true };
  }

  /** Returns the payload and forgets it. Null when there is nothing to give. */
  collect(sid: string): string | null {
    if (!SLOT_ID.test(sid)) return null;

    const entry = this.entries.get(sid);
    if (entry === undefined) return null;

    this.entries.delete(sid);
    return entry.expiresAt > this.now() ? entry.sealed : null;
  }

  /** Drop what has expired. Called on every deposit; no timer to leak. */
  prune(): void {
    const now = this.now();
    for (const [sid, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(sid);
    }
  }

  /** For the health endpoint. Deliberately a count and nothing else. */
  get size(): number {
    return this.entries.size;
  }
}
