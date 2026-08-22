/**
 * Connection setup: where the agent lives and which token opens it.
 */

import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';

import { decodePairing } from '@uberapp/protocol';

import { client, httpUrl, normalizeUrl } from '../src/api/client';
import { useConnection } from '../src/api/hooks';
import {
  getActiveId,
  getToken,
  loadCredentials,
  removeAccount,
  saveCredentials,
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
import { BrowserPairing } from '../src/ui/BrowserPairing';
import { sshAvailability } from '../src/api/ssh';
import { QrScanner } from '../src/ui/QrScanner';
import { useTheme } from '../src/ui/theme';

export default function ConnectScreen() {
  const theme = useTheme();
  const router = useRouter();
  const connection = useConnection();

  /** Set by the account list, which opens this screen to add a second host. */
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const addingNew = mode === 'new';

  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [probe, setProbe] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [touched, setTouched] = useState(false);

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

  useEffect(() => {
    void loadCredentials().then((credentials) => {
      // Pre-fill only when this screen is editing the connection that already
      // exists. Reached as "add another Uberspace", the same fields would hold
      // the *other* account's address, and saving would overwrite it rather
      // than add a second one — the form would be lying about what it does.
      if (credentials && !addingNew) {
        setUrl(credentials.url);
        setToken(credentials.token);
      }
    });
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
    // Leaving the screen is left to the effect above, which waits for the
    // agent to actually accept us. Navigating here instead would hide a bad
    // token behind a tab screen that just says "not connected".
  };

  /**
   * Forget the account this screen is currently pointed at — not every one.
   *
   * There can be several now, and "Zugangsdaten löschen" reads as being about
   * the connection in front of you. Wiping all of them from here would be a
   * surprise with no undo, since the tokens cannot be recovered from the
   * device. The account list is where several are managed.
   */
  const forget = async () => {
    const active = await getActiveId();
    const fallback = active ? await removeAccount(active) : null;

    setUrl('');
    setToken('');
    setTouched(false);
    setProbe(null);

    if (!fallback) {
      client.disconnect();
      return;
    }

    const fallbackToken = await getToken(fallback.id);
    if (fallbackToken) client.connect(fallback.url, fallbackToken);
    else client.disconnect();
  };

  /**
   * The browser gets one way in, and it is the code.
   *
   * Everything else this screen offers is either impossible there or beside
   * the point: the SSH setup needs raw TCP, and typing an address and a token
   * by hand is the thing the handoff exists to replace. Leaving them on screen
   * would present three doors where two are painted on.
   */
  if (Platform.OS === 'web') {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: 'center',
            padding: spacing.lg,
            gap: spacing.lg,
            maxWidth: 520,
            width: '100%',
            alignSelf: 'center',
          }}
        >
          <BrowserPairing
            onPaired={(handoff) => {
              setUrl(handoff.url);
              setToken(handoff.token);
              setTouched(true);
              void saveCredentials({ url: handoff.url, token: handoff.token }).then(() =>
                client.connect(handoff.url, handoff.token),
              );
            }}
          />
          {connection.state === 'error' && connection.error ? (
            <ErrorBanner message={connection.error} />
          ) : null}
        </ScrollView>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        <View style={{ gap: spacing.sm }}>
          <Title>Mit dem Uberspace verbinden</Title>
          <Body muted>
            Die App spricht mit dem Agenten, der auf deinem Uberspace läuft — nicht direkt per SSH.
          </Body>
        </View>

        {connection.state !== 'ready' ? (
          <Card>
            <SectionTitle>Einfache Einrichtung</SectionTitle>
            <Body muted>
              Du gibst deine Uberspace-Zugangsdaten ein, die App installiert den Agenten selbst und
              trägt Adresse und Token danach von allein ein. {sshHint()}
            </Body>
            <Link href="/setup-ssh" asChild>
              <Button label="Einfach einrichten" variant="primary" onPress={() => {}} />
            </Link>
          </Card>
        ) : null}

        {scanning ? (
          <>
            <QrScanner onResult={onScanned} onCancel={() => setScanning(false)} />
            {/*
              The scanner's only feedback. Without it a camera pointed at the
              wrong thing — or at an expired code — simply does nothing, which
              reads as a broken scanner rather than a rejected code.
            */}
            {scanNote ? <ErrorBanner message={scanNote} /> : null}
          </>
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

        {connection.state === 'ready' ? (
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

      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * One line on whether the simple path can run here, so the card is honest
 * before it is tapped rather than after.
 */
function sshHint(): string {
  const { available, reason } = sshAvailability();
  return available ? '' : `Hier nicht möglich: ${reason}`;
}

function formatExpiry(value: number | null): string {
  if (value === null) return 'unbegrenzt';
  const date = new Date(value);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${date.toLocaleDateString()} ${time}`;
}
