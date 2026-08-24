import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { quoteFor, sellingPrice } from '../src/payments/pricing.js';

/**
 * The selling price is the one number in this codebase that is somebody's
 * money in both directions: too low and the margin is gone, too high and a
 * customer was overcharged. It is also the number a client would love to be
 * allowed to send, which is exactly why it is computed here.
 */
describe('sellingPrice', () => {
  it('sells at cost when no margin is configured', () => {
    // A legitimate setup — somebody buying domains for themselves through the
    // same screens — and it must never quietly become a markup.
    assert.equal(sellingPrice(1290), 1290);
    assert.equal(sellingPrice(1290, {}), 1290);
  });

  it('adds a percentage', () => {
    assert.equal(sellingPrice(1000, { percent: 25 }), 1250);
  });

  it('adds a fixed amount on top of the percentage', () => {
    assert.equal(sellingPrice(1000, { percent: 10, fixedCents: 200 }), 1300);
  });

  it('rounds a fractional cent up, never down', () => {
    // 1299 * 1.07 = 1389.93. Rounding to nearest would sell it for 1389 and
    // give away a cent on every single order.
    assert.equal(sellingPrice(1299, { percent: 7 }), 1390);
  });

  it('honours a floor price', () => {
    assert.equal(sellingPrice(100, { percent: 10, minCents: 500 }), 500);
    // The floor lifts, it never caps.
    assert.equal(sellingPrice(2000, { percent: 10, minCents: 500 }), 2200);
  });

  it('refuses to invent a price from nonsense', () => {
    assert.equal(sellingPrice(Number.NaN, { percent: 50 }), 0);
    assert.equal(sellingPrice(-100, { percent: 50 }), 0);
  });

  it('ignores a margin that is not a number', () => {
    const broken = { percent: 'viel' } as unknown as { percent: number };
    assert.equal(sellingPrice(1000, broken), 1000);
  });

  it('keeps both numbers apart in a quote', () => {
    const quote = quoteFor(1000, 'EUR', { percent: 20 });
    assert.deepEqual(quote, { registrarCostCents: 1000, amountCents: 1200, currency: 'EUR' });
  });
});
