/**
 * Connection setup: where the agent lives and which token opens it.
 */

import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { Link, useRouter } from 'expo-router';

import { decodePairing } from '@uberapp/protocol';

import { client, httpUrl, normalizeUrl } from '../src/api/client';
import { useConnection } from '../src/api/hooks';
import {
  clearCredentials,
  loadCredentials,
  saveCredentials,
  secureStorageAvailable,
} from '../src/api/storage';
import {
  Body,
  Button,
  Card,
  ErrorBanner,
  Field,
  KeyValue,
  SectionTitle,
  Title,
  spacing,
} from '../src/ui/components';
import { OnboardingOverlay } from '../src/ui/Onboarding';
import { isDesktopWeb } from '../src/ui/platform';
import { QrScanner } from '../src/ui/QrScanner';
import { useTheme } from '../src/ui/theme';

/**
 * Shown once per app session, not once per visit to this screen: neither the
 * setup steps nor the storage risk change while the app is open, and
 * re-prompting trains people to dismiss without reading.
 */
let guideAcknowledged = false;

export default function ConnectScreen() {
  const theme = useTheme();
  const router = useRouter();
  const connection = useConnection();

  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [probe, setProbe] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [touched, setTouched] = useState(false);

  const [guide, setGuide] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);

  /**
   * A scanned pairing code carries both halves, so it can connect straight
   * away. The decoder rejects anything that is not a pairing code, which a
   * camera pointed at the world will otherwise supply plenty of.
   */
  const onScanned = (text: string) => {
    const payload = decodePairing(text);
    if (!payload) {
      setScanNote('Das ist kein Kopplungs-Code. Halte die Kamera auf den Code aus der App.');
      return;
    }
    if (payload.exp !== null && payload.exp <= Date.now()) {
      setScanNote('Dieser Code ist abgelaufen. Lass dir in der App einen neuen zeigen.');
      return;
    }

    setScanning(false);
    setScanNote(null);
    setUrl(payload.url);
    setToken(payload.token);
    setTouched(true);
    void saveCredentials({ url: payload.url, token: payload.token }).then(() =>
      client.connect(payload.url, payload.token),
    );
  };

  // The storage warning is only shown where it is both true and actionable: a
  // desktop browser with no keychain. On a phone browser the advice ("use the
  // native app") points at the app the user already has, and native builds are
  // unaffected.
  const insecureStorage = !secureStorageAvailable && isDesktopWeb();

  const dismissGuide = () => {
    guideAcknowledged = true;
    setGuide(false);
  };

  useEffect(() => {
    void loadCredentials().then((credentials) => {
      if (credentials) {
        setUrl(credentials.url);
        setToken(credentials.token);
      }
      // Open the guide on first use, or whenever the token would land in
      // insecure storage — but never twice in one session.
      if (!guideAcknowledged && (!credentials || insecureStorage)) setGuide(true);
    });
    // Runs once: insecureStorage cannot change while the app is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leave the modal once the agent has accepted us.
  useEffect(() => {
    if (touched && connection.state === 'ready') router.replace('/');
  }, [touched, connection.state, router]);

  const urlError =
    touched && !url.trim()
      ? 'Pflichtfeld'
      : url.trim() && !/^wss?:\/\/[^\s/]+/.test(normalizeUrl(url))
        ? 'Sieht nicht wie eine gültige Adresse aus'
        : null;

  const tokenError = touched && token.trim().length < 24 ? 'Mindestens 24 Zeichen' : null;
  const canSubmit = url.trim().length > 0 && token.trim().length >= 24;

  /**
   * Hit /healthz first. A plain HTTP probe distinguishes "wrong address" from
   * "wrong token", which the WebSocket handshake alone cannot.
   */
  const testConnection = async () => {
    setProbing(true);
    setProbe(null);
    try {
      const response = await fetch(`${httpUrl(url)}/healthz`);
      const body = (await response.json()) as { agent?: string; protocol?: number };
      setProbe(
        body.agent
          ? `Agent v${body.agent} erreichbar (Protokoll v${body.protocol}).`
          : 'Antwort erhalten, aber es meldet sich kein Uberapp-Agent.',
      );
    } catch (err) {
      setProbe(`Nicht erreichbar: ${(err as Error).message}`);
    } finally {
      setProbing(false);
    }
  };

  const submit = async () => {
    setTouched(true);
    if (!canSubmit) return;

    const normalized = normalizeUrl(url);
    await saveCredentials({ url: normalized, token: token.trim() });
    client.connect(normalized, token.trim());
  };

  const forget = async () => {
    client.disconnect();
    await clearCredentials();
    setUrl('');
    setToken('');
    setTouched(false);
    setProbe(null);
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <OnboardingOverlay
        agentReachable={connection.state === 'ready'}
        visible={guide}
        onDismiss={dismissGuide}
        insecureStorage={insecureStorage}
        onApplyUrl={setUrl}
      />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        <View style={{ gap: spacing.sm }}>
          <Title>Mit dem Uberspace verbinden</Title>
          <Body muted>
            Die App spricht mit dem Agenten, der auf deinem Uberspace läuft — nicht direkt per SSH.
          </Body>
        </View>

        {scanning ? (
          <QrScanner onResult={onScanned} onCancel={() => setScanning(false)} />
        ) : Platform.OS === 'web' ? (
          <Card>
            <SectionTitle>Schneller: koppeln</SectionTitle>
            <Body muted>
              Zeig dir in der Handy-App unter „Gerät koppeln" einen Code an und halte die Kamera
              darauf. Adresse und Token kommen dann von selbst.
            </Body>
            {scanNote ? <Body muted>{scanNote}</Body> : null}
            <Button label="Mit QR-Code verbinden" onPress={() => setScanning(true)} />
          </Card>
        ) : null}

        <Card>
          <Field
            label="Adresse des Agenten"
            value={url}
            onChangeText={setUrl}
            placeholder="uberapp.deine-domain.de"
            keyboardType="url"
            error={urlError}
            hint="https:// wird automatisch zu wss://"
          />
          <Field
            label="Token"
            value={token}
            onChangeText={setToken}
            placeholder="aus ~/.config/uberapp/token"
            secureTextEntry
            error={tokenError}
          />

          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Button
              label="Testen"
              onPress={testConnection}
              loading={probing}
              disabled={!url.trim()}
              style={{ flex: 1 }}
            />
            <Button
              label="Verbinden"
              variant="primary"
              onPress={() => void submit()}
              disabled={!canSubmit}
              loading={connection.state === 'connecting' || connection.state === 'authenticating'}
              style={{ flex: 1 }}
            />
          </View>

          {probe ? <Body muted>{probe}</Body> : null}
          {connection.state === 'error' && connection.error ? (
            <ErrorBanner message={connection.error} />
          ) : null}
        </Card>

        {connection.session ? (
          <Card>
            <SectionTitle>Verbunden</SectionTitle>
            <KeyValue label="Benutzer" value={connection.session.user} />
            <KeyValue label="Host" value={connection.session.host} />
            <KeyValue label="Agent" value={`v${connection.session.agentVersion}`} />
            <KeyValue
              label="Funktionen"
              value={connection.session.capabilities.join(', ')}
            />
            {connection.session.auth?.kind === 'issued' ? (
              <>
                <KeyValue
                  label="Zugang"
                  value={`gekoppelt, gültig bis ${formatExpiry(connection.session.auth.expiresAt)}`}
                />
                <Body muted style={{ fontSize: 12 }}>
                  Danach trennt der Agent die Verbindung. Einen neuen Code gibt es in der Handy-App
                  unter „Gerät koppeln".
                </Body>
              </>
            ) : null}
            <Button label="Zugangsdaten löschen" variant="danger" onPress={() => void forget()} />
          </Card>
        ) : null}

        {connection.state === 'ready' && Platform.OS !== 'web' ? (
          <Card>
            <SectionTitle>Gerät koppeln</SectionTitle>
            <Body muted>
              Einen Code erzeugen, mit dem sich ein Browser anmeldet — ohne dein eigenes Token
              weiterzugeben. Der Zugang läuft ab und lässt sich zurücknehmen.
            </Body>
            <Link href="/pair" asChild>
              <Button label="Code anzeigen" onPress={() => {}} />
            </Link>
          </Card>
        ) : null}

        <Card>
          <SectionTitle>Wo finde ich das?</SectionTitle>
          <Body muted>
            Die Anleitung führt durch die Einrichtung des Agenten und zeigt, wo Adresse und Token
            herkommen.
          </Body>
          <Button label="Anleitung öffnen" onPress={() => setGuide(true)} />
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function formatExpiry(value: number | null): string {
  if (value === null) return 'unbegrenzt';
  const date = new Date(value);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${date.toLocaleDateString()} ${time}`;
}
