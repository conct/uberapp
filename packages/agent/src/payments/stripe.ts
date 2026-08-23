/**
 * Stripe: a hosted checkout, and the callback that says it was paid.
 *
 * The checkout itself is deliberately dull — the agent asks Stripe for a
 * Session and hands back its URL. No card data comes near this process, which
 * is the whole reason for choosing hosted pages.
 *
 * The interesting part is verifying what comes back. A webhook is an
 * unauthenticated POST from the open internet that claims somebody paid; if
 * the signature check is wrong, anyone who guesses the URL can register
 * domains at our expense. So that check is written out here, tested against
 * known vectors, and does not silently accept anything it does not understand.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface StripeConfig {
  /** sk_test_… while developing; the live key only when it is meant. */
  secretKey: string;
  /** whsec_…, shown once when the endpoint is created in the dashboard. */
  webhookSecret: string;
}

/** Stripe's own default, and the reason a replayed event eventually stops working. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export class WebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookError';
  }
}

/**
 * The `Stripe-Signature` header, taken apart.
 *
 * It is a comma-separated list of key=value, with one timestamp and one or
 * more v1 signatures — more than one during a secret rotation, which is
 * exactly when getting this wrong would be least convenient.
 */
export function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } {
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === 't') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }

  if (timestamp === null) throw new WebhookError('The signature header carries no timestamp.');
  if (signatures.length === 0) throw new WebhookError('The signature header carries no v1 signature.');
  return { timestamp, signatures };
}

/** Constant time, and false rather than throwing on a length mismatch. */
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify a webhook, or throw.
 *
 * Takes the raw body, not a parsed object: the signature covers the exact
 * bytes Stripe sent, and re-serialising JSON changes them. Any handler that
 * parses first and verifies afterwards is not verifying anything.
 */
export function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  nowMs: number = Date.now(),
): void {
  const { timestamp, signatures } = parseSignatureHeader(signatureHeader);

  // Both directions: an old event is a replay, and one from the future means
  // a clock is wrong somewhere, which is not a thing to shrug at when money
  // is involved.
  const age = Math.abs(Math.floor(nowMs / 1000) - timestamp);
  if (age > SIGNATURE_TOLERANCE_SECONDS) {
    throw new WebhookError(`The event is ${age} seconds out of date; it will not be accepted.`);
  }

  const expected = createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  if (!signatures.some((candidate) => sameDigest(expected, candidate))) {
    throw new WebhookError('The signature does not match. The event is not from Stripe.');
  }
}

/** Only for tests and for signing a request in a sandbox. */
export function signPayload(rawBody: string, webhookSecret: string, timestampSeconds: number): string {
  const signature = createHmac('sha256', webhookSecret)
    .update(`${timestampSeconds}.${rawBody}`, 'utf8')
    .digest('hex');
  return `t=${timestampSeconds},v1=${signature}`;
}

// --- the checkout -----------------------------------------------------------

export interface CheckoutRequest {
  amountCents: number;
  currency: string;
  /** Shown on the Stripe page, so it should read like the thing being bought. */
  description: string;
  /** Carried through the whole payment and returned in the webhook. */
  orderId: string;
  successUrl: string;
  cancelUrl: string;
  email?: string | null;
}

/**
 * Ask Stripe for a hosted checkout page.
 *
 * Stripe's API takes form encoding, not JSON, including for nested fields —
 * hence the bracket notation rather than a JSON body. `client_reference_id`
 * is what ties the payment back to our order without trusting anything the
 * browser carries.
 */
export async function createCheckoutSession(
  config: StripeConfig,
  request: CheckoutRequest,
): Promise<{ id: string; url: string }> {
  const form = new URLSearchParams({
    mode: 'payment',
    success_url: request.successUrl,
    cancel_url: request.cancelUrl,
    client_reference_id: request.orderId,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': request.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(request.amountCents),
    'line_items[0][price_data][product_data][name]': request.description,
    'metadata[orderId]': request.orderId,
  });
  if (request.email) form.set('customer_email', request.email);

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  const body = (await response.json()) as { id?: string; url?: string; error?: { message?: string } };
  if (!response.ok || !body.id || !body.url) {
    throw new Error(body.error?.message ?? `Stripe answered HTTP ${response.status}`);
  }
  return { id: body.id, url: body.url };
}

/**
 * Ask Stripe what it thinks, rather than believing the browser.
 *
 * Used when somebody returns from checkout: the redirect proves nothing, and
 * the webhook may not have arrived yet.
 */
export async function readSession(
  config: StripeConfig,
  sessionId: string,
): Promise<{ paid: boolean; amountCents: number | null; currency: string | null }> {
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${config.secretKey}` },
  });
  const body = (await response.json()) as {
    payment_status?: string;
    amount_total?: number;
    currency?: string;
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(body.error?.message ?? `Stripe answered HTTP ${response.status}`);

  return {
    paid: body.payment_status === 'paid',
    amountCents: typeof body.amount_total === 'number' ? body.amount_total : null,
    currency: body.currency ? body.currency.toUpperCase() : null,
  };
}
