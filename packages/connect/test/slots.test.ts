/**
 * The slot store, which is where the broker's promises actually live: one
 * read, one write, and a short life. Time is injected so none of that has to
 * be waited for.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { SLOT_ID, SlotStore } from '../src/slots.js';

const SID = 'abcdefghijklmnopqrstuv';
const SEALED = 'c2VhbGVkLXBheWxvYWQ';

function storeAt(clock: { t: number }, options = {}) {
  return new SlotStore({ now: () => clock.t, ...options });
}

describe('slot ids', () => {
  it('accepts base64url of a usable length', () => {
    assert.equal(SLOT_ID.test(SID), true);
    assert.equal(SLOT_ID.test('A-_0'.repeat(4)), true);
  });

  it('rejects anything short enough to guess or shaped to escape', () => {
    for (const bad of ['', 'short', '../etc/passwd', 'a'.repeat(65), 'has spaces', 'a/b']) {
      assert.equal(SLOT_ID.test(bad), false, bad);
    }
  });
});

describe('depositing', () => {
  it('accepts one payload and hands it back once', () => {
    const store = storeAt({ t: 0 });
    assert.deepEqual(store.deposit(SID, SEALED), { ok: true });
    assert.equal(store.collect(SID), SEALED);
  });

  it('forgets the payload the moment it is collected', () => {
    const store = storeAt({ t: 0 });
    store.deposit(SID, SEALED);
    store.collect(SID);

    assert.equal(store.collect(SID), null);
    assert.equal(store.size, 0);
  });

  it('will not let a second deposit displace the first', () => {
    const store = storeAt({ t: 0 });
    store.deposit(SID, SEALED);

    assert.deepEqual(store.deposit(SID, 'something-else'), { ok: false, reason: 'occupied' });
    assert.equal(store.collect(SID), SEALED);
  });

  it('treats an expired occupant as no occupant', () => {
    const clock = { t: 0 };
    const store = storeAt(clock, { ttlMs: 1000 });
    store.deposit(SID, SEALED);

    clock.t = 1001;
    assert.deepEqual(store.deposit(SID, 'the-next-one'), { ok: true });
    assert.equal(store.collect(SID), 'the-next-one');
  });

  it('refuses an unusable slot id rather than storing under it', () => {
    const store = storeAt({ t: 0 });
    assert.deepEqual(store.deposit('short', SEALED), { ok: false, reason: 'bad-slot' });
    assert.equal(store.size, 0);
  });

  it('refuses an empty or oversized payload', () => {
    const store = storeAt({ t: 0 }, { maxBytes: 16 });
    assert.deepEqual(store.deposit(SID, ''), { ok: false, reason: 'too-large' });
    assert.deepEqual(store.deposit(SID, 'x'.repeat(17)), { ok: false, reason: 'too-large' });
    assert.equal(store.size, 0);
  });

  it('stops accepting new slots once full, rather than growing without bound', () => {
    const store = storeAt({ t: 0 }, { maxEntries: 2 });
    store.deposit('a'.repeat(20), SEALED);
    store.deposit('b'.repeat(20), SEALED);

    assert.deepEqual(store.deposit('c'.repeat(20), SEALED), { ok: false, reason: 'full' });
  });
});

describe('expiry', () => {
  it('does not hand out a payload past its life', () => {
    const clock = { t: 0 };
    const store = storeAt(clock, { ttlMs: 1000 });
    store.deposit(SID, SEALED);

    clock.t = 1001;
    assert.equal(store.collect(SID), null);
  });

  it('still hands one out at the last moment', () => {
    const clock = { t: 0 };
    const store = storeAt(clock, { ttlMs: 1000 });
    store.deposit(SID, SEALED);

    clock.t = 999;
    assert.equal(store.collect(SID), SEALED);
  });

  it('clears out what nobody came back for', () => {
    const clock = { t: 0 };
    const store = storeAt(clock, { ttlMs: 1000 });
    store.deposit('a'.repeat(20), SEALED);
    store.deposit('b'.repeat(20), SEALED);
    assert.equal(store.size, 2);

    clock.t = 5000;
    store.prune();
    assert.equal(store.size, 0);
  });
});
