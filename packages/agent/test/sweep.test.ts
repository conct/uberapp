import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newOrder, type Order } from '../src/payments/orders.js';
import { ABANDON_AFTER_MS, sweep } from '../src/payments/sweep.js';

/**
 * The sweep is the only part of the payment path that acts without anybody
 * watching, on orders where the money question is already open. So these tests
 * are less about the happy case than about what it refuses to do: invent a
 * payment, touch a finished order, or give up on one that is merely young.
 *
 * Each run gets its own home directory and its own fake internet. Nothing here
 * reaches a real provider, and an unstubbed call is a test failure rather than
 * a charge.
 */

const NOW = Date.parse('2026-08-24T12:00:00.000Z');

let home: string;
let originalFetch: typeof globalThis.fetch;
let previous: { home?: string; profile?: string };

/** Answers keyed by a fragment of the URL; anything unmatched throws. */
type Replies = Record<string, unknown>;

function stubFetch(replies: Replies): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    for (const [fragment, body] of Object.entries(replies)) {
      if (url.includes(fragment)) {
        return {
          ok: true,
          status: 200,
          json: async () => body,
        } as unknown as Response;
      }
    }
    throw new Error(`the sweep called something it should not have: ${url}`);
  }) as typeof globalThis.fetch;
}

async function writeOrder(order: Order): Promise<void> {
  const dir = join(home, '.config', 'uberctrl', 'orders');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${order.id}.json`), JSON.stringify(order, null, 2), 'utf8');
}

async function readBack(id: string): Promise<Order> {
  const path = join(home, '.config', 'uberctrl', 'orders', `${id}.json`);
  return JSON.parse(await readFile(path, 'utf8')) as Order;
}

function anOrder(overrides: Partial<Order> = {}): Order {
  const base = newOrder(
    {
      domain: 'beispiel.de',
      action: 'register',
      amountCents: 1500,
      currency: 'EUR',
      registrarCostCents: 900,
      registrarCurrency: 'EUR',
      provider: 'stripe',
      contacts: { registrant: 1, admin: 1, tech: 1, billing: 1 },
    },
    new Date(NOW),
  );
  return { ...base, reference: 'cs_test_1', ...overrides };
}

const quiet = () => {};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'uberctrl-sweep-'));
  previous = { home: process.env.HOME, profile: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  originalFetch = globalThis.fetch;

  await mkdir(join(home, '.config', 'uberctrl'), { recursive: true });
  await writeFile(
    join(home, '.config', 'uberctrl', 'payments.json'),
    JSON.stringify({
      successUrl: 'https://example.test/ok',
      cancelUrl: 'https://example.test/no',
      stripe: { secretKey: 'sk_test_x', webhookSecret: 'whsec_x' },
    }),
    'utf8',
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previous.home === undefined) delete process.env.HOME;
  else process.env.HOME = previous.home;
  if (previous.profile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previous.profile;
});

describe('sweep', () => {
  it('picks up a payment whose webhook never arrived', async () => {
    // The failure this whole file exists for: the customer paid, Stripe called
    // while the host was down, and our record still says nobody paid.
    const order = anOrder();
    await writeOrder(order);
    stubFetch({ 'checkout/sessions': { payment_status: 'paid', amount_total: 1500 } });

    const result = await sweep(quiet, NOW);

    assert.equal(result.recovered, 1);
    const after = await readBack(order.id);
    // No registrar account on this host, so it cannot be delivered — and that
    // is exactly what it must say, rather than quietly reporting success.
    assert.equal(after.state, 'refund_due');
    assert.ok(after.history.some((entry) => entry.state === 'paid'));
  });

  it('leaves an unpaid order that is merely young', async () => {
    const order = anOrder();
    await writeOrder(order);
    stubFetch({ 'checkout/sessions': { payment_status: 'unpaid' } });

    const result = await sweep(quiet, NOW);

    assert.equal(result.cancelled, 0);
    assert.equal((await readBack(order.id)).state, 'awaiting_payment');
  });

  it('gives up on an unpaid order once the day is gone', async () => {
    const order = anOrder();
    await writeOrder(order);
    stubFetch({ 'checkout/sessions': { payment_status: 'unpaid' } });

    const result = await sweep(quiet, NOW + ABANDON_AFTER_MS + 1);

    assert.equal(result.cancelled, 1);
    assert.equal((await readBack(order.id)).state, 'cancelled');
  });

  it('does not ask about an order that is already finished', async () => {
    // fetch throws on any call, so reaching the provider here fails the test.
    const order = anOrder({ state: 'completed' });
    await writeOrder(order);
    stubFetch({});

    const result = await sweep(quiet, NOW + ABANDON_AFTER_MS * 10);

    assert.equal(result.checked, 1);
    assert.equal(result.recovered, 0);
    assert.equal((await readBack(order.id)).state, 'completed');
  });

  it('reports an order that is owed a refund without touching it', async () => {
    const order = anOrder({ state: 'refund_due' });
    await writeOrder(order);
    stubFetch({});

    const result = await sweep(quiet, NOW);

    assert.deepEqual(result.attention, [order.id]);
    assert.equal((await readBack(order.id)).state, 'refund_due');
  });

  it('captures a PayPal order the customer approved and nobody collected', async () => {
    const order = anOrder({ provider: 'paypal', reference: 'PP-1' });
    await writeOrder(order);
    await writeFile(
      join(home, '.config', 'uberctrl', 'payments.json'),
      JSON.stringify({
        successUrl: 'https://example.test/ok',
        cancelUrl: 'https://example.test/no',
        paypal: { clientId: 'id', clientSecret: 'secret', webhookId: 'wh' },
      }),
      'utf8',
    );

    let captured = false;
    globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      let body: unknown = {};
      if (url.includes('oauth2/token')) body = { access_token: 'tok' };
      else if (url.includes('/capture')) {
        captured = true;
        body = { status: 'COMPLETED' };
      } else if (url.includes('/v2/checkout/orders/PP-1')) {
        assert.notEqual(init?.method, 'POST');
        body = { status: 'APPROVED', purchase_units: [{ amount: { value: '15.00' } }] };
      } else throw new Error(`unexpected ${url}`);
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as typeof globalThis.fetch;

    const result = await sweep(quiet, NOW);

    // Approval is not payment. If the sweep counted it as paid without
    // capturing, a domain would be registered for money never taken.
    assert.ok(captured, 'an approved order must be captured before it counts as paid');
    assert.equal(result.recovered, 1);
  });

  it('treats a provider it cannot reach as no answer at all', async () => {
    const order = anOrder();
    await writeOrder(order);
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof globalThis.fetch;

    const result = await sweep(quiet, NOW);

    // An outage must not become a cancellation, and certainly not a payment.
    assert.equal(result.recovered, 0);
    assert.equal(result.cancelled, 0);
    assert.equal((await readBack(order.id)).state, 'awaiting_payment');
  });
});
