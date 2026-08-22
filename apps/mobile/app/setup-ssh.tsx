/**
 * Simple setup: the app installs the agent itself, over SSH.
 *
 * The user gives their Uberspace login once, the app does on the host what the
 * command-line tool would have done, and comes back with an address and a
 * token already filled in. No terminal, nothing to copy across devices.
 *
 * The SSH credentials are held in component state for the length of one run
 * and never written anywhere. What is worth keeping afterwards is the agent
 * token, and that is a different secret with a much smaller blast radius.
 */

import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { client } from '../src/api/client';
import { saveCredentials } from '../src/api/storage';
import { initialSteps, provision, type ProvisionStep, type StepId } from '../src/api/provision';
import {
  credentialsProblem,
  getSshRunner,
  parseSshTarget,
  sshAvailability,
  type SshCredentials,
} from '../src/api/ssh';
import {
  Badge,
  Body,
  Button,
  Card,
  ChoiceGroup,
  ConfirmDialog,
  ErrorBanner,
  Field,
  InfoBanner,
  Mono,
  OutputBlock,
  SectionTitle,
  spacing,
} from '../src/ui/components';
import { ConnectionStrip } from '../src/ui/Screen';
import { useTheme, type Theme } from '../src/ui/theme';

type AuthMode = 'password' | 'key';

export default function SetupSshScreen() {
  const theme = useTheme();
  const router = useRouter();

  const availability = sshAvailability();

  // Prefilled when this screen is reached from an already-connected account:
  // repeating a setup - to update the agent, say - otherwise means typing the
  // host and the user again, both of which the live session already knows.
  // The password is never among them and never will be.
  const params = useLocalSearchParams<{ host?: string; user?: string }>();
  const [target, setTarget] = useState(params.host ?? '');
  const [user, setUser] = useState(params.user ?? '');
  const [mode, setMode] = useState<AuthMode>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [domain, setDomain] = useState('');

  const [steps, setSteps] = useState<ProvisionStep[] | null>(null);
  const [output, setOutput] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);

  /** Only a failed run has anything worth reading in its output. */
  const failed = steps?.some((step) => step.state === 'failed') ?? false;

  // Accept "stardust", "stardust.uberspace.de" or "isabell@stardust…" and fill
  // the username in from the last of those, since people paste it that way.
  const parsed = parseSshTarget(target);
  const effectiveUser = (user.trim() || parsed.user || '').toLowerCase();

  const credentials: SshCredentials = {
    host: parsed.host,
    user: effectiveUser,
    ...(mode === 'password' ? { password } : { privateKey }),
  };
  const problem = credentialsProblem(credentials);

  const run = async () => {
    const runner = getSshRunner();
    if (!runner) return;

    setRunning(true);
    setError(null);
    setOutput([]);

    let current = initialSteps();
    setSteps(current);
    const mark = (id: StepId, patch: Partial<ProvisionStep>) => {
      current = current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
      setSteps(current);
    };

    try {
      const result = await provision({
        credentials,
        runner,
        domain: domain.trim() || null,
        onStep: mark,
        onOutput: (chunk) => setOutput((previous) => [...previous, chunk].slice(-200)),
      });

      // Only now does anything get stored, and only the agent's own address
      // and token — never what got us onto the host.
      await saveCredentials({ url: result.url, token: result.token });
      client.connect(result.url, result.token);
      router.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  if (!availability.available) {
    return (
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: theme.bg }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ConnectionStrip />
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
          <View style={{ gap: spacing.xs }}>
            <Body muted>Hier nicht verfügbar</Body>
          </View>
          <Card>
            <SectionTitle>Warum nicht</SectionTitle>
            <Body>{availability.reason}</Body>
            {availability.remedy ? <InfoBanner message={availability.remedy} /> : null}
            <Button
              label="Zur fortgeschrittenen Einrichtung"
              onPress={() => router.replace('/connect')}
            />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ConnectionStrip />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        <View style={{ gap: spacing.xs }}>
          <Body muted>
            Die App meldet sich einmal per SSH an und installiert den Agenten selbst.
          </Body>
        </View>

        {/*
        While a run is going, the form has nothing left to say: the values are
        already in flight and changing one would not affect what is happening.
        What matters then is which step is where, so that is all that stays.
        It comes back if a step fails, because then the values are exactly what
        wants correcting.
      */}
        {running ? null : (
          <>
            <Card>
              <SectionTitle>Dein Uberspace</SectionTitle>
              <Field
                label="Host"
                value={target}
                onChangeText={setTarget}
                placeholder="stardust.uberspace.de"
                keyboardType="url"
                hint={
                  parsed.host && parsed.host !== target.trim().toLowerCase()
                    ? `Wird zu ${parsed.host}`
                    : 'Kurzform reicht — .uberspace.de wird ergänzt.'
                }
              />
              <Field
                label="Benutzername"
                value={user || parsed.user || ''}
                onChangeText={setUser}
                placeholder="isabell"
              />

              <SectionTitle>Anmeldung</SectionTitle>
              <ChoiceGroup
                options={[
                  {
                    value: 'password',
                    label: 'Passwort',
                    hint: 'Dein Uberspace-Passwort.',
                  },
                  {
                    value: 'key',
                    label: 'Privater Schlüssel',
                    hint: 'Inhalt einer Schlüsseldatei, falls du dich damit anmeldest.',
                  },
                ]}
                value={mode}
                onChange={setMode}
              />

              {mode === 'password' ? (
                <Field
                  label="Passwort"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  hint="Wird nur für diesen Vorgang benutzt und danach verworfen — nirgends gespeichert."
                />
              ) : (
                <Field
                  label="Privater Schlüssel"
                  value={privateKey}
                  onChangeText={setPrivateKey}
                  multiline
                  monospace
                  hint="Beginnt mit -----BEGIN OPENSSH PRIVATE KEY-----. Wird nicht gespeichert."
                />
              )}

              <Field
                label="Eigene Domain (optional)"
                value={domain}
                onChangeText={setDomain}
                placeholder="uberapp.deine-domain.de"
                keyboardType="url"
                hint="Leer lassen: der Agent landet auf <benutzer>.uber.space/uberapp, das braucht kein DNS."
              />
            </Card>
          </>
        )}

        {problem && !running ? <InfoBanner message={problem} /> : null}
        {error ? <ErrorBanner message={error} /> : null}

        {steps ? (
          <Card>
            <SectionTitle>Ablauf</SectionTitle>
            {steps.map((step) => (
              <StepRow key={step.id} step={step} theme={theme} />
            ))}
            {/*
            The raw session output, kept for the one case that needs it.
            Watching a wall of build log scroll past says nothing a person can
            act on — the step list already says where things are. When a step
            fails, though, this is the only place the reason survives, so it
            appears then and only then.
          */}
            {failed && output.length > 0 ? <OutputBlock text={output.join('')} /> : null}
          </Card>
        ) : null}

        {running ? null : (
          <Button
            label={failed ? 'Erneut versuchen' : 'Einrichten'}
            variant="primary"
            onPress={() => setConfirming(true)}
            disabled={problem !== null}
          />
        )}

        <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
          Dein Uberspace-Passwort verlässt dieses Gerät nur in Richtung deines eigenen Hosts und
          wird nach der Einrichtung verworfen. Gespeichert wird ausschliesslich das Agent-Token.
        </Body>

        <ConfirmDialog
          visible={confirming}
          title="Einrichtung starten"
          message={`Die App meldet sich als ${credentials.user} auf ${credentials.host} an, holt das Projekt, baut den Agenten und macht ihn erreichbar. Das dauert ein bis zwei Minuten.`}
          confirmLabel="Los"
          onConfirm={() => {
            setConfirming(false);
            void run();
          }}
          onCancel={() => setConfirming(false)}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function StepRow({ step, theme }: { step: ProvisionStep; theme: Theme }) {
  const visual =
    step.state === 'running'
      ? { label: 'läuft', color: theme.warning }
      : step.state === 'ok'
        ? { label: 'ok', color: theme.success }
        : step.state === 'failed'
          ? { label: 'Fehler', color: theme.danger }
          : { label: 'offen', color: theme.textFaint };

  return (
    <View
      style={{
        flexDirection: 'row',
        gap: spacing.md,
        alignItems: 'flex-start',
      }}
    >
      <View style={{ paddingTop: 2 }}>
        <Badge label={visual.label} color={visual.color} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Body style={{ fontWeight: '600' }}>{step.title}</Body>
        {step.detail ? (
          <Mono style={{ fontSize: 11, color: visual.color }} numberOfLines={3}>
            {step.detail}
          </Mono>
        ) : null}
      </View>
    </View>
  );
}
