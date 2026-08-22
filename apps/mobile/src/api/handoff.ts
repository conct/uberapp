/**
 * The phone's half of the browser handoff.
 *
 * A browser shows a code; this reads it, mints a token on the agent it is
 * currently connected to, seals the connection details with the key from that
 * code, and leaves the result in the broker's slot. The browser collects it
 * moments later and connects on its own.
 *
 * Three things are worth stating about what travels:
 *
 *   - The token is minted for this one browser and expires. The phone never
 *     hands over its own credential, so revoking the browser later costs
 *     nothing here.
 *   - The key came from the camera and goes no further. Not to the broker, not
 *     to the agent, not into storage.
 *   - What the broker receives is ciphertext. It learns a slot id and a length.
 *
 * The browser side lives in the web build; both use the same encode/decode and
 * seal/open pair from @uberapp/protocol so neither can drift.
 */

import {
  sealHandoff,
  type HandoffPayload,
  type HandoffRequest,
  type IssuedToken,
} from '@uberapp/protocol';

import { client } from './client';
import { getCryptoProvider, cryptoUnavailableReason } from './webcrypto';

/** Long enough for a session at a desk, short enough to go stale by morning. */
export const BROWSER_TOKEN_TTL_SECONDS = 12 * 60 * 60;

export class HandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandoffError';
  }
}

/**
 * Mint, seal, deposit.
 *
 * `url` is the address this app reached the agent on. The agent cannot supply
 * it — it listens on 0.0.0.0 and knows nothing about the web backend in front
 * of it — so it is passed in, exactly as the older pairing code does.
 */
export async function depositHandoff(options: {
  request: HandoffRequest;
  url: string;
  label: string;
  ttlSeconds?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const crypto = getCryptoProvider();
  if (crypto === null) throw new HandoffError(cryptoUnavailableReason());

  const ttlSeconds = options.ttlSeconds ?? BROWSER_TOKEN_TTL_SECONDS;

  const issued = await client.call<IssuedToken>('auth.issueToken', {
    label: `Browser (${options.label})`,
    ttlSeconds,
  });

  try {
    const payload: HandoffPayload = {
      v: 1,
      url: options.url,
      token: issued.token,
      exp: issued.expiresAt,
      label: options.label,
    };

    const sealed = await sealHandoff(crypto, options.request.key, payload);

    let response: Response;
    try {
      response = await fetch(`${options.request.broker}/pair/${options.request.sid}`, {
        method: 'PUT',
        body: sealed,
        signal: options.signal,
      });
    } catch (err) {
      throw new HandoffError(
        `Der Vermittler ist nicht erreichbar (${(err as Error).message}). ` +
          'Läuft er, und stimmt die Adresse im Code?',
      );
    }

    if (response.status === 409) {
      throw new HandoffError(
        'Dieser Code wurde bereits benutzt. Lass dir im Browser einen neuen anzeigen.',
      );
    }

    if (!response.ok) {
      throw new HandoffError(
        `Der Vermittler hat die Übergabe abgelehnt (HTTP ${response.status}).`,
      );
    }
  } catch (err) {
    // The token exists on the agent from the moment it is minted, and if the
    // deposit did not happen no browser will ever hold it. Leaving it would
    // put a live credential in the list for nobody — and the most likely
    // failure here is a re-used code, which a user answers by scanning again,
    // quietly collecting one orphan per attempt.
    //
    // Failing to revoke is not worth reporting over the failure that caused
    // it: the token expires on its own, and the user can revoke it by hand.
    await client
      .call('auth.revokeToken', { id: issued.id })
      .catch(() => undefined);
    throw err;
  }
}
