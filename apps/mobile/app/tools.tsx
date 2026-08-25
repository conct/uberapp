/**
 * Tool versions: which php, node or python this account runs, and switching it.
 *
 * The agent has carried `system.toolVersions`, `system.setToolVersion` and
 * `tools.restart` since the first commit, and until now nothing called them —
 * so the only parser in the project that was never checked against real CLI
 * output had no way of being checked at all. This screen is that way.
 *
 * It asks tool by tool rather than all at once, and that is not a preference.
 * Fourteen tools times two subcommands is twenty-eight `uberspace` processes;
 * started together they time out, and started three at a time they still take
 * longer than the sixty seconds a call is given. One tool per call fits.
 *
 * It is slow either way — measured against a real host on 2026-08-25, roughly
 * forty seconds per tool, so eight minutes for all fourteen. That is why every
 * tool has a card from the first frame rather than appearing when it answers:
 * a screen that shows nothing for a minute is how a hung screen looks, and the
 * difference has to be visible without waiting to find out.
 *
 * On the empty case, because it is the whole reason this is worth building: a
 * tool that answers nothing and a host that never answered produce the same
 * empty list, and only one of them is a statement about the platform. So the
 * two are counted separately and said apart.
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { KNOWN_TOOLS, type ToolVersion } from '@uberctrl/protocol';

import { client } from '../src/api/client';
import { useConnection, useMutation } from '../src/api/hooks';
import {
  Badge,
  Body,
  Button,
  Card,
  ChoiceGroup,
  EmptyState,
  ErrorBanner,
  Mono,
  OutputBlock,
  SectionTitle,
  spacing,
} from '../src/ui/components';
import { ScreenScroll } from '../src/ui/Screen';
import { useTheme } from '../src/ui/theme';

/**
 * What is known about one tool at this moment.
 *
 * 'queued' and 'asking' both mean "no answer yet" and are kept apart on
 * purpose: at roughly forty seconds a tool, a screen that only says "loading"
 * for eight minutes is indistinguishable from one that has hung. Naming the
 * tool currently being asked turns the wait into progress you can watch.
 */
type ToolState =
  | { state: 'queued' }
  | { state: 'asking' }
  | { state: 'found'; version: ToolVersion }
  | { state: 'absent' }
  | { state: 'failed' };

type Probe = Record<string, ToolState>;

const QUEUED: Probe = Object.fromEntries(
  KNOWN_TOOLS.map((tool) => [tool, { state: 'queued' } as ToolState]),
);

/** Walk the known tools one call at a time, publishing answers as they land. */
function useToolProbe() {
  const connection = useConnection();
  const ready = connection.state === 'ready';
  const [probe, setProbe] = useState<Probe>(QUEUED);
  const [running, setRunning] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!ready) return;

    let cancelled = false;
    setProbe(QUEUED);
    setRunning(true);

    const mark = (tool: string, state: ToolState) =>
      setProbe((current) => ({ ...current, [tool]: state }));

    void (async () => {
      for (const tool of KNOWN_TOOLS) {
        if (cancelled) return;
        mark(tool, { state: 'asking' });
        try {
          const result = await client.call<ToolVersion[]>('system.toolVersions', { tool });
          if (cancelled) return;
          // An empty array is the agent saying this host does not offer the
          // tool — which is an answer, not a failure.
          mark(tool, result[0] ? { state: 'found', version: result[0] } : { state: 'absent' });
        } catch {
          if (cancelled) return;
          // One tool that will not answer says nothing about the next.
          mark(tool, { state: 'failed' });
        }
      }
      if (!cancelled) setRunning(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, attempt]);

  const states = KNOWN_TOOLS.map((tool) => probe[tool] ?? { state: 'queued' });
  const count = (state: ToolState['state']) => states.filter((s) => s.state === state).length;

  return {
    probe,
    running,
    total: KNOWN_TOOLS.length,
    pending: count('queued') + count('asking'),
    found: count('found'),
    failed: count('failed'),
    absentTools: KNOWN_TOOLS.filter((tool) => probe[tool]?.state === 'absent'),
    retry: () => setAttempt((value) => value + 1),
  };
}

export default function ToolsScreen() {
  const theme = useTheme();
  const probe = useToolProbe();

  const everythingFailed = !probe.running && probe.failed === probe.total;
  const answered = probe.total - probe.pending;

  return (
    <ScreenScroll>
      <View style={{ gap: spacing.xs }}>
        <Body muted>Sprachfassungen dieses Kontos</Body>
        <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
          {probe.running
            ? `Geprüft: ${answered} von ${probe.total}. Jedes Werkzeug ist ein eigener Aufruf auf dem Host und dauert bis zu einer Minute.`
            : `${probe.found} von ${probe.total} Werkzeugen sind auf diesem Host umschaltbar.`}
        </Body>
      </View>

      {everythingFailed ? (
        <ErrorBanner
          message="Kein einziges Werkzeug hat geantwortet — der Host ist zu langsam, oder die uberspace-CLI fehlt."
          onRetry={probe.retry}
        />
      ) : null}

      {/*
        Every tool gets a card from the first frame, in the order they are
        asked. Before this the screen showed nothing at all until the first
        answer came back, which on this host is most of a minute — and an
        empty screen is how a hang looks.

        A tool the host does not offer keeps its place until the sweep ends,
        rather than vanishing the moment its answer lands. Removing rows from
        the middle of a list somebody is reading pulls everything below them
        upwards, and there are fourteen chances for that to happen. Once it is
        over they collapse into one line at the bottom, where they cost a
        sentence instead of a screen.
      */}
      {KNOWN_TOOLS.map((tool) => {
        const entry = probe.probe[tool] ?? { state: 'queued' as const };

        if (entry.state === 'found') return <ToolCard key={tool} tool={entry.version} />;
        if (entry.state === 'absent') {
          return probe.running ? <WaitingCard key={tool} tool={tool} state="absent" /> : null;
        }
        if (entry.state === 'failed') {
          return everythingFailed ? null : <WaitingCard key={tool} tool={tool} state="failed" />;
        }
        return <WaitingCard key={tool} tool={tool} state={entry.state} />;
      })}

      {!probe.running && probe.absentTools.length > 0 ? (
        <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
          Auf diesem Host nicht vorhanden: {probe.absentTools.join(', ')}.
        </Body>
      ) : null}

      {!probe.running && !everythingFailed && probe.found === 0 ? (
        <Card>
          <EmptyState
            title="Keine umschaltbaren Werkzeuge"
            hint={
              probe.failed > 0
                ? `${probe.total - probe.failed} von ${probe.total} Werkzeugen haben geantwortet, keines davon meldet eine Fassung. Die übrigen blieben stumm.`
                : `Alle ${probe.total} Werkzeuge wurden gefragt. Keines davon lässt sich hier umschalten — das ist eine Aussage über diesen Host, nicht über uberCTRL.`
            }
          />
        </Card>
      ) : null}
    </ScreenScroll>
  );
}

/** A tool with nothing to configure — waiting, being asked, absent, or mute. */
function WaitingCard({
  tool,
  state,
}: {
  tool: string;
  state: 'queued' | 'asking' | 'absent' | 'failed';
}) {
  const theme = useTheme();

  const label = {
    queued: 'wartet',
    asking: 'wird gefragt',
    absent: 'nicht vorhanden',
    failed: 'ohne Antwort',
  }[state];
  const color =
    state === 'asking' ? theme.accent : state === 'failed' ? theme.warning : theme.textFaint;

  return (
    <Card style={{ opacity: state === 'asking' ? 1 : 0.6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <SectionTitle>{tool}</SectionTitle>
        <Badge label={label} color={color} />
        {/* The Loading component carries its own generous padding, which in a
            single row reads as a gap rather than a spinner. */}
        {state === 'asking' ? <ActivityIndicator color={theme.accent} size="small" /> : null}
      </View>
    </Card>
  );
}

function ToolCard({ tool }: { tool: ToolVersion }) {
  const theme = useTheme();
  const [chosen, setChosen] = useState<string | null>(null);
  const [current, setCurrent] = useState(tool.current);

  const set = useMutation<{ tool: string; version: string }>('system.setToolVersion', {
    onSuccess: () => setCurrent(chosen),
  });
  const restart = useMutation<{ tool: string }>('tools.restart');

  /*
   * The version in use is not always one you may still pick. This account runs
   * PostgreSQL 13 while uberspace offers only 14 and 15 — so the list arrived
   * with nothing selected in it, which reads as a bug in the app rather than
   * as the fact it is. It also has a consequence worth saying out loud: a
   * switch away from a version that is no longer offered cannot be switched
   * back here.
   */
  const retired = current !== null && tool.available.length > 0 && !tool.available.includes(current);

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <SectionTitle>{tool.tool}</SectionTitle>
        <Badge
          label={current ?? 'unbekannt'}
          color={current && !retired ? theme.success : theme.warning}
        />
      </View>

      {retired ? (
        <Body muted style={{ fontSize: 13 }}>
          Läuft auf <Mono>{current}</Mono>, und diese Fassung steht nicht mehr zur Auswahl. Ein
          Wechsel lässt sich hier nicht zurücknehmen — <Mono>{current}</Mono> wäre danach nicht mehr
          wählbar.
        </Body>
      ) : null}

      {set.error ? <ErrorBanner message={set.error} /> : null}
      {set.output ? <OutputBlock text={set.output} /> : null}
      {restart.error ? <ErrorBanner message={restart.error} /> : null}
      {restart.output ? <OutputBlock text={restart.output} /> : null}

      {tool.available.length > 0 ? (
        <>
          <ChoiceGroup
            options={tool.available.map((version) => ({ value: version, label: version }))}
            value={chosen ?? current ?? ''}
            onChange={setChosen}
          />
          <Button
            label="Fassung übernehmen"
            variant="primary"
            loading={set.pending}
            disabled={!chosen || chosen === current || set.pending}
            onPress={() => {
              if (!chosen) return;
              void set.run({ tool: tool.tool, version: chosen }).catch(() => {});
            }}
          />
        </>
      ) : (
        /*
         * A tool the CLI answered for, but with no list of versions. Saying
         * "none available" would be a claim about the platform; this is only a
         * claim about what came back.
         */
        <Body muted style={{ fontSize: 13 }}>
          Für <Mono>{tool.tool}</Mono> nennt uberspace keine wählbaren Fassungen.
        </Body>
      )}

      <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
        Nach einem Wechsel läuft der alte Prozess weiter, bis er neu gestartet wird.
      </Body>
      <Button
        label="Neu starten"
        loading={restart.pending}
        disabled={restart.pending}
        onPress={() => void restart.run({ tool: tool.tool }).catch(() => {})}
      />
    </Card>
  );
}
