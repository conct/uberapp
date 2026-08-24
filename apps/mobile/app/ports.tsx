/**
 * Firewall ports.
 *
 * The CLI can only tell you which ports are open. The interesting question is
 * the one it cannot answer — is anything actually listening, and is it bound
 * so the firewall can reach it — so that answer leads here.
 */

import { useState } from 'react';
import { View } from 'react-native';
import {
  FIREWALL_PORT_RANGE,
  MAX_FIREWALL_PORTS,
  type ListenerInfo,
  type PortInfo,
} from '@uberctrl/protocol';

import { useConnection, useMutation, useQuery } from '../src/api/hooks';
import {
  Badge,
  Body,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  InfoBanner,
  KeyValue,
  Loading,
  Mono,
  OutputBlock,
  SectionTitle,
  spacing,
} from '../src/ui/components';
import { ScreenScroll } from '../src/ui/Screen';
import { useTheme, type Theme } from '../src/ui/theme';

export default function PortsScreen() {
  const theme = useTheme();
  const connection = useConnection();
  const supported = connection.session?.capabilities.includes('ports') ?? false;

  const ports = useQuery<PortInfo[]>('ports.list', undefined, { enabled: supported });
  const [addOpen, setAddOpen] = useState(false);
  const [closing, setClosing] = useState<number | null>(null);

  const add = useMutation('ports.add', { onSuccess: () => ports.refresh() });
  const del = useMutation<{ port: number }>('ports.del', { onSuccess: () => ports.refresh() });

  const open = ports.data ?? [];
  const atCap = open.length >= MAX_FIREWALL_PORTS;
  // All null means ss was unreadable, not that nothing is listening.
  const socketsUnknown = open.length > 0 && open.every((entry) => entry.reachable === null);

  if (connection.state === 'ready' && !supported) {
    return (
      <ScreenScroll>
        <Card>
          <EmptyState
            title="Agent kann noch keine Ports"
            hint="Diese Version des Agenten meldet die Fähigkeit „ports“ nicht. Aktualisiere den Agenten auf deinem Uberspace."
          />
        </Card>
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll refreshing={ports.refreshing} onRefresh={ports.refresh}>
      <View style={{ gap: spacing.xs }}>
        <Body muted>Freigaben in der Firewall deines Uberspace</Body>
      </View>

      <Card>
        <SectionTitle>Freigaben</SectionTitle>
        <KeyValue label="Offen" value={`${open.length} von ${MAX_FIREWALL_PORTS}`} />
        <Body muted style={{ fontSize: 13 }}>
          Die Nummer wird zugeteilt, nicht gewählt — sie liegt zwischen {FIREWALL_PORT_RANGE.min}{' '}
          und {FIREWALL_PORT_RANGE.max}. Bis zur Freischaltung dauert es ein paar Minuten.
        </Body>
        <Button
          label={atCap ? `Grenze von ${MAX_FIREWALL_PORTS} erreicht` : 'Port freigeben'}
          variant="primary"
          onPress={() => setAddOpen(true)}
          disabled={atCap}
          loading={add.pending}
        />
        {add.error ? <ErrorBanner message={add.error} /> : null}
        {add.output ? <OutputBlock text={add.output} /> : null}
      </Card>

      {del.error ? <ErrorBanner message={del.error} /> : null}
      {del.output ? <OutputBlock text={del.output} /> : null}

      {socketsUnknown ? (
        <InfoBanner message="Die offenen Sockets lassen sich auf diesem Host nicht auslesen (ss fehlt). Die Ports stimmen, wer dahinter lauscht bleibt offen." />
      ) : null}

      {ports.loading ? (
        <Loading label="Lade Ports…" />
      ) : ports.error ? (
        <ErrorBanner message={ports.error} onRetry={ports.refresh} />
      ) : open.length === 0 ? (
        <Card>
          <EmptyState
            title="Keine Ports offen"
            hint="Ein eigener Dienst braucht nur dann einen Port, wenn er direkt von außen erreichbar sein soll. Für Webanwendungen genügt ein Web-Backend."
          />
        </Card>
      ) : (
        open.map((entry) => (
          <PortCard
            key={entry.port}
            entry={entry}
            busy={del.pending}
            onClose={() => setClosing(entry.port)}
          />
        ))
      )}

      <ConfirmDialog
        visible={addOpen}
        title="Port freigeben"
        message={`Uberspace teilt einen freien Port zu und öffnet ihn für TCP und UDP. Danach sind ${Math.min(
          open.length + 1,
          MAX_FIREWALL_PORTS,
        )} von ${MAX_FIREWALL_PORTS} Ports belegt.`}
        confirmLabel="Freigeben"
        onConfirm={() => {
          setAddOpen(false);
          void add.run(undefined).catch(() => {});
        }}
        onCancel={() => setAddOpen(false)}
      />

      <ConfirmDialog
        visible={closing !== null}
        title="Port schließen"
        message={
          closing === null
            ? ''
            : `Port ${closing} wird in wenigen Minuten geschlossen. Dienste, die darüber erreichbar sind, verlieren ihren Zugang von außen.`
        }
        confirmLabel="Schließen"
        destructive
        onConfirm={() => {
          const port = closing;
          setClosing(null);
          if (port !== null) void del.run({ port }).catch(() => {});
        }}
        onCancel={() => setClosing(null)}
      />

      <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
        Ein Dienst ist von außen nur erreichbar, wenn er auf :: oder 0.0.0.0 lauscht. Bindet er sich
        an localhost, bleibt der offene Port wirkungslos.
      </Body>
    </ScreenScroll>
  );
}

function PortCard({
  entry,
  busy,
  onClose,
}: {
  entry: PortInfo;
  busy: boolean;
  onClose: () => void;
}) {
  const theme = useTheme();
  const status = portStatus(entry, theme);

  return (
    <Card>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: spacing.sm,
        }}
      >
        <Mono style={{ fontSize: 20, fontWeight: '700' }}>{entry.port}</Mono>
        <Badge label={status.label} color={status.color} />
      </View>

      {entry.listeners.length > 0 ? (
        <View style={{ gap: 2 }}>
          {entry.listeners.map((listener, index) => (
            <Mono
              key={`${listener.protocol}-${listener.address}-${listener.pid ?? index}`}
              style={{ color: theme.textMuted, fontSize: 12 }}
            >
              {describeListener(listener)}
            </Mono>
          ))}
        </View>
      ) : entry.reachable !== null ? (
        <Body muted style={{ fontSize: 13 }}>
          Kein Prozess lauscht auf diesem Port.
        </Body>
      ) : null}

      {status.hint ? <InfoBanner message={status.hint} /> : null}

      <Button label="Schließen" variant="danger" onPress={onClose} disabled={busy} />
    </Card>
  );
}

function describeListener(listener: ListenerInfo): string {
  const parts = [
    listener.process || 'unbekannter Prozess',
    listener.pid !== null ? `PID ${listener.pid}` : null,
    `${listener.address} (${listener.protocol})`,
  ];
  return parts.filter(Boolean).join(' · ');
}

function portStatus(entry: PortInfo, theme: Theme): { label: string; color: string; hint?: string } {
  if (entry.reachable === null) {
    return { label: 'Unbekannt', color: theme.textFaint };
  }
  if (entry.reachable) {
    return { label: 'Erreichbar', color: theme.success };
  }
  if (entry.listeners.length === 0) {
    return {
      label: 'Nichts lauscht',
      color: theme.warning,
      hint: 'Der Port ist offen, aber kein Dienst nimmt ihn an. Läuft der zugehörige Service?',
    };
  }
  return {
    label: 'Nur localhost',
    color: theme.danger,
    hint: 'Der Dienst lauscht nur auf localhost — von außen kommt hier nichts an. Stelle die Bindung auf :: oder 0.0.0.0 um und starte ihn neu.',
  };
}
