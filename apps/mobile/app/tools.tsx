/**
 * Tool versions: which php, node or python this account runs, and switching it.
 *
 * The agent has carried `system.toolVersions`, `system.setToolVersion` and
 * `tools.restart` since the first commit, and until now nothing called them —
 * so the only parser in the project that was never checked against real CLI
 * output had no way of being checked at all. This screen is that way.
 *
 * A note on the empty case, because it is the whole reason this is worth
 * building: `uberspace tools version show|list` is parsed with a regex, and a
 * tool whose output no longer matches produces an entry with `current: null`
 * and no available versions — not an error. Rendered naively that reads as
 * "this host has no switchable tools", which is indistinguishable from a
 * platform that dropped the feature. So both empty cases say what they are.
 */

import { useState } from 'react';
import { View } from 'react-native';
import type { ToolVersion } from '@uberctrl/protocol';

import { useMutation, useQuery } from '../src/api/hooks';
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

export default function ToolsScreen() {
  const tools = useQuery<ToolVersion[]>('system.toolVersions');

  return (
    <ScreenScroll>
      <View style={{ gap: spacing.xs }}>
        <Body muted>Sprachfassungen dieses Kontos</Body>
      </View>

      {tools.error ? <ErrorBanner message={tools.error} onRetry={tools.refresh} /> : null}

      {tools.loading ? (
        <Card>
          <Loading label="Wird abgefragt…" />
        </Card>
      ) : tools.data && tools.data.length > 0 ? (
        tools.data.map((tool) => <ToolCard key={tool.tool} tool={tool} onChanged={tools.refresh} />)
      ) : tools.data ? (
        <Card>
          <EmptyState
            title="Keine umschaltbaren Werkzeuge"
            hint={
              'Auf diesem Host meldet uberspace für keines der bekannten Werkzeuge eine Fassung. ' +
              'Das ist auch das Bild, das entsteht, wenn sich die Ausgabe der CLI geändert hat — ' +
              'in dem Fall liest der Agent sie nicht mehr, statt zu scheitern.'
            }
          />
        </Card>
      ) : null}
    </ScreenScroll>
  );
}

function ToolCard({ tool, onChanged }: { tool: ToolVersion; onChanged: () => void }) {
  const theme = useTheme();
  const [chosen, setChosen] = useState<string | null>(null);

  const set = useMutation<{ tool: string; version: string }>('system.setToolVersion', {
    onSuccess: onChanged,
  });
  const restart = useMutation<{ tool: string }>('tools.restart');

  const target = chosen ?? tool.current;

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <SectionTitle>{tool.tool}</SectionTitle>
        <Badge
          label={tool.current ?? 'unbekannt'}
          color={tool.current ? theme.success : theme.warning}
        />
      </View>

      {set.error ? <ErrorBanner message={set.error} /> : null}
      {set.output ? <OutputBlock text={set.output} /> : null}
      {restart.error ? <ErrorBanner message={restart.error} /> : null}
      {restart.output ? <OutputBlock text={restart.output} /> : null}

      {tool.available.length > 0 ? (
        <>
          <ChoiceGroup
            options={tool.available.map((version) => ({ value: version, label: version }))}
            value={target ?? ''}
            onChange={setChosen}
          />
          <Button
            label="Fassung übernehmen"
            variant="primary"
            loading={set.pending}
            disabled={!chosen || chosen === tool.current || set.pending}
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
