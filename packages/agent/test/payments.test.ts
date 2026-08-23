import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  canMove,
  moveTo,
  newOrder,
  ORDER_STATES,
  OrderStateError,
  type Order,
} from '../src/payments/orders.js';
import {
  parseSignatureHeader,
  signPayload,
  verifyWebhook,
  WebhookError,
} from '../src/payments/stripe.js';

const SECRET = 'whsec_test_0123456789';
const BODY = '{"id":"evt_1","type":"checkout.session.completed"}';

/**
 * A webhook is an unauthenticated POST from the open internet claiming somebody
 * paid. Everything below is about the difference between believing it and
 * checking it.
 */
describe('verifyWebhook', () => {
  const now = 1_700_000_000_000;
  const seconds = Math.floor(now / 1000);

  it('accepts what Stripe actually signed', () => {
    assert.doesNotThrow(() => verifyWebhook(BODY, signPayload(BODY, SECRET, seconds), SECRET, now));
  });

  it('rejects a forged signature', () => {
    const forged = `t=${seconds},v1=${'a'.repeat(64)}`;
    assert.throws(() => verifyWebhook(BODY, forged, SECRET, now), WebhookError);
  });

  it('rejects a body that was changed after signing', () => {
    // The whole point: the signature covers these exact bytes. A handler that
    // parses first and verifies afterwards is verifying nothing.
    const header = signPayload(BODY, SECRET, seconds);
    const tampered = BODY.replace('evt_1', 'evt_2');
    assert.throws(() => verifyWebhook(tampered, header, SECRET, now), /does not match/);
  });

  it('rejects a signature made with a different secret', () => {
    const header = signPayload(BODY, 'whsec_someone_else', seconds);
    assert.throws(() => verifyWebhook(BODY, header, SECRET, now), /does not match/);
  });

  it('rejects a replay from too long ago', () => {
    const old = signPayload(BODY, SECRET, seconds - 3600);
    assert.throws(() => verifyWebhook(BODY, old, SECRET, now), /out of date/);
  });

  it('rejects an event from the future, which means a clock is wrong', () => {
    const ahead = signPayload(BODY, SECRET, seconds + 3600);
    assert.throws(() => verifyWebhook(BODY, ahead, SECRET, now), /out of date/);
  });

  it('accepts any of several signatures, as sent during a secret rotation', () => {
    const good = signPayload(BODY, SECRET, seconds).split('v1=')[1];
    const header = `t=${seconds},v1=${'b'.repeat(64)},v1=${good}`;
    assert.doesNotThrow(() => verifyWebhook(BODY, header, SECRET, now));
  });
});

describe('parseSignatureHeader', () => {
  it('refuses a header without a timestamp or without a signature', () => {
    assert.throws(() => parseSignatureHeader('v1=abc'), /timestamp/);
    assert.throws(() => parseSignatureHeader('t=123'), /v1 signature/);
    assert.throws(() => parseSignatureHeader(''), /timestamp/);
  });

  it('ignores schemes it does not know rather than choking', () => {
    const parsed = parseSignatureHeader('t=123,v0=old,v1=abc');
    assert.equal(parsed.timestamp, 123);
    assert.deepEqual(parsed.signatures, ['abc']);
  });
});

/**
 * The order is the only record saying whether somebody's money is accounted
 * for. The moves it refuses matter more than the ones it allows.
 */
describe('order states', () => {
  const order = (): Order =>
    newOrder({
      domain: 'example.de',
      action: 'register',
      amountCents: 999,
      currency: 'EUR',
      provider: 'stripe',
      contacts: { registrant: 1, admin: 1, tech: 1, billing: 1 },
    });

  it('starts unpaid and nothing bought', () => {
    const fresh = order();
    assert.equal(fresh.state, 'awaiting_payment');
    assert.equal(fresh.registeredAt, null);
    assert.equal(fresh.history.length, 1);
  });

  it('will not register anything that was not paid for', () => {
    assert.equal(canMove('awaiting_payment', 'registering'), false);
    assert.equal(canMove('awaiting_payment', 'completed'), false);
    assert.throws(() => moveTo(order(), 'completed'), OrderStateError);
  });

  it('walks the ordinary path', () => {
    const paid = moveTo(order(), 'paid');
    const registering = moveTo(paid, 'registering');
    const done = moveTo(registering, 'completed');
    assert.equal(done.state, 'completed');
    assert.ok(done.registeredAt, 'a completed order records when');
    assert.deepEqual(done.history.map((entry) => entry.state), [
      'awaiting_payment',
      'paid',
      'registering',
      'completed',
    ]);
  });

  it('lets a chargeback reach even a completed order', () => {
    // It arrives whenever it arrives, and the record has to be able to say so.
    const done = moveTo(moveTo(moveTo(order(), 'paid'), 'registering'), 'completed');
    assert.doesNotThrow(() => moveTo(done, 'refunded'));
  });

  it('never un-registers', () => {
    const done = moveTo(moveTo(moveTo(order(), 'paid'), 'registering'), 'completed');
    for (const state of ORDER_STATES) {
      if (state === 'refunded' || state === 'completed') continue;
      assert.throws(() => moveTo(done, state), OrderStateError, `completed → ${state}`);
    }
  });

  it('treats a refused registration as money owed back', () => {
    const registering = moveTo(moveTo(order(), 'paid'), 'registering');
    const owed = moveTo(registering, 'refund_due', 'registrar said no');
    assert.equal(owed.state, 'refund_due');
    assert.equal(owed.history.at(-1)?.note, 'registrar said no');
  });

  it('leaves the finished states finished', () => {
    for (const state of ORDER_STATES) {
      assert.equal(canMove('refunded', state), false, `refunded → ${state}`);
      assert.equal(canMove('cancelled', state), false, `cancelled → ${state}`);
    }
  });

  it('keeps money in whole cents, never a float', () => {
    // 0.1 + 0.2 has no business anywhere near a price.
    assert.equal(Number.isInteger(order().amountCents), true);
  });
});
