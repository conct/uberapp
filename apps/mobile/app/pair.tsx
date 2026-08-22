/**
 * Pairing: hand this agent to a second client.
 *
 * The code carries the agent's address and a token minted for the occasion.
 * The address is added here rather than by the agent for a plain reason — the
 * agent listens on 0.0.0.0 and knows nothing about the web backend in front of
 * it. Only this client knows the URL it reached the agent on.
 */

import { useEffect, useState } from 'react';
import { View } from 'react-native';
import {
  DEFAULT_TOKEN_TTL_SECONDS,
  decodeHandoffRequest,
  type IssuedTokenInfo,
} from '@uberapp/protocol';

import { depositHandoff, HandoffError } from '../src/api/handoff';
import { loadCredentials } from '../src/api/storage';
import { useConnection, useMutation, useQuery } from '../src/api/hooks';
import {
  Badge,
  Body,
  Button,
  Card,
  ChoiceGroup,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  InfoBanner,
  Loading,
  Mono,
  SectionTitle,
  spacing,
} from '../src/ui/components';
import { QrScanner } from '../src/ui/QrScanner';
import { ScreenScroll } from '../src/ui/Screen';
import { useTheme } from '../src/ui/theme';

type Ttl = '3600' | '43200' | '604800';

const TTL_OPTIONS: ReadonlyArray<{ value: Ttl; label: string; hint: string }> = [
  { value: '3600', label: 'Eine Stunde', hint: 'Für einen kurzen Blick auf einem fremden Rechner.' },
  {
    value: String(DEFAULT_TOKEN_TTL_SECONDS) as Ttl,
    label: 'Zwölf Stunden',
    hint: 'Reicht für einen Arbeitstag und ist am nächsten Morgen abgelaufen.',
  },
  { value: '604800', label: 'Eine Woche', hint: 'Für einen Rechner, den nur du benutzt.' },
];

export default function PairScreen() {
  const theme = useTheme();
  const connection = useConnection();

  const [url, setUrl] = useState<string | null>(null);
  const [ttl, setTtl] = useState<Ttl>(String(DEFAULT_TOKEN_TTL_SECONDS) as Ttl);
  const [revoking, setRevoking] = useState<IssuedTokenInfo | null>(null);

  // Browser handoff, which is a separate flow from the code shown below.
  const [scanning, setScanning] = useState(false);
  const [depositing, setDepositing] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [handoffNote, setHandoffNote] = useState<string | null>(null);

  const tokens = useQuery<IssuedTokenInfo[]>('auth.listTokens');
  const isMaster = connection.session?.auth?.kind !== 'issued';

  const revoke = useMutation<{ id: string }>('auth.revokeToken', {
    onSuccess: () => tokens.refresh(),
  });

  // The address the code has to carry is the one this client connected on.
  useEffect(() => {
    void loadCredentials().then((credentials) => setUrl(credentials?.url ?? null));
  }, []);

  /**
   * A scanned browser code. The decoder rejects anything else, which a camera
   * pointed at a room supplies in quantity — including the *other* code this
   * screen can show, which carries a token and must never be fed back here.
   */
  const onBrowserCode = (text: string) => {
    const request = decodeHandoffRequest(text);
    if (!request) {
      setHandoffNote('Das ist kein Browser-Code. Halte die Kamera auf den Code, den die Seite zeigt.');
      return;
    }

    setScanning(false);
    setHandoffNote(null);
    setHandoffError(null);

    if (!url) {
      setHandoffError('Die Adresse des Agenten ist noch nicht geladen.');
      return;
    }

    setDepositing(true);
    void depositHandoff({ request, url, label: hostOf(url), ttlSeconds: Number(ttl) })
      .then(() => {
        setHandoffNote('Übergeben. Der Browser sollte sich jetzt von selbst verbinden.');
        tokens.refresh();
      })
      .catch((err: unknown) => {
        setHandoffError(
          err instanceof HandoffError || err instanceof Error
            ? err.message
            : 'Die Übergabe ist fehlgeschlagen.',
        );
      })
      .finally(() => setDepositing(false));
  };

  if (connection.state === 'ready' && !isMaster) {
    return (
      <ScreenScroll>
        <Card>
          <EmptyState
            title="Dieses Gerät ist selbst gekoppelt"
            hint="Weitergeben darf nur das Gerät, das den Agenten eingerichtet hat. Sonst liesse sich ein Zugang nicht mehr zurücknehmen — der widerrufene hätte längst weitere verteilt."
          />
        </Card>
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll refreshing={tokens.refreshing} onRefresh={tokens.refresh}>
      <View style={{ gap: spacing.xs }}>
        <Body muted>Einen zweiten Zugang erzeugen, ohne dein eigenes Token weiterzugeben</Body>
      </View>

      {/*
        The way round that works without a webcam. The browser cannot start on
        its own — it has no token and does not even know which Uberspace it
        should ask — so it shows a code and this reads it. Desktops often have
        no camera, and the ones that do are the wrong end to point at a screen.
      */}
      <Card>
        <SectionTitle>Browser koppeln</SectionTitle>
        <Body muted style={{ fontSize: 13 }}>
          Öffne {browserHint(url)} am Rechner und halte die Kamera auf den Code, den die Seite
          zeigt. Der Browser bekommt danach einen eigenen, befristeten Zugang — dein Token bleibt
          hier.
        </Body>

        <SectionTitle>Wie lange soll der Zugang gelten?</SectionTitle>
        <ChoiceGroup options={TTL_OPTIONS} value={ttl} onChange={setTtl} />

        {scanning ? (
          <QrScanner
            onResult={onBrowserCode}
            onCancel={() => {
              setScanning(false);
              setHandoffNote(null);
            }}
          />
        ) : (
          <Button
            label={depositing ? 'Übergabe läuft…' : 'Code im Browser scannen'}
            variant="primary"
            loading={depositing}
            disabled={depositing || connection.state !== 'ready'}
            onPress={() => {
              setHandoffNote(null);
              setHandoffError(null);
              setScanning(true);
            }}
          />
        )}

        {handoffError ? <ErrorBanner message={handoffError} /> : null}
        {handoffNote ? <InfoBanner message={handoffNote} /> : null}
      </Card>

      <Card>
        <SectionTitle>Gekoppelte Zugänge</SectionTitle>
        {revoke.error ? <ErrorBanner message={revoke.error} /> : null}

        {tokens.loading ? (
          <Loading />
        ) : tokens.error ? (
          <ErrorBanner message={tokens.error} onRetry={tokens.refresh} />
        ) : (tokens.data?.length ?? 0) === 0 ? (
          <EmptyState title="Keine" hint="Erzeugte Zugänge erscheinen hier und lassen sich jederzeit zurücknehmen." />
        ) : (
          tokens.data?.map((entry) => (
            <View key={entry.id} style={{ gap: 4, paddingVertical: spacing.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Body style={{ flex: 1 }} numberOfLines={1}>
                  {entry.label ?? 'Ohne Namen'}
                </Body>
                <Badge
                  label={entry.expired ? 'abgelaufen' : 'gültig'}
                  color={entry.expired ? theme.textFaint : theme.success}
                />
              </View>
              <Mono style={{ fontSize: 11, color: theme.textFaint }}>
                bis {formatExpiry(entry.expiresAt)} ·{' '}
                {entry.lastUsedAt ? `zuletzt ${formatExpiry(entry.lastUsedAt)}` : 'nie benutzt'}
              </Mono>
              <Button label="Zurücknehmen" variant="danger" onPress={() => setRevoking(entry)} />
            </View>
          ))
        )}
      </Card>

      <ConfirmDialog
        visible={revoking !== null}
        title="Zugang zurücknehmen"
        message={`Das gekoppelte Gerät wird beim nächsten Zugriff abgewiesen und eine offene Verbindung getrennt.`}
        confirmLabel="Zurücknehmen"
        destructive
        onConfirm={() => {
          const target = revoking;
          setRevoking(null);
          if (target) void revoke.run({ id: target.id }).catch(() => {});
        }}
        onCancel={() => setRevoking(null)}
      />
    </ScreenScroll>
  );
}

function formatExpiry(value: number | null): string {
  if (value === null) return 'unbegrenzt';
  const date = new Date(value);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${date.toLocaleDateString()} ${time}`;
}

/** The host out of a wss:// address, which is what a person recognises. */
function hostOf(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? url;
}

/**
 * Where the browser view lives, when it can be worked out.
 *
 * install.sh publishes it at uberapp.<user>.uber.space — a subdomain of the
 * default domain, which is the one address that always exists. A custom domain
 * for the agent tells us nothing about where the view was put, so that case
 * says so rather than inventing a link.
 */
function browserHint(url: string | null): string {
  if (!url) return 'die Web-Ansicht';
  const host = hostOf(url);
  return /\.uber\.space$/.test(host) ? `https://uberapp.${host}` : 'die Web-Ansicht';
}
