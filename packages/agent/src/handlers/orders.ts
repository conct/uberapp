/**
 * Taking an order, and looking at the ones already taken.
 *
 * Creating one does three things in a fixed order, and the order matters: ask
 * the registrar what the name costs, write the order down, and only then ask
 * the payment provider for a checkout page. Writing first means a customer who
 * pays can always be matched to something; asking the provider first would
 * leave sessions in the world that refer to nothing.
 *
 * What is deliberately not here: any way to mark an order paid. That comes
 * from the provider, signature-verified, and from nowhere else.
 */

import { readAccount, withInwx } from '../inwx.js';
import { readPayments } from '../payments/config.js';
import { listOrders, loadOrder, newOrder, saveOrder, type Order } from '../payments/orders.js';
import { createOrder as createPayPalOrder } from '../payments/paypal.js';
import { createCheckoutSession } from '../payments/stripe.js';
import { sweep } from '../payments/sweep.js';
import { RpcError, type Handler } from '../rpc.js';
import { asObject, requireEnum, requireString } from '../validate.js';

/** Orders carry cents; registrars quote floats. One place to convert. */
function toCents(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

/** The four handles the registrar insists on, checked before money is asked for. */
function contacts(p: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const role of ['registrant', 'admin', 'tech', 'billing']) {
    const value = Number(p[role]);
    if (!Number.isInteger(value) || value <= 0) {
      throw RpcError.badRequest(`Für "${role}" fehlt ein Kontakt-Handle.`);
    }
    out[role] = value;
  }
  return out;
}

/**
 * An order, safe to hand to a client.
 *
 * The auth code never leaves the host: it is the secret that moves a domain
 * between registrars, it is needed exactly once at fulfilment, and a list of
 * orders is not the place for it.
 */
function forClient(order: Order): Omit<Order, 'authCode'> {
  const { authCode: _authCode, ...rest } = order;
  return rest;
}

const create: Handler = async (params) => {
  const p = asObject(params);
  const domain = requireString(p, 'domain', { maxLength: 253 }).trim().toLowerCase();
  const action = requireEnum(p, 'action', ['register', 'transfer'] as const);
  const provider = requireEnum(p, 'provider', ['stripe', 'paypal'] as const);
  const handles = contacts(p);

  const amountCents = Number(p.amountCents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw RpcError.badRequest('Der Verkaufspreis fehlt oder ist keine ganze Zahl in Cent.');
  }
  const currency = requireString(p, 'currency', { maxLength: 3 }).trim().toUpperCase();
  const email = typeof p.email === 'string' ? p.email.trim() : null;
  const authCode = typeof p.authCode === 'string' ? p.authCode.trim() : null;
  if (action === 'transfer' && !authCode) {
    throw RpcError.badRequest('Eine Übertragung braucht den Auth-Code des abgebenden Registrars.');
  }

  const payments = await readPayments();
  if (!payments) throw RpcError.badRequest('Auf diesem Host ist kein Zahlungsanbieter hinterlegt.');
  if (provider === 'paypal' && !payments.paypal) {
    throw RpcError.badRequest('Für PayPal fehlen die Zugangsdaten.');
  }
  if (provider === 'stripe' && !payments.stripe) {
    throw RpcError.badRequest('Für Stripe fehlen die Zugangsdaten.');
  }

  const account = await readAccount();
  if (!account) throw RpcError.badRequest('Auf diesem Host ist kein Registrar-Konto hinterlegt.');

  // 1. What does it cost us? Recorded on the order so a later price rise is
  //    caught at fulfilment instead of quietly eating the margin.
  const tld = domain.split('.').slice(1).join('.');
  const cost = await withInwx(account, async (session) => {
    const quoted = await session.call<{ price?: Record<string, unknown>[] }>('domain.getPrices', {
      tld: [tld],
    });
    const price = quoted.resData?.price?.[0];
    return {
      cents: toCents(action === 'transfer' ? price?.transferPrice : price?.createPrice),
      currency: typeof price?.currency === 'string' ? price.currency : currency,
    };
  });

  if (cost.cents === null) {
    throw RpcError.badRequest(
      `Der Registrar nennt für "${tld}" keinen Preis. Ohne Einkaufspreis wird nichts verkauft.`,
    );
  }

  // 2. Write it down before anyone can pay for it.
  let order = newOrder({
    domain,
    action,
    amountCents,
    currency,
    registrarCostCents: cost.cents,
    registrarCurrency: cost.currency,
    provider,
    contacts: handles,
    email,
    authCode,
  });
  await saveOrder(order);

  // 3. Now ask for a page to send the customer to.
  const description = `${action === 'transfer' ? 'Umzug' : 'Registrierung'} ${domain}`;

  try {
    const checkout =
      provider === 'paypal'
        ? await createPayPalOrder(payments.paypal!, {
            amountCents,
            currency,
            description,
            orderId: order.id,
            returnUrl: payments.successUrl,
            cancelUrl: payments.cancelUrl,
          }).then((created) => ({ id: created.id, url: created.approveUrl }))
        : await createCheckoutSession(payments.stripe!, {
            amountCents,
            currency,
            description,
            orderId: order.id,
            successUrl: payments.successUrl,
            cancelUrl: payments.cancelUrl,
            email,
          });

    order = { ...order, reference: checkout.id, updatedAt: new Date().toISOString() };
    await saveOrder(order);
    return { order: forClient(order), checkoutUrl: checkout.url };
  } catch (err) {
    // The order stays, in awaiting_payment, with no reference. It is a record
    // of an attempt rather than litter: nobody paid, and it can be cancelled.
    throw RpcError.commandFailed(
      `Die Kasse liess sich nicht öffnen: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

const list: Handler = async () => ({ orders: (await listOrders()).map(forClient) });

const get: Handler = async (params) => {
  const p = asObject(params);
  const id = requireString(p, 'id', { maxLength: 64 });
  const order = await loadOrder(id);
  if (!order) throw RpcError.notFound(`Keine Bestellung mit der Kennung ${id}.`);
  return { order: forClient(order) };
};

/**
 * Run the catch-up pass now.
 *
 * The agent runs it on a timer anyway; this is the button for somebody who is
 * looking at an order they believe is wrong and does not want to wait a
 * quarter of an hour to find out.
 */
const runSweep: Handler = async () => {
  const result = await sweep((level, message) => {
    process.stderr.write(`[orders.sweep] ${level}: ${message}` + '\n');
  });
  return { sweep: result };
};

export const orderHandlers: Record<string, Handler> = {
  'orders.create': create,
  'orders.sweep': runSweep,
  'orders.list': list,
  'orders.get': get,
};
