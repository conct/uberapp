/**
 * An order, as the app and the agent agree to talk about one.
 *
 * The state machine itself lives in the agent, because that is where money and
 * domains actually move. What lives here is the vocabulary: the set of states,
 * what each one is called in German, and which of them mean somebody has to do
 * something. The app needs all three to render a list, and a second copy of
 * them would drift the first time a state is added.
 *
 * The record below is the one a client is given, which is not the one the
 * agent keeps: an auth code — the secret that moves a domain between
 * registrars — never leaves the host, so it is not in this type at all.
 */

export const ORDER_STATES = [
  /** Created, checkout not finished. Most abandoned orders die here. */
  'awaiting_payment',
  /** The provider says the money is there. Nothing has been bought yet. */
  'paid',
  /** The registrar call is in flight. Crash here and the sweep must resolve it. */
  'registering',
  /** Done: paid, and the domain belongs to the account. */
  'completed',
  /** Paid, but the registrar refused. Somebody is owed their money back. */
  'refund_due',
  /** Money returned, whether by us or by the customer's bank. */
  'refunded',
  /** Never paid, and no longer worth waiting for. */
  'cancelled',
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

export type PaymentProvider = 'stripe' | 'paypal';

export interface OrderRecord {
  id: string;
  state: OrderState;
  domain: string;
  action: 'register' | 'transfer';
  /** What the customer pays, in the smallest unit of the currency. */
  amountCents: number;
  currency: string;
  /** What the registrar charges us. The difference is the margin. */
  registrarCostCents: number;
  registrarCurrency: string;
  provider: PaymentProvider;
  /** The provider's own id for the checkout, once one exists. */
  reference: string | null;
  email: string | null;
  contacts: Record<string, number>;
  registeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  history: { at: string; state: OrderState; note?: string }[];
}

/**
 * What to call each state on screen.
 *
 * Written from the reader's side rather than the system's: nobody outside this
 * codebase knows what "refund_due" is, but everybody understands that money
 * came in and nothing went out.
 */
export const ORDER_STATE_LABELS: Record<OrderState, string> = {
  awaiting_payment: 'Wartet auf Zahlung',
  paid: 'Bezahlt',
  registering: 'Wird eingerichtet',
  completed: 'Fertig',
  refund_due: 'Rückzahlung offen',
  refunded: 'Zurückgezahlt',
  cancelled: 'Abgebrochen',
};

/**
 * States that mean a person has to look.
 *
 * `refund_due` is the obvious one: paid for, not delivered. `registering` is
 * the quieter one — it is normal for seconds and wrong for hours, and the
 * difference is age, which the caller knows and this does not.
 */
export function orderNeedsAttention(state: OrderState): boolean {
  return state === 'refund_due';
}

/** States where nothing further will happen without somebody deciding it. */
export function orderIsFinished(state: OrderState): boolean {
  return state === 'completed' || state === 'refunded' || state === 'cancelled';
}

/** What a domain costs the seller, and what it costs the buyer. */
export interface OrderQuote {
  domain: string;
  action: 'register' | 'transfer';
  /** What the registrar charges. */
  registrarCostCents: number;
  /** What the customer pays: the registrar's price plus the host's margin. */
  amountCents: number;
  currency: string;
  /** What a year's renewal will cost, when the registrar named one. */
  renewalCents: number | null;
}

/**
 * Money as a person writes it.
 *
 * Cents in, one string out. Intl is available on both Hermes and Node here,
 * and doing this by hand is how currencies end up with the separator of
 * whoever wrote the code.
 */
export function formatMoney(cents: number, currency: string | null): string {
  const amount = cents / 100;
  const code = (currency ?? 'EUR').toUpperCase();
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: code }).format(amount);
  } catch {
    // An unknown currency code is not a reason to show nothing.
    return `${amount.toFixed(2)} ${code}`;
  }
}

/** The same, for the floats a registrar quotes. */
export function formatPrice(price: number | null, currency: string | null): string | null {
  if (price === null || !Number.isFinite(price)) return null;
  return formatMoney(Math.round(price * 100), currency);
}
