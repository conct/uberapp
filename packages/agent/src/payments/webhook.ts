/**
 * The one door in this agent that opens without a token.
 *
 * Everything else sits behind the WebSocket and a shared secret. A webhook
 * cannot: Stripe has no token of ours, it has a signature. So the rules here
 * are narrower than anywhere else in the codebase.
 *
 *   - The raw bytes are verified before anything is parsed. JSON.parse of an
 *     unverified body is already trusting it.
 *   - A body larger than a webhook could plausibly be is dropped unread, so an
 *     open endpoint cannot be used to fill memory.
 *   - The answer is 200 as soon as the event is understood. Providers retry on
 *     anything else, and a retry storm caused by a slow registrar helps nobody.
 *   - Nothing here reports why a request was rejected. A prober learns whether
 *     the URL exists and nothing more.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { readPayments } from './config.js';
import { onPaid } from './fulfil.js';
import { findByReference, loadOrder } from './orders.js';
import { verifyWebhook, WebhookError } from './stripe.js';

/** Stripe's events are small; anything of this size is not one. */
const MAX_BODY_BYTES = 64 * 1024;

export const STRIPE_WEBHOOK_PATH = '/webhooks/stripe';

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new WebhookError('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

interface StripeEvent {
  type?: string;
  data?: { object?: { id?: string; client_reference_id?: string; metadata?: { orderId?: string } } };
}

/**
 * Handle POST /webhooks/stripe.
 *
 * Returns true when it took the request, so the caller can fall through to its
 * other routes without knowing anything about payments.
 */
export async function handleStripeWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  log: (level: 'info' | 'warn', message: string) => void,
): Promise<boolean> {
  if (req.url !== STRIPE_WEBHOOK_PATH) return false;

  const done = (status: number) => {
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end();
  };

  if (req.method !== 'POST') {
    done(405);
    return true;
  }

  const payments = await readPayments();
  if (!payments?.stripe) {
    // Nothing configured, so nothing to verify against. Silence is the answer.
    done(404);
    return true;
  }

  let raw: string;
  try {
    raw = await readRawBody(req);
  } catch {
    done(400);
    return true;
  }

  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string') {
    done(400);
    return true;
  }

  try {
    verifyWebhook(raw, signature, payments.stripe.webhookSecret);
  } catch {
    // Deliberately unlogged in detail and unexplained in the response: a
    // failed signature is either a prober or a misconfiguration, and the
    // difference is not something to broadcast.
    log('warn', 'a Stripe webhook failed signature verification');
    done(400);
    return true;
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(raw) as StripeEvent;
  } catch {
    done(400);
    return true;
  }

  // Only the one event that means money arrived. Everything else is
  // acknowledged so Stripe stops sending it, and ignored.
  if (event.type !== 'checkout.session.completed') {
    done(200);
    return true;
  }

  const session = event.data?.object ?? {};
  const orderId = session.metadata?.orderId ?? session.client_reference_id ?? null;
  const order = orderId ? await loadOrder(orderId) : session.id ? await findByReference(session.id) : null;

  if (!order) {
    // Acknowledged rather than retried: an event for an order this host does
    // not have will not become findable by being sent again.
    log('warn', `a paid Stripe session referred to an unknown order (${orderId ?? session.id ?? '?'})`);
    done(200);
    return true;
  }

  // Answer first, work after. The registrar takes seconds and Stripe waits
  // only so long before calling the delivery failed and trying again.
  done(200);

  try {
    await onPaid(order, `Stripe session ${session.id ?? ''}`.trim(), log);
  } catch (err) {
    log('warn', `order ${order.id}: fulfilment threw — ${String(err)}`);
  }

  return true;
}
