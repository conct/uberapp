/**
 * One service: live log tail plus its supervisord config.
 */

import { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';

import { useLogStream, useMutation, useQuery } from '../../src/api/hooks';
import {
  Badge,
  Body,
  Button,
  Card,
  ConfirmDialog,
  ErrorBanner,
  Field,
  Loading,
  Mono,
  SectionTitle,
  spacing,
  radius,
} from '../../src/ui/components';
import { ConnectionStrip } from '../../src/ui/Screen';
import { useTheme } from '../../src/ui/theme';

type LogStream = 'stdout' | 'stderr';

export default function ServiceDetailScreen() {
  const theme = useTheme();
  const { name } = useLocalSearchParams<{ name: string }>();
  const serviceName = String(name ?? '');

  const [stream, setStream] = useState<LogStream>('stdout');
  const [tab, setTab] = useState<'logs' | 'config'>('logs');

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Stack.Screen options={{ title: serviceName }} />
      <ConnectionStrip />

      <View
        style={{
          flexDirection: 'row',
          gap: spacing.sm,
          padding: spacing.lg,
          paddingBottom: spacing.sm,
        }}
      >
        <Button
          label="Logs"
          variant={tab === 'logs' ? 'primary' : 'secondary'}
          onPress={() => setTab('logs')}
          style={{ flex: 1 }}
        />
        <Button
          label="Konfiguration"
          variant={tab === 'config' ? 'primary' : 'secondary'}
          onPress={() => setTab('config')}
          style={{ flex: 1 }}
        />
      </View>

      {tab === 'logs' ? (
        <LogsPane serviceName={serviceName} stream={stream} onStreamChange={setStream} />
      ) : (
        <ConfigPane serviceName={serviceName} />
      )}
    </View>
  );
}

function LogsPane({
  serviceName,
  stream,
  onStreamChange,
}: {
  serviceName: string;
  stream: LogStream;
  onStreamChange: (stream: LogStream) => void;
}) {
  const theme = useTheme();
  const { lines, error, active } = useLogStream('services.logs', {
    name: serviceName,
    stream,
  });

  const scrollRef = useRef<ScrollView>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (follow) scrollRef.current?.scrollToEnd({ animated: false });
  }, [lines, follow]);

  return (
    <View style={{ flex: 1, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Button
          label="stdout"
          variant={stream === 'stdout' ? 'primary' : 'secondary'}
          onPress={() => onStreamChange('stdout')}
          style={{ flex: 1 }}
        />
        <Button
          label="stderr"
          variant={stream === 'stderr' ? 'primary' : 'secondary'}
          onPress={() => onStreamChange('stderr')}
          style={{ flex: 1 }}
        />
        <Badge
          label={active ? 'live' : 'aus'}
          color={active ? theme.success : theme.textFaint}
        />
      </View>

      {error ? <ErrorBanner message={error} /> : null}

      <ScrollView
        ref={scrollRef}
        style={{
          flex: 1,
          backgroundColor: theme.mono,
          borderRadius: radius.sm,
        }}
        contentContainerStyle={{ padding: spacing.md }}
        // Turning off follow when the user scrolls up keeps them from being
        // yanked back to the bottom while they read.
        onScrollBeginDrag={() => setFollow(false)}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View>
            {lines.length === 0 ? (
              <Mono style={{ color: '#8b949e' }}>
                {active ? 'Warte auf Ausgabe…' : 'Keine Ausgabe.'}
              </Mono>
            ) : (
              lines.map((line, index) => (
                <Mono key={`${index}-${line.slice(0, 16)}`} style={{ color: '#c9d1d9' }}>
                  {line || ' '}
                </Mono>
              ))
            )}
          </View>
        </ScrollView>
      </ScrollView>

      {!follow ? (
        <Button
          label="Zum Ende springen"
          onPress={() => {
            setFollow(true);
            scrollRef.current?.scrollToEnd({ animated: true });
          }}
        />
      ) : null}
    </View>
  );
}

function ConfigPane({ serviceName }: { serviceName: string }) {
  const config = useQuery<{ path: string; content: string }>('services.readConfig', {
    name: serviceName,
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const save = useMutation('services.writeConfig', {
    onSuccess: () => config.refresh(),
  });

  // Seed the editor once the file arrives, but never clobber unsaved edits.
  useEffect(() => {
    if (draft === null && config.data) setDraft(config.data.content);
  }, [config.data, draft]);

  const dirty = draft !== null && config.data !== null && draft !== config.data.content;

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
      {config.loading ? (
        <Loading />
      ) : config.error ? (
        <Card>
          <SectionTitle>Keine Konfigurationsdatei</SectionTitle>
          <Body muted>{config.error}</Body>
          <Body muted>
            Services, die per supervisorctl angelegt wurden, haben nicht zwingend eine .ini-Datei in
            ~/etc/services.d.
          </Body>
        </Card>
      ) : (
        <Card>
          {/* Mono, not SectionTitle: the path must not be uppercased. */}
          <Mono style={{ fontSize: 12 }}>{config.data?.path ?? ''}</Mono>
          <Field
            label="Inhalt"
            value={draft ?? ''}
            onChangeText={setDraft}
            multiline
            monospace
            hint={dirty ? 'Ungespeicherte Änderungen' : undefined}
          />
          {save.error ? <ErrorBanner message={save.error} /> : null}
          <Button
            label="Speichern"
            variant="primary"
            onPress={() => setConfirmOpen(true)}
            disabled={!dirty}
            loading={save.pending}
          />
          <Body muted style={{ fontSize: 12 }}>
            Nach dem Speichern auf dem Services-Tab "Neu einlesen" ausführen, damit supervisord die
            Änderung übernimmt.
          </Body>
        </Card>
      )}

      <ConfirmDialog
        visible={confirmOpen}
        title="Konfiguration speichern"
        message={`${config.data?.path ?? 'Die Datei'} wird überschrieben.`}
        confirmLabel="Speichern"
        onConfirm={() => {
          setConfirmOpen(false);
          void save.run({ name: serviceName, content: draft ?? '' }).catch(() => {});
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </ScrollView>
  );
}
