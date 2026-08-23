import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { base32Decode, totp } from '../src/inwx.js';

/**
 * The seed RFC 6238 uses for its test vectors: the ASCII string
 * "12345678901234567890", written the way INWX hands a seed out.
 */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32Decode', () => {
  it('recovers the bytes the RFC seed stands for', () => {
    assert.equal(Buffer.from(base32Decode(RFC_SECRET)).toString('ascii'), '12345678901234567890');
  });

  it('ignores padding and spacing, which is how the seed is usually shown', () => {
    const spaced = 'GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ';
    assert.deepEqual(base32Decode(spaced), base32Decode(RFC_SECRET));
    assert.deepEqual(base32Decode('MZXW6==='), base32Decode('mzxw6'));
  });

  it('refuses a character that is not base32 rather than guessing', () => {
    assert.throws(() => base32Decode('GEZD1'), /not base32/);
  });
});

describe('totp', () => {
  /**
   * RFC 6238, Appendix B — the SHA-1 rows, truncated to the six digits INWX
   * asks for. Getting this wrong locks the account out of every call, and the
   * error INWX returns says only that the TAN was wrong.
   */
  const vectors: ReadonlyArray<readonly [number, string]> = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];

  for (const [seconds, expected] of vectors) {
    it(`matches the RFC at T=${seconds}`, () => {
      assert.equal(totp(RFC_SECRET, seconds * 1000), expected);
    });
  }

  it('holds the same code for a whole 30 second step and changes at the edge', () => {
    // The window matters: a code generated at the end of a step would be
    // rejected by the time the request lands.
    assert.equal(totp(RFC_SECRET, 59_000), totp(RFC_SECRET, 30_000));
    assert.notEqual(totp(RFC_SECRET, 59_000), totp(RFC_SECRET, 60_000));
  });

  it('always returns six digits, leading zeros kept', () => {
    for (const [seconds] of vectors) {
      assert.match(totp(RFC_SECRET, seconds * 1000), /^\d{6}$/);
    }
    assert.equal(totp(RFC_SECRET, 1234567890 * 1000), '005924');
  });
});
