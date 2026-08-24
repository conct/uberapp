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
 * Stored as one file per order under ~/.config/uberctrl/orders. A database
 * would be the reflex, but the volume here is domains sold by one person, the
 * agent has no database, and a directory of JSON files can be read by a human
 * at three in the morning when something is stuck.
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  ORDER_STATES,
  type OrderRecord,
  type OrderState,
  type PaymentProvider,
} from '@uberctrl/protocol';

/**
 * The states, and the only moves allowed between them.
 *
 * The list of states is the protocol's, because the app renders them too. The
 * table below is not: it is the rule about what may follow what, and it lives
 * next to the code that moves orders. Written as data rather than as ifs
 * scattered through the handlers, because the illegal moves are the
 * interesting ones — registering something that was never paid for, or marking
 * as paid an order that was already refunded. A table can be read, and tested,
 * in one place.
 */

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

/**
 * The order as the host keeps it: everything the client sees, plus the one
 * thing it must not. The auth code is the secret that moves a domain between
 * registrars, it is needed exactly once at fulfilment, and it is stripped
 * before an order is handed out.
 */
export interface Order extends OrderRecord {
  authCode: string | null;
}

/** Re-exported so nothing importing an order also has to import the protocol. */
export { ORDER_STATES };
export type { OrderRecord, OrderState, PaymentProvider };

export function ordersDir(): string {
  return join(homedir(), '.config', 'uberctrl', 'orders');
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
