/**
 * PayPal: the same shape as Stripe, with one structural difference.
 *
 * Stripe hands us a secret and we verify a webhook locally with an HMAC.
 * PayPal does not: verification is a call back to PayPal carrying the headers
 * it sent. That matters more than it sounds. It means a webhook cannot be
 * checked while PayPal is unreachable, and the only safe reading of "could not
 * verify" is "not verified" — never "probably fine". Every failure path here
 * therefore returns false rather than throwing something a caller might catch
 * and shrug at.
 *
 * The second difference is the flow. Stripe's checkout completes and the money
 * is there. PayPal's order is *approved* by the customer and must then be
 * captured by us — approval alone has taken nothing. So a paid PayPal order is
 * one that has been captured, and nothing before that counts.
 */

import type { PayPalConfig } from './config.js';

const SANDBOX = 'https://api-m.sandbox.paypal.com';
const LIVE = 'https://api-m.paypal.com';

/** Sandbox unless the configuration explicitly says otherwise. */
export function baseUrl(config: PayPalConfig): string {
  return config.live ? LIVE : SANDBOX;
}

async function token(config: PayPalConfig): Promise<string> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const response = await fetch(`${baseUrl(config)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const body = (await response.json()) as { access_token?: string; error_description?: string };
  if (!response.ok || !body.access_token) {
    throw new Error(body.error_description ?? `PayPal answered HTTP ${response.status}`);
  }
  return body.access_token;
}

export interface PayPalOrderRequest {
  amountCents: number;
  currency: string;
  description: string;
  /** Ours, carried through as custom_id and returned with the event. */
  orderId: string;
  returnUrl: string;
  cancelUrl: string;
}

/**
 * Create an order and return the page to send the customer to.
 *
 * PayPal takes an amount as a decimal string, not cents — one of the few
 * places money has to be written as text. Formatting it here, once, keeps the
 * conversion away from anything that also does arithmetic.
 */
export async function createOrder(
  config: PayPalConfig,
  request: PayPalOrderRequest,
): Promise<{ id: string; approveUrl: string }> {
  const access = await token(config);

  const response = await fetch(`${baseUrl(config)}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          custom_id: request.orderId,
          description: request.description.slice(0, 127),
          amount: {
            currency_code: request.currency.toUpperCase(),
            value: (request.amountCents / 100).toFixed(2),
          },
        },
      ],
      application_context: {
        return_url: request.returnUrl,
        cancel_url: request.cancelUrl,
        user_action: 'PAY_NOW',
      },
    }),
  });

  const body = (await response.json()) as {
    id?: string;
    links?: { rel?: string; href?: string }[];
    message?: string;
  };
  const approve = body.links?.find((link) => link.rel === 'approve')?.href;
  if (!response.ok || !body.id || !approve) {
    throw new Error(body.message ?? `PayPal answered HTTP ${response.status}`);
  }
  return { id: body.id, approveUrl: approve };
}

/**
 * Take the money for an approved order.
 *
 * Idempotent at PayPal's end for an order already captured, which returns an
 * error naming that state — treated here as success, because a webhook retry
 * must not turn a completed capture into a failure.
 */
export async function captureOrder(config: PayPalConfig, paypalOrderId: string): Promise<boolean> {
  const access = await token(config);

  const response = await fetch(`${baseUrl(config)}/v2/checkout/orders/${paypalOrderId}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/json',
    },
  });

  const body = (await response.json()) as {
    status?: string;
    details?: { issue?: string }[];
    message?: string;
  };

  if (response.ok && body.status === 'COMPLETED') return true;

  // The one failure that is not one.
  if (body.details?.some((detail) => detail.issue === 'ORDER_ALREADY_CAPTURED')) return true;

  throw new Error(body.message ?? `PayPal refused the capture (HTTP ${response.status})`);
}

/**
 * What PayPal currently thinks of an order.
 *
 * Only needed by the sweep, and only because a webhook can be lost. Asking is
 * always allowed; the answer is the provider's own record rather than ours,
 * which is the point — the sweep exists precisely for the case where the two
 * disagree.
 */
export async function readOrder(
  config: PayPalConfig,
  paypalOrderId: string,
): Promise<{ status: string; amountCents: number | null; currency: string | null }> {
  const access = await token(config);

  const response = await fetch(`${baseUrl(config)}/v2/checkout/orders/${paypalOrderId}`, {
    headers: { Authorization: `Bearer ${access}` },
  });

  const body = (await response.json()) as {
    status?: string;
    purchase_units?: { amount?: { value?: string; currency_code?: string } }[];
    message?: string;
  };
  if (!response.ok) throw new Error(body.message ?? `PayPal answered HTTP ${response.status}`);

  const amount = body.purchase_units?.[0]?.amount;
  const value = Number(amount?.value);
  return {
    status: (body.status ?? '').toUpperCase(),
    amountCents: Number.isFinite(value) ? Math.round(value * 100) : null,
    currency: amount?.currency_code ? amount.currency_code.toUpperCase() : null,
  };
}

/** The headers PayPal signs a webhook with, as it spells them. */
export const PAYPAL_SIGNATURE_HEADERS = [
  'paypal-auth-algo',
  'paypal-cert-url',
  'paypal-transmission-id',
  'paypal-transmission-sig',
  'paypal-transmission-time',
] as const;

/**
 * Ask PayPal whether it sent this.
 *
 * Takes the raw body and parses it here, because the verification call wants
 * the event as an object while the signature was made over the bytes — so the
 * bytes are what gets passed around until this last moment.
 *
 * Returns false for everything that is not an explicit SUCCESS: a missing
 * header, an unparseable body, a network failure, a non-200 from PayPal. There
 * is no path through this function that treats uncertainty as approval.
 */
export async function verifyWebhook(
  config: PayPalConfig,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
): Promise<boolean> {
  const header = (name: string): string | null => {
    const value = headers[name];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return null;
  };

  const present = PAYPAL_SIGNATURE_HEADERS.map((name) => header(name));
  if (present.some((value) => value === null)) return false;
  const [authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime] = present as string[];

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return false;
  }

  try {
    const access = await token(config);
    const response = await fetch(`${baseUrl(config)}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: config.webhookId,
        webhook_event: event,
      }),
    });

    if (!response.ok) return false;
    const body = (await response.json()) as { verification_status?: string };
    return (body.verification_status ?? '').toUpperCase() === 'SUCCESS';
  } catch {
    // Unreachable, timed out, refused — all of it means unverified.
    return false;
  }
}
