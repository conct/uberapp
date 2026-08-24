/**
 * Diagnostics: where the space went, and why a service keeps dying.
 *
 * Both questions have a documented answer that a file listing cannot show —
 * space held open by deleted files, and the 1.5 GB memory ceiling that
 * terminates processes without much ceremony.
 */

import { useState } from 'react';
import { View } from 'react-native';
import {
  BACKUP_EXCLUDED_DIRS,
  type DeletedFile,
  type DiskUsageEntry,
  type MemoryUsage,
} from '@uberctrl/protocol';

import { useMutation, useQuery } from '../src/api/hooks';
import {
  Badge,
  Body,
  Button,
  Card,
  ChoiceGroup,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  InfoBanner,
  Loading,
  Mono,
  OutputBlock,
  SectionTitle,
  spacing,
  radius,
} from '../src/ui/components';
import { ScreenScroll } from '../src/ui/Screen';
import { formatBytes, useTheme } from '../src/ui/theme';

export default function DiagnosticsScreen() {
  return (
    <ScreenScroll>
      <View style={{ gap: spacing.xs }}>
        <Body muted>Speicher, Arbeitsspeicher und Login-Shell</Body>
      </View>

      <MemoryCard />
      <DiskCard />
      <DeletedCard />
      <ShellCard />
    </ScreenScroll>
  );
}

function MemoryCard() {
  const theme = useTheme();
  const memory = useQuery<MemoryUsage>('system.memory', undefined, { pollMs: 15_000 });

  const percent = memory.data?.percent ?? 0;
  const color = percent > 90 ? theme.danger : percent > 70 ? theme.warning : theme.success;

  return (
    <Card>
      <SectionTitle>Arbeitsspeicher</SectionTitle>
      {memory.error ? <ErrorBanner message={memory.error} onRetry={memory.refresh} /> : null}
      {memory.loading ? (
        <Loading />
      ) : memory.data ? (
        <>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Body>
              {formatBytes(memory.data.rssBytes)} von {formatBytes(memory.data.limitBytes)}
            </Body>
            <Badge label={`${percent} %`} color={color} />
          </View>
          <View
            style={{
              height: 8,
              borderRadius: radius.sm,
              backgroundColor: theme.surfaceAlt,
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                width: `${Math.min(percent, 100)}%`,
                height: '100%',
                backgroundColor: color,
              }}
            />
          </View>
          <Body muted style={{ fontSize: 12 }}>
            {memory.data.processCount} Prozesse. Über dem Limit beendet Uberspace Prozesse ohne
            Vorwarnung — ein Dienst, der immer wieder in BACKOFF landet, hat oft hier seine Ursache.
          </Body>
        </>
      ) : null}
    </Card>
  );
}

function DiskCard() {
  const theme = useTheme();
  const usage = useQuery<{ entries: DiskUsageEntry[] }>('system.diskUsage');

  const total = usage.data?.entries.reduce((sum, entry) => sum + entry.bytes, 0) ?? 0;

  return (
    <Card>
      <SectionTitle>Speicherverbrauch</SectionTitle>
      {usage.error ? <ErrorBanner message={usage.error} onRetry={usage.refresh} /> : null}
      {usage.loading ? (
        <Loading label="Zähle durch — das dauert einen Moment…" />
      ) : (
        usage.data?.entries.map((entry) => (
          <View key={entry.path} style={{ gap: 2, paddingVertical: 4 }}>
            <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
              <Mono style={{ flex: 1, fontSize: 12 }} numberOfLines={1}>
                {entry.path}
              </Mono>
              <Mono style={{ fontSize: 12, color: entry.error ? theme.textFaint : theme.text }}>
                {entry.error ? '—' : formatBytes(entry.bytes)}
              </Mono>
            </View>
            {entry.error ? (
              <Body muted style={{ fontSize: 11 }}>
                {entry.error}
              </Body>
            ) : null}
          </View>
        ))
      )}
      {usage.data ? (
        <Body style={{ fontWeight: '700' }}>Summe: {formatBytes(total)}</Body>
      ) : null}
      <InfoBanner
        message={`Gemessen werden nur die Verzeichnisse, die dir gehören — /tmp und /var/tmp sind auf einem geteilten Host voll mit fremden Dateien und dauern zu lange. Ordner mit den Namen ${BACKUP_EXCLUDED_DIRS.join(', ')} zählen zwar zur Quota, werden aber nicht gesichert.`}
      />
    </Card>
  );
}

function DeletedCard() {
  const theme = useTheme();
  const deleted = useQuery<{ files: DeletedFile[]; totalBytes: number }>('system.deletedFiles');

  return (
    <Card>
      <SectionTitle>Gelöscht, aber noch belegt</SectionTitle>
      <Body muted style={{ fontSize: 13 }}>
        Solange ein Prozess eine gelöschte Datei offen hält, gibt das Dateisystem den Platz nicht
        frei. Ein Neustart des Prozesses holt ihn zurück.
      </Body>

      {deleted.error ? <ErrorBanner message={deleted.error} onRetry={deleted.refresh} /> : null}
      {deleted.loading ? (
        <Loading />
      ) : (deleted.data?.files.length ?? 0) === 0 ? (
        <EmptyState title="Nichts gefunden" hint="Hier liegt kein Speicherplatz brach." />
      ) : (
        <>
          <Body style={{ fontWeight: '700' }}>
            {formatBytes(deleted.data?.totalBytes ?? 0)} blockiert
          </Body>
          {deleted.data?.files.slice(0, 20).map((file) => (
            <View key={`${file.pid}-${file.path}`} style={{ gap: 2, paddingVertical: 4 }}>
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <Mono style={{ flex: 1, fontSize: 12 }} numberOfLines={1}>
                  {file.process} · PID {file.pid}
                </Mono>
                <Mono style={{ fontSize: 12 }}>{formatBytes(file.bytes)}</Mono>
              </View>
              <Mono style={{ fontSize: 11, color: theme.textFaint }} numberOfLines={1}>
                {file.path}
              </Mono>
            </View>
          ))}
        </>
      )}
    </Card>
  );
}

function ShellCard() {
  const shells = useQuery<{ shells: string[]; current: string | null }>('system.shell.list');
  const [chosen, setChosen] = useState<string | null>(null);
  const set = useMutation<{ shell: string }>('system.shell.set', {
    onSuccess: () => shells.refresh(),
  });

  return (
    <Card>
      <SectionTitle>Login-Shell</SectionTitle>
      {shells.error ? <ErrorBanner message={shells.error} onRetry={shells.refresh} /> : null}
      {set.error ? <ErrorBanner message={set.error} /> : null}
      {set.output ? <OutputBlock text={set.output} /> : null}

      {shells.loading ? (
        <Loading />
      ) : shells.data ? (
        <>
          <Body muted style={{ fontSize: 13 }}>
            Gilt für neue SSH-Sitzungen. Die laufende bleibt, wie sie ist.
          </Body>
          <ChoiceGroup
            options={shells.data.shells.map((shell) => ({ value: shell, label: shell }))}
            value={chosen ?? shells.data.current ?? ''}
            onChange={setChosen}
          />
          <Button
            label="Übernehmen"
            onPress={() => chosen && void set.run({ shell: chosen }).catch(() => {})}
            disabled={!chosen || chosen === shells.data.current || set.pending}
            loading={set.pending}
          />
        </>
      ) : null}
    </Card>
  );
}
