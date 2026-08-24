/**
 * The catch-up pass, for everything the webhooks missed.
 *
 * Webhooks are the fast path, not the reliable one. The host can be down when
 * a provider calls, a provider can give up retrying, a process can die between
 * writing `paid` and reaching the registrar. Each of those leaves an order that
 * is wrong in a way nobody notices — usually money taken and nothing delivered,
 * which is the failure that matters most here.
 *
 * So this asks the providers directly, once in a while, and reconciles. The
 * rule it works to: the provider's record wins over ours about money, the
 * registrar's record wins over ours about domains, and where neither can
 * answer, the order is reported rather than guessed at.
 *
 * What it deliberately never does is refund, or register a transfer twice. A
 * transfer that has not shown up at the registrar may still be in flight for
 * days; calling that a failure would be wrong, and re-issuing it would be
 * expensive. It gets named in the report and left alone.
 */

import { readAccount, withInwx } from '../inwx.js';
import { readPayments, type PaymentsConfig } from './config.js';
import { fulfil, onPaid } from './fulfil.js';
import { listOrders, moveTo, saveOrder, type Order } from './orders.js';
import { captureOrder, readOrder as readPayPalOrder } from './paypal.js';
import { readSession } from './stripe.js';

/**
 * How long an unpaid order is worth asking about.
 *
 * A checkout page that has been open for a day was abandoned. Cancelling it is
 * housekeeping, not a decision: cancelled orders can never become paid, and a
 * customer who does pay after this would fail at the provider, not here.
 */
export const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * How long a registration may sit in flight before it counts as not happened.
 *
 * The registrar call takes seconds. An hour is not a slow call, it is a
 * process that died in the middle of one.
 */
export const STUCK_AFTER_MS = 60 * 60 * 1000;

export interface SweepResult {
  checked: number;
  /** Orders that turned out to be paid after all, and were carried through. */
  recovered: number;
  /** Unpaid and given up on. */
  cancelled: number;
  /** Stuck registrations resolved one way or the other. */
  resolved: number;
  /** Orders that need a person: refund_due, or in flight past all patience. */
  attention: string[];
  /** One line per thing done or noticed, in the order it happened. */
  notes: string[];
}

type Log = (level: 'info' | 'warn', message: string) => void;

function ageMs(order: Order, now: number): number {
  const at = Date.parse(order.updatedAt);
  return Number.isFinite(at) ? now - at : 0;
}

/**
 * Ask a provider whether an order was paid.
 *
 * Three answers, and the middle one is the reason this is not a boolean:
 * 'paid', 'open' (still waiting, ask again later), 'dead' (the provider says
 * this will never be paid). Anything unanswerable is 'open', because a
 * provider we cannot reach is not evidence of anything.
 */
async function paymentState(
  order: Order,
  payments: PaymentsConfig,
  log: Log,
): Promise<'paid' | 'open' | 'dead'> {
  if (!order.reference) return 'open';

  try {
    if (order.provider === 'stripe') {
      if (!payments.stripe) return 'open';
      return (await readSession(payments.stripe, order.reference)).paid ? 'paid' : 'open';
    }

    if (!payments.paypal) return 'open';
    const remote = await readPayPalOrder(payments.paypal, order.reference);

    if (remote.status === 'COMPLETED') return 'paid';
    if (remote.status === 'VOIDED') return 'dead';
    if (remote.status === 'APPROVED') {
      // Approved and never captured: the customer did their part and our
      // capture was lost with the webhook. Taking it now is the whole point of
      // this pass.
      await captureOrder(payments.paypal, order.reference);
      return 'paid';
    }
    return 'open';
  } catch (err) {
    log('warn', `order ${order.id}: the provider could not be asked — ${String(err)}`);
    return 'open';
  }
}

/**
 * Decide a registration that was in flight when something stopped.
 *
 * The registrar is asked whether the domain is in the account. That answer is
 * the only trustworthy one: our own record says the call was started, not that
 * it landed.
 */
async function resolveRegistering(order: Order, now: number, log: Log): Promise<Order | null> {
  const account = await readAccount();
  if (!account) return null;

  let ours = false;
  try {
    ours = await withInwx(account, async (session) => {
      await session.call('domain.info', { domain: order.domain });
      return true;
    });
  } catch {
    // Not in the account, or the registrar is unreachable. The two are told
    // apart by time below, not by the error — an outage must not be read as a
    // failed registration.
    ours = false;
  }

  if (ours) {
    const done = moveTo(order, 'completed', 'Beim Nachlauf beim Registrar bestätigt.');
    await saveOrder(done);
    log('info', `order ${order.id}: ${order.domain} was registered after all`);
    return done;
  }

  if (order.action === 'transfer') {
    // A transfer lives at the losing registrar for days. Absence proves
    // nothing yet.
    return null;
  }

  if (ageMs(order, now) < STUCK_AFTER_MS) return null;

  const owed = moveTo(
    order,
    'refund_due',
    'Die Registrierung wurde begonnen, ist beim Registrar aber nicht nachweisbar.',
  );
  await saveOrder(owed);
  log('warn', `order ${order.id}: ${order.domain} is paid for and not registered`);
  return owed;
}

/**
 * One pass over every order.
 *
 * Safe to run at any time and safe to run twice: every step it takes goes
 * through the same state machine as the webhooks, which refuses anything that
 * has already happened.
 */
export async function sweep(log: Log, now: number = Date.now()): Promise<SweepResult> {
  const result: SweepResult = {
    checked: 0,
    recovered: 0,
    cancelled: 0,
    resolved: 0,
    attention: [],
    notes: [],
  };

  const orders = await listOrders();
  const payments = await readPayments();

  for (const order of orders) {
    result.checked += 1;

    if (order.state === 'refund_due') {
      result.attention.push(order.id);
      result.notes.push(`${order.domain}: bezahlt, nicht geliefert — Rückzahlung offen.`);
      continue;
    }

    if (order.state === 'completed' || order.state === 'refunded' || order.state === 'cancelled') {
      continue;
    }

    if (order.state === 'paid') {
      // Paid, and fulfilment never ran or never finished. Idempotent by design.
      const { order: after, acted } = await fulfil(order, log);
      if (acted) {
        result.resolved += 1;
        result.notes.push(`${order.domain}: Ausführung nachgeholt (${after.state}).`);
        if (after.state === 'refund_due') result.attention.push(after.id);
      }
      continue;
    }

    if (order.state === 'registering') {
      const after = await resolveRegistering(order, now, log);
      if (after) {
        result.resolved += 1;
        result.notes.push(`${order.domain}: offene Registrierung geklärt (${after.state}).`);
        if (after.state === 'refund_due') result.attention.push(after.id);
      } else if (ageMs(order, now) >= STUCK_AFTER_MS) {
        result.attention.push(order.id);
        result.notes.push(`${order.domain}: seit Längerem in Ausführung — bitte ansehen.`);
      }
      continue;
    }

    // awaiting_payment
    if (!payments) continue;

    const state = await paymentState(order, payments, log);

    if (state === 'paid') {
      const { order: after } = await onPaid(order, 'Beim Nachlauf beim Anbieter bestätigt.', log);
      result.recovered += 1;
      result.notes.push(`${order.domain}: Zahlung nachträglich erkannt (${after.state}).`);
      if (after.state === 'refund_due') result.attention.push(after.id);
      continue;
    }

    if (state === 'dead' || ageMs(order, now) >= ABANDON_AFTER_MS) {
      const gone = moveTo(
        order,
        'cancelled',
        state === 'dead' ? 'Vom Anbieter abgebrochen.' : 'Nicht bezahlt, Frist abgelaufen.',
      );
      await saveOrder(gone);
      result.cancelled += 1;
      result.notes.push(`${order.domain}: unbezahlt verfallen.`);
    }
  }

  return result;
}

/** How often the agent runs the pass by itself. */
export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Run the pass on a timer for as long as the agent lives.
 *
 * Unref'd: a background timer must never be the reason the process stays up,
 * and a sweep that would have run at the moment of shutdown loses nothing by
 * waiting for the next start.
 */
export function startSweeping(log: Log): NodeJS.Timeout {
  const run = () => {
    void sweep(log).then(
      (result) => {
        if (result.recovered || result.cancelled || result.resolved || result.attention.length) {
          log(
            'info',
            `sweep: ${result.recovered} recovered, ${result.resolved} resolved, ` +
              `${result.cancelled} cancelled, ${result.attention.length} need attention`,
          );
        }
      },
      (err: unknown) => log('warn', `sweep failed: ${String(err)}`),
    );
  };

  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}
