/**
 * Deploy wizard: the app's answer to "create a server".
 *
 * The whole point is the ordering. Writing an ini, rereading it, starting the
 * process and wiring up whatever should reach it from outside is five or six
 * commands that only work in one sequence, and a wrong sequence leaves a
 * backend pointing at nothing. So this screen owns the sequence and reports
 * each step, and the last step checks that the result is actually reachable.
 *
 * Orchestration lives here rather than in one fat agent method on purpose:
 * every step is an existing, individually audited protocol call, so a run that
 * fails halfway can be inspected and resumed instead of rolled back blindly.
 */

import { useState } from 'react';
import { View } from 'react-native';
import { Link } from 'expo-router';
import {
  buildServiceIni,
  DEFAULT_STARTSECS,
  isValidPort,
  isValidServiceName,
  isValidWebPath,
  ServiceSpecError,
  type BackendInfo,
  type PortInfo,
  type ServiceInfo,
  type ServiceSpec,
} from '@uberapp/protocol';

import { client } from '../src/api/client';
import { describeError, useConnection } from '../src/api/hooks';
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
  Toggle,
  spacing,
} from '../src/ui/components';
import { ScreenScroll } from '../src/ui/Screen';
import { useTheme, type Theme } from '../src/ui/theme';

/**
 * How the service should be reachable. The distinction matters and is easy to
 * get wrong: a web backend needs no firewall port at all, and a firewall port
 * does nothing for an HTTP app.
 */
type Exposure = 'internal' | 'web' | 'firewall';

const EXPOSURE_OPTIONS: ReadonlyArray<{ value: Exposure; label: string; hint: string }> = [
  {
    value: 'web',
    label: 'Über eine URL',
    hint: 'Ein Web-Backend leitet Anfragen an deinen Port weiter. Kein Firewall-Port nötig.',
  },
  {
    value: 'firewall',
    label: 'Direkt per TCP oder UDP',
    hint: 'Für Dienste ohne HTTP, etwa XMPP oder mosh. Der Port wird zugeteilt.',
  },
  {
    value: 'internal',
    label: 'Nur intern',
    hint: 'Hintergrundprozesse wie Worker oder Cron-Ersatz, die von außen nichts annehmen.',
  },
];

const TEMPLATES = [
  { value: 'node', label: 'Node.js', command: 'node /home/{user}/app/index.js' },
  { value: 'python', label: 'Python', command: 'python3 /home/{user}/app/main.py' },
  { value: 'custom', label: 'Eigener Befehl', command: '' },
] as const;

type TemplateId = (typeof TEMPLATES)[number]['value'];

type StepId = 'port' | 'config' | 'reload' | 'start' | 'backend' | 'verify';
type StepState = 'pending' | 'running' | 'ok' | 'failed';

interface Step {
  id: StepId;
  title: string;
  detail: string;
  state: StepState;
  note?: string;
}

export default function DeployScreen() {
  const connection = useConnection();
  const user = connection.session?.user ?? 'isabell';

  const [name, setName] = useState('');
  const [template, setTemplate] = useState<TemplateId>('node');
  const [command, setCommand] = useState(TEMPLATES[0].command.replace('{user}', user));
  const [directory, setDirectory] = useState('');
  const [exposure, setExposure] = useState<Exposure>('web');
  const [webPort, setWebPort] = useState('8080');
  const [webPath, setWebPath] = useState('/');
  const [removePrefix, setRemovePrefix] = useState(false);
  const [autostart, setAutostart] = useState(true);
  const [autorestart, setAutorestart] = useState(true);
  const [startsecs, setStartsecs] = useState(String(DEFAULT_STARTSECS));

  const [steps, setSteps] = useState<Step[] | null>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const chooseTemplate = (id: TemplateId) => {
    setTemplate(id);
    const chosen = TEMPLATES.find((entry) => entry.value === id);
    if (chosen && chosen.command) setCommand(chosen.command.replace('{user}', user));
  };

  const spec: ServiceSpec = {
    name,
    // {PORT} is filled in once the port is known, so the preview shows the
    // placeholder and the written file shows the number.
    command: command.trim(),
    directory: directory.trim() || undefined,
    autostart,
    autorestart,
    startsecs: Number(startsecs),
  };

  const problem = validate(spec, exposure, webPath, webPort);
  const preview = problem === null ? safeBuild(spec) : null;

  const runDeploy = async () => {
    setRunning(true);
    setFailure(null);
    setDone(false);

    let current = plan(name, exposure, webPath, webPort);
    setSteps(current);

    const mark = (id: StepId, patch: Partial<Step>) => {
      current = current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
      setSteps(current);
    };

    const step = async <T,>(
      id: StepId,
      fn: () => Promise<T>,
      note: (result: T) => string | undefined,
    ): Promise<T> => {
      mark(id, { state: 'running' });
      try {
        const result = await fn();
        mark(id, { state: 'ok', note: note(result) });
        return result;
      } catch (err) {
        mark(id, { state: 'failed', note: describeError(err) });
        throw err;
      }
    };

    try {
      let port: number | null = exposure === 'web' ? Number(webPort) : null;

      if (exposure === 'firewall') {
        port = await step(
          'port',
          () => client.call<{ port: number | null; output: string }>('ports.add'),
          (result) => (result.port ? `Port ${result.port}` : result.output),
        ).then((result) => result.port);
      }

      const content = buildServiceIni({
        ...spec,
        command: port === null ? spec.command : spec.command.replaceAll('{PORT}', String(port)),
        // Recorded so deleting this service can find its route again. The
        // command only carries the port when it uses {PORT}, and most do not.
        port,
      });

      await step(
        'config',
        () => client.call('services.writeConfig', { name, content, mustNotExist: true }),
        () => `${content.split('\n').length - 1} Zeilen geschrieben`,
      );

      await step('reload', () => client.call('services.reload'), () => 'reread + update');

      await step(
        'start',
        () => client.call('services.control', { name, action: 'start' }),
        () => undefined,
      );

      if (exposure === 'web' && port !== null) {
        await step(
          'backend',
          () => client.call('web.backends.set', { path: webPath, port, removePrefix }),
          () => `${webPath} → http:${port}`,
        );
      }

      await step('verify', () => verify(name, exposure, webPath, port), (note) => note);
      setDone(true);
    } catch {
      setFailure('Der Ablauf wurde abgebrochen. Die Schritte oben zeigen, wo es hing.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <ScreenScroll>
      <View style={{ gap: spacing.xs }}>
        <Body muted>
          Konfiguration schreiben, einlesen, starten und erreichbar machen — in einem Durchgang.
        </Body>
      </View>

      <Card>
        <SectionTitle>Dienst</SectionTitle>
        <Field
          label="Name"
          value={name}
          onChangeText={setName}
          placeholder="my-daemon"
          hint="Wird zum Dateinamen ~/etc/services.d/<name>.ini und zum Namen in supervisorctl."
        />
        <ChoiceGroup
          options={TEMPLATES.map((entry) => ({ value: entry.value, label: entry.label }))}
          value={template}
          onChange={chooseTemplate}
        />
        <Field
          label="Befehl"
          value={command}
          onChangeText={setCommand}
          placeholder="/home/isabell/bin/my-daemon"
          monospace
          hint="supervisord übernimmt deinen Login-PATH nicht — trage den absoluten Pfad ein. {PORT} wird durch den Port ersetzt."
        />
        <Field
          label="Arbeitsverzeichnis (optional)"
          value={directory}
          onChangeText={setDirectory}
          placeholder={`/home/${user}/app`}
          monospace
        />
      </Card>

      <Card>
        <SectionTitle>Erreichbarkeit</SectionTitle>
        <ChoiceGroup options={EXPOSURE_OPTIONS} value={exposure} onChange={setExposure} />

        {exposure === 'web' ? (
          <>
            <Field
              label="Port"
              value={webPort}
              onChangeText={setWebPort}
              keyboardType="numeric"
              hint="Frei wählbar zwischen 1024 und 65535. Dein Dienst muss auf :: oder 0.0.0.0 lauschen."
            />
            <Field
              label="Pfad"
              value={webPath}
              onChangeText={setWebPath}
              placeholder="/"
              monospace
              hint="/ nimmt die ganze Domain, /api nur diesen Unterpfad."
            />
            <Toggle
              label="Pfad-Präfix entfernen"
              value={removePrefix}
              onValueChange={setRemovePrefix}
              hint="Der Dienst sieht / statt /api. Nur sinnvoll, wenn er den Pfad nicht selbst erwartet."
            />
          </>
        ) : null}

        {exposure === 'firewall' ? (
          <InfoBanner message="Der Port wird von Uberspace zugeteilt und ist erst nach ein paar Minuten offen. Verwende {PORT} im Befehl, damit dein Dienst ihn übernimmt." />
        ) : null}
      </Card>

      <Card>
        <SectionTitle>Verhalten</SectionTitle>
        <Toggle
          label="Automatisch starten"
          value={autostart}
          onValueChange={setAutostart}
          hint="Startet mit supervisord, also auch nach einem Neustart des Hosts."
        />
        <Toggle
          label="Nach Absturz neu starten"
          value={autorestart}
          onValueChange={setAutorestart}
        />
        <Field
          label="Startzeit in Sekunden"
          value={startsecs}
          onChangeText={setStartsecs}
          keyboardType="numeric"
          hint="So lange muss der Prozess durchhalten, bevor supervisord ihn als gestartet zählt. Zu kurz, und ein langsamer Start gilt als Fehler."
        />
      </Card>

      {preview ? (
        <Card>
          <SectionTitle>Das wird geschrieben</SectionTitle>
          <Mono style={{ fontSize: 12 }}>~/etc/services.d/{name}.ini</Mono>
          <OutputBlock text={preview} />
        </Card>
      ) : null}

      {problem ? <InfoBanner message={problem} /> : null}
      {failure ? <ErrorBanner message={failure} /> : null}

      {steps ? (
        <Card>
          <SectionTitle>Ablauf</SectionTitle>
          {steps.map((entry) => (
            <StepRow key={entry.id} step={entry} />
          ))}
        </Card>
      ) : null}

      {done ? (
        <Card>
          <SectionTitle>Fertig</SectionTitle>
          <Body>„{name}" läuft. Logs und Konfiguration findest du auf der Service-Seite.</Body>
          <Link href={{ pathname: '/service/[name]', params: { name } }} asChild>
            <Button label="Zum Dienst" variant="primary" onPress={() => {}} />
          </Link>
          {exposure === 'firewall' ? (
            <Link href="/ports" asChild>
              <Button label="Ports ansehen" onPress={() => {}} />
            </Link>
          ) : null}
        </Card>
      ) : (
        <Button
          label="Anlegen und starten"
          variant="primary"
          onPress={() => setConfirmOpen(true)}
          disabled={problem !== null || running}
          loading={running}
        />
      )}

      <ConfirmDialog
        visible={confirmOpen}
        title="Dienst anlegen"
        message={describePlan(name, exposure, webPath, webPort)}
        confirmLabel="Ausführen"
        onConfirm={() => {
          setConfirmOpen(false);
          void runDeploy();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </ScreenScroll>
  );
}

function StepRow({ step }: { step: Step }) {
  const theme = useTheme();
  const visual = stepVisual(step.state, theme);

  return (
    <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
      <View style={{ paddingTop: 2 }}>
        <Badge label={visual.label} color={visual.color} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Body style={{ fontWeight: '600' }}>{step.title}</Body>
        <Mono style={{ color: theme.textFaint, fontSize: 11 }}>{step.detail}</Mono>
        {step.note ? (
          <Body muted style={{ fontSize: 12, color: visual.color }}>
            {step.note}
          </Body>
        ) : null}
      </View>
    </View>
  );
}

function stepVisual(state: StepState, theme: Theme): { label: string; color: string } {
  switch (state) {
    case 'running':
      return { label: 'läuft', color: theme.warning };
    case 'ok':
      return { label: 'ok', color: theme.success };
    case 'failed':
      return { label: 'Fehler', color: theme.danger };
    default:
      return { label: 'offen', color: theme.textFaint };
  }
}

function plan(name: string, exposure: Exposure, path: string, port: string): Step[] {
  const steps: Step[] = [];

  if (exposure === 'firewall') {
    steps.push({
      id: 'port',
      title: 'Port freigeben',
      detail: 'uberspace port add',
      state: 'pending',
    });
  }

  steps.push(
    {
      id: 'config',
      title: 'Konfiguration schreiben',
      detail: `~/etc/services.d/${name}.ini`,
      state: 'pending',
    },
    {
      id: 'reload',
      title: 'supervisord neu einlesen',
      detail: 'supervisorctl reread + update',
      state: 'pending',
    },
    {
      id: 'start',
      title: 'Dienst starten',
      detail: `supervisorctl start ${name}`,
      state: 'pending',
    },
  );

  if (exposure === 'web') {
    steps.push({
      id: 'backend',
      title: 'Web-Backend setzen',
      detail: `uberspace web backend set ${path} --http --port ${port}`,
      state: 'pending',
    });
  }

  steps.push({
    id: 'verify',
    title: 'Ergebnis prüfen',
    detail: 'Status und Erreichbarkeit',
    state: 'pending',
  });

  return steps;
}

function describePlan(name: string, exposure: Exposure, path: string, port: string): string {
  const count = plan(name, exposure, path, port).length;
  const tail =
    exposure === 'web'
      ? ` Danach nimmt ${path} Anfragen auf Port ${port} an.`
      : exposure === 'firewall'
        ? ' Der Port wird zugeteilt und ist nach ein paar Minuten offen.'
        : '';
  return `${count} Schritte werden ausgeführt und einzeln gemeldet.${tail}`;
}

/**
 * The step that makes the wizard worth having: after everything ran, ask the
 * host whether the result is actually in the state we intended.
 */
async function verify(
  name: string,
  exposure: Exposure,
  path: string,
  port: number | null,
): Promise<string> {
  const notes: string[] = [];

  const services = await client.call<ServiceInfo[]>('services.list');
  const service = services.find((entry) => entry.name === name);
  notes.push(service ? `Dienst ${service.state}` : 'Dienst nicht in der Liste');

  if (exposure === 'web' && port !== null) {
    const backends = await client.call<BackendInfo[]>('web.backends.list');
    const backend = backends.find((entry) => entry.port === port && entry.path === path);
    notes.push(backend ? `Backend ${backend.status}` : 'Backend nicht gefunden');
  }

  if (exposure === 'firewall' && port !== null) {
    const ports = await client.call<PortInfo[]>('ports.list');
    const entry = ports.find((candidate) => candidate.port === port);
    notes.push(
      entry?.reachable
        ? 'Port erreichbar'
        : 'Port noch nicht erreichbar — die Freigabe braucht ein paar Minuten',
    );
  }

  return notes.join(' · ');
}

function validate(
  spec: ServiceSpec,
  exposure: Exposure,
  path: string,
  port: string,
): string | null {
  if (!spec.name) return 'Trage einen Namen für den Dienst ein.';
  if (!isValidServiceName(spec.name)) {
    return 'Der Name darf nur Buchstaben, Ziffern sowie . - und _ enthalten.';
  }
  if (!spec.command) return 'Trage den Befehl ein, den supervisord starten soll.';

  if (exposure === 'web') {
    if (!isValidWebPath(path)) {
      return 'Der Pfad muss mit / beginnen, ohne ".." und ohne Leerzeichen.';
    }
    if (!isValidPort(Number(port))) {
      return 'Der Port muss eine Zahl zwischen 1024 und 65535 sein.';
    }
  }

  try {
    buildServiceIni(spec);
  } catch (err) {
    return err instanceof ServiceSpecError ? err.message : describeError(err);
  }
  return null;
}

function safeBuild(spec: ServiceSpec): string | null {
  try {
    return buildServiceIni(spec);
  } catch {
    return null;
  }
}
