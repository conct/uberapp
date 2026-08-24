/**
 * What happens after the money arrives.
 *
 * One function, called from the webhook and from anywhere else that learns an
 * order was paid. It has to be safe to call twice: providers retry webhooks,
 * and a retry that registered a second domain would be an expensive kind of
 * bug. The state machine carries that — an order already past `paid` refuses
 * the move, and this returns quietly instead of doing the work again.
 *
 * The unhappy path is the one worth reading. If the registrar refuses, the
 * customer has paid for nothing, and the order goes to `refund_due` with the
 * reason attached. It does not refund by itself: that is somebody's money and
 * somebody's decision, and a machine that silently reverses charges is harder
 * to trust than one that raises its hand.
 */

import { readAccount, withInwx, InwxError } from '../inwx.js';
import { moveTo, saveOrder, type Order } from './orders.js';

/** The registrar quotes floats; orders keep cents. Meet in the middle, once. */
function toCents(price: unknown): number | null {
  const value = Number(price);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

export interface FulfilResult {
  order: Order;
  /** False when there was nothing to do, which a retry should not treat as failure. */
  acted: boolean;
}

/**
 * Register or transfer what an order paid for.
 *
 * `log` is passed in rather than imported so this can be exercised without a
 * running agent, and so the webhook can attribute its lines.
 */
export async function fulfil(
  order: Order,
  log: (level: 'info' | 'warn', message: string) => void,
): Promise<FulfilResult> {
  if (order.state !== 'paid') {
    // Includes the retry case: already registering, already completed, or
    // already refunded. None of them wants this to run again.
    return { order, acted: false };
  }

  const account = await readAccount();
  if (!account) {
    const stuck = moveTo(order, 'refund_due', 'No registrar account is configured on this host.');
    await saveOrder(stuck);
    log('warn', `order ${order.id}: paid, but this host has no registrar account`);
    return { order: stuck, acted: true };
  }

  // Written before the call, so a crash between here and the registrar leaves
  // an order that says "in flight" rather than one that looks untouched and
  // invites a second attempt.
  let working = moveTo(order, 'registering');
  await saveOrder(working);

  try {
    await withInwx(account, async (session) => {
      const tld = order.domain.split('.').slice(1).join('.');
      const quoted = await session.call<{ price?: Record<string, unknown>[] }>('domain.getPrices', {
        tld: [tld],
      });
      const price = quoted.resData?.price?.[0];
      const now = toCents(order.action === 'transfer' ? price?.transferPrice : price?.createPrice);

      // The margin check. The customer's price was fixed when they paid; if
      // the registrar has since raised theirs, completing the order quietly
      // eats the difference. Better to stop and let a person decide.
      if (now === null) {
        throw new InwxError(0, `Der Registrar nennt für ${tld} keinen Preis mehr.`);
      }
      if (now > order.registrarCostCents) {
        throw new InwxError(
          0,
          `Der Einkaufspreis ist von ${(order.registrarCostCents / 100).toFixed(2)} auf ` +
            `${(now / 100).toFixed(2)} gestiegen — die Bestellung wurde nicht ausgeführt.`,
        );
      }

      const common = {
        domain: order.domain,
        ...order.contacts,
      };

      if (order.action === 'transfer') {
        await session.call('domain.transfer', { ...common, authCode: order.authCode ?? '' });
      } else {
        await session.call('domain.create', { ...common, period: '1Y' });
      }
    });
  } catch (err) {
    const reason = err instanceof InwxError ? `${err.message} (${err.code})` : String(err);
    const owed = moveTo(working, 'refund_due', reason);
    await saveOrder(owed);
    log('warn', `order ${order.id}: ${order.domain} was paid for but not registered — ${reason}`);
    return { order: owed, acted: true };
  }

  working = moveTo(working, 'completed');
  await saveOrder(working);
  log('info', `order ${order.id}: ${order.domain} registered`);
  return { order: working, acted: true };
}

/**
 * Mark an order paid and carry it through, once.
 *
 * The two steps are separate on purpose: `paid` is recorded before anything is
 * bought, so a crash in the middle leaves a record that the money arrived.
 */
export async function onPaid(
  order: Order,
  note: string,
  log: (level: 'info' | 'warn', message: string) => void,
): Promise<FulfilResult> {
  if (order.state !== 'awaiting_payment') {
    return fulfil(order, log);
  }
  const paid = moveTo(order, 'paid', note);
  await saveOrder(paid);
  return fulfil(paid, log);
}
