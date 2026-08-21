/**
 * Connection setup: where the agent lives and which token opens it.
 */

import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';

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
        visible={guide}
        onDismiss={dismissGuide}
        insecureStorage={insecureStorage}
      />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        <View style={{ gap: spacing.sm }}>
          <Title>Mit dem Uberspace verbinden</Title>
          <Body muted>
            Die App spricht mit dem Agenten, der auf deinem Uberspace läuft — nicht direkt per SSH.
          </Body>
        </View>

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
            <Button label="Zugangsdaten löschen" variant="danger" onPress={() => void forget()} />
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
