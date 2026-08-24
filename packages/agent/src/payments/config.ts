/**
 * The payment provider credentials, and the switch that turns selling on.
 *
 * Same arrangement as the registrar account next to it: a file in
 * ~/.config/uberapp, absent on every host that does not sell anything, and its
 * absence is what keeps the `payments` capability — and therefore every screen
 * behind it — out of a build that has no business with money.
 *
 * The keys here are more dangerous than the registrar's. A Stripe secret key
 * can move money and read a customer list. Mode 600 is the floor, not the
 * ceiling, and the live keys belong on a host that is not also a playground.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { StripeConfig } from './stripe.js';

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  /** The id of the webhook as PayPal created it; needed to verify callbacks. */
  webhookId: string;
  /** Sandbox unless told otherwise, for the same reason INWX defaults to OT&E. */
  live?: boolean;
}

export interface PaymentsConfig {
  stripe?: StripeConfig;
  paypal?: PayPalConfig;
  /**
   * Where the provider sends somebody after checkout. Two paths on a host the
   * customer can reach — the app's own address is not one, since a browser
   * comes back here, not into an installed app.
   */
  successUrl: string;
  cancelUrl: string;
}

export function paymentsPath(): string {
  return join(homedir(), '.config', 'uberapp', 'payments.json');
}

/**
 * Read the configuration, or null.
 *
 * Null covers both "no file" and "a file that does not make sense". A
 * half-configured payment setup is worse than none: it would offer a checkout
 * that cannot complete, after somebody has already been shown a price.
 */
export async function readPayments(): Promise<PaymentsConfig | null> {
  let raw: string;
  try {
    raw = await readFile(paymentsPath(), 'utf8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PaymentsConfig>;
    if (typeof parsed.successUrl !== 'string' || typeof parsed.cancelUrl !== 'string') return null;

    const stripe =
      parsed.stripe &&
      typeof parsed.stripe.secretKey === 'string' &&
      typeof parsed.stripe.webhookSecret === 'string'
        ? parsed.stripe
        : undefined;

    const paypal =
      parsed.paypal &&
      typeof parsed.paypal.clientId === 'string' &&
      typeof parsed.paypal.clientSecret === 'string' &&
      typeof parsed.paypal.webhookId === 'string'
        ? parsed.paypal
        : undefined;

    // Neither provider configured means nothing can be sold, which is the same
    // as having no file at all.
    if (!stripe && !paypal) return null;

    return {
      successUrl: parsed.successUrl,
      cancelUrl: parsed.cancelUrl,
      ...(stripe ? { stripe } : {}),
      ...(paypal ? { paypal } : {}),
    };
  } catch {
    return null;
  }
}
