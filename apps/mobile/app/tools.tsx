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
 * longer than the sixty seconds a call is given. One tool per call fits, and
 * has the better manner besides: the first answer appears in a second or two
 * instead of everything arriving at once or not at all.
 *
 * On the empty case, because it is the whole reason this is worth building: a
 * tool that answers nothing and a host that never answered produce the same
 * empty list, and only one of them is a statement about the platform. So the
 * two are counted separately and said apart.
 */

import { useEffect, useState } from 'react';
import { View } from 'react-native';
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
  Loading,
  Mono,
  OutputBlock,
  SectionTitle,
  spacing,
} from '../src/ui/components';
import { ScreenScroll } from '../src/ui/Screen';
import { useTheme } from '../src/ui/theme';

interface Probe {
  found: ToolVersion[];
  failed: string[];
  done: number;
  running: boolean;
}

const EMPTY: Probe = { found: [], failed: [], done: 0, running: false };

/** Walk the known tools one call at a time, publishing answers as they land. */
function useToolProbe(): Probe & { total: number; retry: () => void } {
  const connection = useConnection();
  const ready = connection.state === 'ready';
  const [probe, setProbe] = useState<Probe>(EMPTY);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!ready) return;

    let cancelled = false;
    setProbe({ ...EMPTY, running: true });

    void (async () => {
      for (const tool of KNOWN_TOOLS) {
        if (cancelled) return;
        try {
          const result = await client.call<ToolVersion[]>('system.toolVersions', { tool });
          if (cancelled) return;
          setProbe((current) => ({
            ...current,
            found: [...current.found, ...result],
            done: current.done + 1,
          }));
        } catch {
          if (cancelled) return;
          // One tool that will not answer says nothing about the next.
          setProbe((current) => ({
            ...current,
            failed: [...current.failed, tool],
            done: current.done + 1,
          }));
        }
      }
      if (!cancelled) setProbe((current) => ({ ...current, running: false }));
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, attempt]);

  return {
    ...probe,
    total: KNOWN_TOOLS.length,
    retry: () => setAttempt((value) => value + 1),
  };
}

export default function ToolsScreen() {
  const theme = useTheme();
  const probe = useToolProbe();

  const everythingFailed = !probe.running && probe.failed.length === probe.total;

  return (
    <ScreenScroll>
      <View style={{ gap: spacing.xs }}>
        <Body muted>Sprachfassungen dieses Kontos</Body>
        {probe.running ? (
          <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
            Geprüft: {probe.done} von {probe.total}. Jedes Werkzeug ist ein eigener Aufruf auf dem
            Host.
          </Body>
        ) : null}
      </View>

      {probe.found.map((tool) => (
        <ToolCard key={tool.tool} tool={tool} />
      ))}

      {probe.running && probe.found.length === 0 ? (
        <Card>
          <Loading label="Wird abgefragt…" />
        </Card>
      ) : null}

      {everythingFailed ? (
        <ErrorBanner
          message="Kein einziges Werkzeug hat geantwortet — der Host ist zu langsam, oder die uberspace-CLI fehlt."
          onRetry={probe.retry}
        />
      ) : null}

      {!probe.running && !everythingFailed && probe.found.length === 0 ? (
        <Card>
          <EmptyState
            title="Keine umschaltbaren Werkzeuge"
            hint={`${probe.total - probe.failed.length} Werkzeuge wurden gefragt, keines meldet eine Fassung.`}
          />
        </Card>
      ) : null}

      {!probe.running && probe.failed.length > 0 && !everythingFailed ? (
        <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
          Ohne Antwort geblieben: {probe.failed.join(', ')}.
        </Body>
      ) : null}
    </ScreenScroll>
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

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <SectionTitle>{tool.tool}</SectionTitle>
        <Badge label={current ?? 'unbekannt'} color={current ? theme.success : theme.warning} />
      </View>

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
