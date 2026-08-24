/**
 * What was bought, what was paid, and what still has to happen.
 *
 * An order exists because two systems have to agree and neither can be rolled
 * back by the other: a customer's money moves at Stripe or PayPal, and a
 * domain is registered at INWX. Between those two there is a window, and
 * everything that can go wrong lives in it — paid but not registered,
 * registered but the payment later reversed, the customer closing the tab
 * halfway. A record that survives a restart is the only way to notice.
 *
 * Stored as one file per order under ~/.config/uberapp/orders. A database
 * would be the reflex, but the volume here is domains sold by one person, the
 * agent has no database, and a directory of JSON files can be read by a human
 * at three in the morning when something is stuck.
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * The states an order passes through, and the only moves allowed between them.
 *
 * Written as data rather than as ifs scattered through the handlers, because
 * the illegal moves are the interesting ones: registering something that was
 * never paid for, or marking as paid an order that was already refunded. A
 * table can be read, and tested, in one place.
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

const ALLOWED: Record<OrderState, readonly OrderState[]> = {
  awaiting_payment: ['paid', 'cancelled'],
  // Paid can go back to refunded directly: a customer can charge back before
  // anything was registered.
  paid: ['registering', 'refund_due', 'refunded'],
  registering: ['completed', 'refund_due'],
  // A completed order can still be refunded — a chargeback arrives whenever it
  // arrives — but it can never become unregistered.
  completed: ['refunded'],
  refund_due: ['refunded'],
  refunded: [],
  cancelled: [],
};

export function canMove(from: OrderState, to: OrderState): boolean {
  return ALLOWED[from].includes(to);
}

export class OrderStateError extends Error {
  constructor(from: OrderState, to: OrderState) {
    super(`An order cannot go from ${from} to ${to}.`);
    this.name = 'OrderStateError';
  }
}

export type PaymentProvider = 'stripe' | 'paypal';

export interface Order {
  id: string;
  state: OrderState;
  /** What was sold. */
  domain: string;
  action: 'register' | 'transfer';
  /** What the customer agreed to pay, in the smallest unit — never a float. */
  amountCents: number;
  currency: string;
  /**
   * What the registrar wanted when this order was taken.
   *
   * A second number because this is a resale: the customer pays one price and
   * the registrar charges another, and the difference is the margin. Recording
   * it at order time is what turns a price rise between the order and the
   * registration into something noticed rather than absorbed — fulfilment
   * passes it as the price it expects, and the registrar refuses if it moved.
   */
  registrarCostCents: number;
  registrarCurrency: string;
  provider: PaymentProvider;
  /** The provider's own id: a Checkout Session or a PayPal order. */
  reference: string | null;
  /** Who bought it, as far as we know. */
  email: string | null;
  /** Only set for a transfer; needed once, at fulfilment. */
  authCode: string | null;
  /** The registrar's contact handles this order will use. */
  contacts: Record<string, number>;
  /** Set once the registrar has confirmed. */
  registeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Everything that happened, appended, never rewritten. */
  history: { at: string; state: OrderState; note?: string }[];
}

export function ordersDir(): string {
  return join(homedir(), '.config', 'uberapp', 'orders');
}

function orderPath(id: string): string {
  return join(ordersDir(), `${id}.json`);
}

export interface NewOrder {
  domain: string;
  action: 'register' | 'transfer';
  amountCents: number;
  currency: string;
  registrarCostCents: number;
  registrarCurrency: string;
  provider: PaymentProvider;
  contacts: Record<string, number>;
  email?: string | null;
  /** Only for a transfer, and never written to the log. */
  authCode?: string | null;
}

export function newOrder(input: NewOrder, now: Date = new Date()): Order {
  const at = now.toISOString();
  return {
    id: randomUUID(),
    state: 'awaiting_payment',
    domain: input.domain,
    action: input.action,
    amountCents: input.amountCents,
    currency: input.currency,
    registrarCostCents: input.registrarCostCents,
    registrarCurrency: input.registrarCurrency,
    provider: input.provider,
    reference: null,
    email: input.email ?? null,
    authCode: input.authCode ?? null,
    contacts: input.contacts,
    registeredAt: null,
    createdAt: at,
    updatedAt: at,
    history: [{ at, state: 'awaiting_payment' }],
  };
}

/**
 * Move an order, or refuse.
 *
 * Returns a new object rather than mutating: the caller writes it, and a
 * half-applied move that was never persisted should not linger in memory
 * looking authoritative.
 */
export function moveTo(order: Order, to: OrderState, note?: string, now: Date = new Date()): Order {
  if (!canMove(order.state, to)) throw new OrderStateError(order.state, to);
  const at = now.toISOString();
  return {
    ...order,
    state: to,
    updatedAt: at,
    ...(to === 'completed' ? { registeredAt: at } : {}),
    history: [...order.history, { at, state: to, ...(note ? { note } : {}) }],
  };
}

/**
 * Write an order so a crash cannot leave half a file behind.
 *
 * Write to a temporary name, then rename: on the same filesystem that is
 * atomic, and an order file is the one record that says whether somebody's
 * money is accounted for.
 */
export async function saveOrder(order: Order): Promise<void> {
  await mkdir(ordersDir(), { recursive: true, mode: 0o700 });
  const target = orderPath(order.id);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(order, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}

export async function loadOrder(id: string): Promise<Order | null> {
  try {
    return JSON.parse(await readFile(orderPath(id), 'utf8')) as Order;
  } catch {
    return null;
  }
}

export async function listOrders(): Promise<Order[]> {
  let names: string[];
  try {
    names = await readdir(ordersDir());
  } catch {
    return [];
  }

  const orders: Order[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const order = await loadOrder(name.slice(0, -'.json'.length));
    if (order) orders.push(order);
  }
  // Newest first: the ones somebody is waiting on are the recent ones.
  return orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Find the order a provider's callback is about. */
export async function findByReference(reference: string): Promise<Order | null> {
  const all = await listOrders();
  return all.find((order) => order.reference === reference) ?? null;
}
