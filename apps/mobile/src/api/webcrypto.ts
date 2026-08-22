/**
 * WebCrypto, from wherever this build actually has it.
 *
 * The handoff seals a payload on the phone and unseals it in a browser, using
 * the same code on both sides (@uberapp/protocol/handoff). What differs is
 * where the primitives come from:
 *
 *   browser   globalThis.crypto — always there on a secure origin
 *   Hermes    react-native-quick-crypto, which has no global to hook into
 *
 * So the provider is looked up rather than assumed, and the caller is told
 * plainly when there is none instead of failing later inside an encrypt call.
 */

import { Platform } from 'react-native';
import type { CryptoProvider } from '@uberapp/protocol';

let cached: CryptoProvider | null | undefined;

function looksUsable(value: unknown): value is CryptoProvider {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CryptoProvider>;
  return (
    typeof candidate.getRandomValues === 'function' &&
    typeof candidate.subtle === 'object' &&
    candidate.subtle !== null &&
    typeof (candidate.subtle as { importKey?: unknown }).importKey === 'function'
  );
}

export function getCryptoProvider(): CryptoProvider | null {
  if (cached !== undefined) return cached;

  // A browser on https. Also covers a dev build that installed a global.
  if (looksUsable(globalThis.crypto)) {
    cached = globalThis.crypto as unknown as CryptoProvider;
    return cached;
  }

  // On http://localhost a browser still provides subtle; on plain http from
  // another host it does not, and there is nothing to fall back to there.
  if (Platform.OS === 'web') {
    cached = null;
    return cached;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require('react-native-quick-crypto') as { default?: unknown };
    const base = module.default ?? module;
    cached = looksUsable(base) ? base : null;
  } catch {
    // A build without the native module. Pairing is simply not offered.
    cached = null;
  }

  return cached;
}

/** Why pairing is unavailable, in words that point at the fix. */
export function cryptoUnavailableReason(): string {
  return Platform.OS === 'web'
    ? 'Dieser Browser stellt keine Verschlüsselung bereit. Das passiert bei einer unverschlüsselten Verbindung — ruf die Seite über https auf.'
    : 'Diese App-Variante enthält die nötige Verschlüsselung nicht. Sie kommt aus react-native-quick-crypto, das nur in einem eigenen Build steckt.';
}
