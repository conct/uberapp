/**
 * Connection setup: where the agent lives and which token opens it.
 */

import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';

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

  /**
   * Which way in, asked once rather than shown as two half-filled forms.
   *
   * Somebody arriving here for the first time has no address and no token and
   * cannot tell from a form which of the two fields they are supposed to be
   * able to fill. So the screen asks, and only then shows what that answer
   * needs. Anyone who already has an account is past the question — they came
   * to edit or to add, and the form is what they want.
   */
  const [chosen, setChosen] = useState<'ssh' | 'manual' | null>(null);
  const [hasAccount, setHasAccount] = useState<boolean | null>(null);
  // Asked on a device that knows no Uberspace yet - and again when this
  // screen is opened to add another one. Leaving the second case out sent
  // anyone adding an Uberspace straight into the manual form, with no route
  // to the SSH setup at all: the automatic path existed but was unreachable
  // for every account after the first.
  const asking = (hasAccount === false || addingNew) && chosen === null;


  useEffect(() => {
    void loadCredentials().then((credentials) => {
      setHasAccount(credentials !== null);
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
          <Title>{addingNew ? 'Weiteren Uberspace hinzufügen' : 'Mit dem Uberspace verbinden'}</Title>
          <Body muted>
            {addingNew
              ? 'Der bestehende Zugang bleibt unberührt — dieser kommt daneben und lässt sich später umschalten.'
              : 'Die App spricht mit dem Agenten, der auf deinem Uberspace läuft — nicht direkt per SSH.'}
          </Body>
        </View>

        {/*
          Asked once, on a device that knows no Uberspace yet. Two forms side by
          side put the burden of choosing on someone who has no way to tell
          which fields they could even fill: the address and token only exist
          after the agent is installed, so offering them first asks for
          something that cannot be had yet.
        */}
        {asking ? (
          <>
            <Card>
              <SectionTitle>Einfach einrichten</SectionTitle>
              <Body muted>
                Du gibst deine Uberspace-Zugangsdaten ein, die App installiert den Agenten selbst
                und trägt Adresse und Token danach von allein ein. Danach läuft alles über den
                Agenten, dein SSH-Passwort wird verworfen. {sshHint()}
              </Body>
              <Link href="/setup-ssh" asChild>
                <Button label="Einfach einrichten" variant="primary" onPress={() => {}} />
              </Link>
            </Card>

            <Card>
              <SectionTitle>Manuell</SectionTitle>
              <Body muted>
                Für alle, die den Agenten selbst installiert haben oder es lieber von Hand tun.
                Adresse und Token trägst du dann selbst ein.
              </Body>
              <Button label="Manuell einrichten" onPress={() => setChosen('manual')} />
            </Card>
          </>
        ) : null}

        {asking ? null : (
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
        )}

        {/*
          Both cards below describe the connection that already exists. While
          this screen is adding a *different* Uberspace they are worse than
          noise: they show the running host's user, address and version as if
          they belonged to the account being created, and "Zugangsdaten
          löschen" acts on the active account, not the new one.
        */}
        {connection.session && !addingNew ? (
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

        {connection.state === 'ready' && !addingNew ? (
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
