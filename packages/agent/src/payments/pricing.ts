/**
 * What a domain costs a customer.
 *
 * One function, and it lives on the host, because the alternative is the app
 * telling the agent what something costs. The app is not a trusted party here:
 * it is software on somebody's phone, talking to an agent over a socket, and
 * any price it sends is a price it could have chosen. So the client asks what
 * a name costs and is told; it never says.
 *
 * The arithmetic is in cents throughout. A percentage margin on a float price
 * is how a domain ends up costing 14.999999999999998.
 */

import type { MarginConfig } from './config.js';

/**
 * Registrar cost plus margin, rounded up to the cent.
 *
 * Rounded up rather than to nearest: rounding a margin down means selling
 * fractionally below the intended price, every time, which is a strange thing
 * to have built on purpose.
 */
export function sellingPrice(registrarCostCents: number, margin?: MarginConfig): number {
  if (!Number.isFinite(registrarCostCents) || registrarCostCents < 0) return 0;

  const percent = Number.isFinite(margin?.percent) ? (margin?.percent as number) : 0;
  const fixed = Number.isFinite(margin?.fixedCents) ? (margin?.fixedCents as number) : 0;
  const floor = Number.isFinite(margin?.minCents) ? (margin?.minCents as number) : 0;

  const withMargin = Math.ceil(registrarCostCents * (1 + percent / 100) + fixed);
  return Math.max(withMargin, floor, 0);
}

/** Both numbers, as a quote is shown and stored. */
export interface Quote {
  registrarCostCents: number;
  amountCents: number;
  currency: string;
}

export function quoteFor(
  registrarCostCents: number,
  currency: string,
  margin?: MarginConfig,
): Quote {
  return {
    registrarCostCents,
    amountCents: sellingPrice(registrarCostCents, margin),
    currency,
  };
}
