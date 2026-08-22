/**
 * The browser's half of the handoff: show a code, wait, connect.
 *
 * A browser cannot start a session on its own. It has no token and does not
 * even know which Uberspace it is meant to watch, so it asks — by showing a
 * slot id and a key — and the phone answers by leaving a sealed payload in
 * that slot.
 *
 * The key is generated here and never leaves the page except as pixels. It is
 * not sent to the broker, which therefore holds bytes it cannot read; see
 * @uberapp/protocol/handoff for why that is the whole point.
 *
 * The broker is assumed to sit on this page's own origin, because install.sh
 * publishes both from one subdomain. That means nothing to configure, and no
 * cross-origin request between the two.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import {
  encodeHandoffRequest,
  newHandoffSecret,
  openHandoff,
  type HandoffPayload,
} from '@uberapp/protocol';

import { getCryptoProvider, cryptoUnavailableReason } from '../api/webcrypto';
import { Body, Button, Card, ErrorBanner, InfoBanner, Loading, SectionTitle, spacing } from './components';
import { QrCode } from './QrCode';

/** Matches the broker's own slot lifetime; a stale code helps nobody. */
const CODE_LIFETIME_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

interface Secret {
  sid: string;
  key: string;
  broker: string;
  expiresAt: number;
}

/** Where install.sh puts the broker, relative to this page. */
function brokerFromLocation(): string | null {
  const origin = globalThis.location?.origin;
  if (!origin || !/^https?:/.test(origin)) return null;
  return `${origin}/connect`;
}

export function BrowserPairing({ onPaired }: { onPaired: (payload: HandoffPayload) => void }) {
  const [secret, setSecret] = useState<Secret | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  // Kept in a ref so the polling effect does not restart on every render.
  const paired = useRef(false);

  const start = useCallback(() => {
    setError(null);
    setExpired(false);
    paired.current = false;

    const crypto = getCryptoProvider();
    if (crypto === null) {
      setError(cryptoUnavailableReason());
      return;
    }

    const broker = brokerFromLocation();
    if (broker === null) {
      setError('Diese Seite kennt ihre eigene Adresse nicht, also auch nicht die des Vermittlers.');
      return;
    }

    void newHandoffSecret(crypto).then(({ sid, key }) => {
      setSecret({ sid, key, broker, expiresAt: Date.now() + CODE_LIFETIME_MS });
    });
  }, []);

  useEffect(start, [start]);

  useEffect(() => {
    if (secret === null || expired) return;

    const crypto = getCryptoProvider();
    if (crypto === null) return;

    let cancelled = false;

    const timer = setInterval(() => {
      if (cancelled || paired.current) return;

      if (Date.now() > secret.expiresAt) {
        setExpired(true);
        return;
      }

      void (async () => {
        let response: Response;
        try {
          response = await fetch(`${secret.broker}/pair/${secret.sid}`);
        } catch {
          // The phone has not been used yet, or the network blinked. Either
          // way the next tick tries again; a message here would flash on and
          // off while nothing is wrong.
          return;
        }

        // 404 is the ordinary answer while the slot is still empty.
        if (response.status !== 200) return;

        const sealed = await response.text();
        const payload = await openHandoff(crypto, secret.key, sealed);

        if (cancelled) return;
        if (payload === null) {
          // The slot is consumed either way, so this code is spent.
          setError(
            'Die Übergabe liess sich nicht entschlüsseln. Zeig einen neuen Code an und scanne ihn erneut.',
          );
          setExpired(true);
          return;
        }

        paired.current = true;
        onPaired(payload);
      })();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [secret, expired, onPaired]);

  const code =
    secret === null
      ? null
      : encodeHandoffRequest({ v: 1, broker: secret.broker, sid: secret.sid, key: secret.key });

  return (
    <Card>
      <SectionTitle>Mit der App verbinden</SectionTitle>
      <Body muted style={{ fontSize: 13 }}>
        Öffne in der Handy-App „Gerät koppeln" und halte die Kamera auf diesen Code. Dieser Browser
        bekommt daraufhin einen eigenen, befristeten Zugang.
      </Body>

      {error ? <ErrorBanner message={error} onRetry={start} /> : null}

      {expired && !error ? (
        <>
          <InfoBanner message="Der Code ist abgelaufen. Aus Sicherheitsgründen gilt er nur zwei Minuten." />
          <Button label="Neuen Code anzeigen" variant="primary" onPress={start} />
        </>
      ) : code ? (
        <>
          <View style={{ alignItems: 'center', paddingVertical: spacing.sm }}>
            <QrCode value={code} size={240} />
          </View>
          <Body muted style={{ fontSize: 12 }}>
            Der Schlüssel steckt nur in diesem Bild — der Vermittler bekommt ihn nie zu sehen und
            kann die Übergabe deshalb nicht mitlesen.
          </Body>
        </>
      ) : error ? null : (
        <Loading label="Code wird erzeugt…" />
      )}
    </Card>
  );
}
