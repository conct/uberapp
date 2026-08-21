/**
 * Platform shape detection.
 *
 * Only used to decide where a warning belongs, never to gate functionality —
 * user-agent sniffing is too unreliable for anything load-bearing.
 */

import { Platform } from 'react-native';

const MOBILE_UA = /Android|iPhone|iPad|iPod|Windows Phone|Mobile|Tablet/i;

/**
 * True for a desktop browser. Native builds are false: they have a real
 * keychain, so warnings about insecure storage do not apply to them.
 */
export function isDesktopWeb(): boolean {
  if (Platform.OS !== 'web') return false;

  const navigator = globalThis.navigator as
    | (Navigator & { userAgentData?: { mobile?: boolean } })
    | undefined;
  if (!navigator) return false;

  // Client Hints answer this directly where they exist; the UA string is the
  // fallback for everything else.
  const hint = navigator.userAgentData?.mobile;
  if (typeof hint === 'boolean') return !hint;

  // Treat a touch-first device as mobile even when the UA is ambiguous.
  if (navigator.maxTouchPoints > 1 && MOBILE_UA.test(navigator.userAgent ?? '')) return false;

  return !MOBILE_UA.test(navigator.userAgent ?? '');
}
