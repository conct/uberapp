import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { priceMustMatch } from '../src/handlers/domains.js';

/**
 * The one rule standing between a tap and a charge: a purchase must name the
 * price it expects, and the registrar has to agree. Everything else about
 * registering is the registrar's business; this is ours.
 */
describe('priceMustMatch', () => {
  it('lets an agreed price through', () => {
    assert.doesNotThrow(() => priceMustMatch(9.99, 9.99, 'EUR'));
  });

  it('ignores float noise below a cent', () => {
    // Registrars quote floats. 9.99 and 9.990000000000002 are the same price,
    // and refusing over that would block every second purchase.
    assert.doesNotThrow(() => priceMustMatch(9.99, 9.990000000000002, 'EUR'));
    assert.doesNotThrow(() => priceMustMatch(12.0, 11.999999, 'EUR'));
  });

  it('refuses when the price moved, and says both numbers', () => {
    assert.throws(
      () => priceMustMatch(9.99, 14.99, 'EUR'),
      (err: Error) => {
        assert.match(err.message, /9\.99/);
        assert.match(err.message, /14\.99/);
        assert.match(err.message, /EUR/);
        return true;
      },
    );
  });

  it('refuses a cent of difference — the guard is exact, not approximate', () => {
    assert.throws(() => priceMustMatch(9.99, 10.0, 'EUR'), /geändert/);
  });

  it('refuses when the registrar names no price at all', () => {
    // No quote means no agreement is possible, and a purchase without an
    // agreed price is exactly what this exists to prevent.
    assert.throws(() => priceMustMatch(9.99, null, 'EUR'), /keinen Preis/);
  });
});
