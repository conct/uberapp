/**
 * Snapshots and restore.
 *
 * The snapshots are just directories, so the honest interface is a file
 * browser with a date picker on top. The two things the manual makes you do by
 * hand — running the dry-run first, and remembering restorecon afterwards —
 * are the two things this screen takes over.
 */

import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import {
  BACKUP_EXCLUDED_DIRS,
  BACKUP_RETENTION,
  type DumpInfo,
  type FileEntry,
  type MethodName,
  type SnapshotInfo,
} from '@uberctrl/protocol';

import { client, type StreamHandle } from '../src/api/client';
import { describeError, useConnection, useQuery } from '../src/api/hooks';
import {
  Badge,
  Body,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  Field,
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

const MAX_STREAM_LINES = 400;

type Job = { kind: 'preview' | 'restore' | 'db'; label: string };

export default function BackupScreen() {
  const theme = useTheme();
  const connection = useConnection();
  const supported = connection.session?.capabilities.includes('backup') ?? false;
  const user = connection.session?.user ?? 'isabell';

  const home = `/home/${user}`;
  const docroot = `/var/www/virtual/${user}`;

  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [path, setPath] = useState(home);
  const [database, setDatabase] = useState(user);
  const [confirm, setConfirm] = useState<null | { title: string; message: string; run: () => void }>(
    null,
  );

  const snapshots = useQuery<SnapshotInfo[]>('backup.snapshots', undefined, {
    enabled: supported,
  });
  const dumps = useQuery<DumpInfo[]>('backup.db.list', undefined, { enabled: supported });

  // Pick the newest snapshot once they arrive, so the screen is never empty
  // waiting for a choice the user has no reason to make.
  const first = snapshots.data?.[0]?.id;
  useEffect(() => {
    if (snapshot === null && first) setSnapshot(first);
  }, [first, snapshot]);

  const listing = useQuery<{ entries: FileEntry[]; truncated: boolean }>(
    'backup.list',
    { snapshot, path },
    { enabled: supported && snapshot !== null },
  );

  const stream = useStreamJob();

  if (connection.state === 'ready' && !supported) {
    return (
      <ScreenScroll>
        <Card>
          <EmptyState
            title="Keine Snapshots verfügbar"
            hint="Der Agent kann /backup nicht lesen. Entweder ist er älter als diese Funktion, oder der Host stellt keine Snapshots bereit."
          />
        </Card>
      </ScreenScroll>
    );
  }

  const up = parentOf(path, [home, docroot]);

  const askRestore = () => {
    if (!snapshot) return;
    setConfirm({
      title: 'Wiederherstellen',
      message: `${path} wird aus ${snapshot} zurückgeschrieben. Dateien, die es nur im Snapshot gibt, kommen zurück; neuere Dateien bleiben stehen und werden nicht gelöscht. Gleichnamige Dateien werden überschrieben.`,
      run: () => stream.start('backup.restore', { snapshot, path }, { kind: 'restore', label: path }),
    });
  };

  return (
    <ScreenScroll refreshing={snapshots.refreshing} onRefresh={snapshots.refresh}>
      <View style={{ gap: spacing.xs }}>
        <Body muted>
          {BACKUP_RETENTION.dailyDays} Tage täglich, {BACKUP_RETENTION.weeklyWeeks} Wochen
          wöchentlich, Datenbank-Dumps {BACKUP_RETENTION.databaseDays} Tage.
        </Body>
      </View>

      <Card>
        <SectionTitle>Snapshot</SectionTitle>
        {snapshots.loading ? (
          <Loading label="Lade Snapshots…" />
        ) : snapshots.error ? (
          <ErrorBanner message={snapshots.error} onRetry={snapshots.refresh} />
        ) : (snapshots.data?.length ?? 0) === 0 ? (
          <EmptyState title="Keine Snapshots gefunden" />
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              {snapshots.data?.map((entry) => (
                <SnapshotChip
                  key={entry.id}
                  snapshot={entry}
                  selected={entry.id === snapshot}
                  onPress={() => setSnapshot(entry.id)}
                />
              ))}
            </View>
          </ScrollView>
        )}
      </Card>

      <Card>
        <SectionTitle>Ordner</SectionTitle>
        <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
          <Button
            label="Home"
            onPress={() => setPath(home)}
            style={{ flexGrow: 1, flexBasis: 120 }}
          />
          <Button
            label="Webseiten"
            onPress={() => setPath(docroot)}
            style={{ flexGrow: 1, flexBasis: 120 }}
          />
        </View>
        <Mono style={{ fontSize: 12, color: theme.textMuted }}>{path}</Mono>

        {up ? <Button label="Eine Ebene höher" onPress={() => setPath(up)} /> : null}

        {listing.loading ? (
          <Loading label="Lade Inhalt…" />
        ) : listing.error ? (
          <ErrorBanner message={listing.error} onRetry={listing.refresh} />
        ) : (listing.data?.entries.length ?? 0) === 0 ? (
          <EmptyState
            title="Leer in diesem Snapshot"
            hint={`Ordner wie ${BACKUP_EXCLUDED_DIRS.join(', ')} werden grundsätzlich nicht gesichert.`}
          />
        ) : (
          <View style={{ gap: 1 }}>
            {listing.data?.entries.map((entry) => (
              <EntryRow
                key={entry.path}
                entry={entry}
                onPress={entry.type === 'dir' ? () => setPath(entry.path) : undefined}
              />
            ))}
          </View>
        )}
        {listing.data?.truncated ? (
          <InfoBanner message="Nur die ersten 2000 Einträge werden angezeigt." />
        ) : null}
      </Card>

      <Card>
        <SectionTitle>Diesen Ordner zurückholen</SectionTitle>
        <Body muted style={{ fontSize: 13 }}>
          Der Probelauf schreibt nichts und listet auf, was zurückkäme. Danach erst
          wiederherstellen — die SELinux-Kennzeichnung wird automatisch mit erneuert.
        </Body>
        <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
          <Button
            label="Probelauf"
            onPress={() =>
              snapshot &&
              stream.start('backup.preview', { snapshot, path }, { kind: 'preview', label: path })
            }
            disabled={!snapshot || stream.active}
            style={{ flexGrow: 1, flexBasis: 130 }}
          />
          <Button
            label="Wiederherstellen"
            variant="danger"
            onPress={askRestore}
            disabled={!snapshot || stream.active}
            style={{ flexGrow: 1, flexBasis: 130 }}
          />
        </View>
      </Card>

      <Card>
        <SectionTitle>Datenbank-Dumps</SectionTitle>
        {dumps.loading ? (
          <Loading label="Lade Dumps…" />
        ) : dumps.error ? (
          <ErrorBanner message={dumps.error} onRetry={dumps.refresh} />
        ) : (dumps.data?.length ?? 0) === 0 ? (
          <EmptyState title="Keine Dumps gefunden" />
        ) : (
          <>
            <Field
              label="Zieldatenbank"
              value={database}
              onChangeText={setDatabase}
              monospace
              hint={`Muss ${user} heißen oder mit ${user}_ beginnen. Der Inhalt wird überschrieben.`}
            />
            {dumps.data?.map((dump) => (
              <DumpRow
                key={dump.path}
                dump={dump}
                busy={stream.active}
                onRestore={() =>
                  setConfirm({
                    title: 'Dump einspielen',
                    message: `${dump.name} wird in die Datenbank "${database}" eingespielt. Vorhandene Tabellen gleichen Namens werden dabei ersetzt.`,
                    run: () =>
                      stream.start(
                        'backup.db.restore',
                        { file: dump.path, database },
                        { kind: 'db', label: dump.name },
                      ),
                  })
                }
              />
            ))}
          </>
        )}
      </Card>

      {stream.job ? (
        <Card>
          <SectionTitle>{jobTitle(stream.job)}</SectionTitle>
          <Mono style={{ fontSize: 12, color: theme.textMuted }}>{stream.job.label}</Mono>
          {stream.active ? <Loading label="Läuft…" /> : null}
          {stream.error ? <ErrorBanner message={stream.error} /> : null}
          {stream.lines.length > 0 ? <OutputBlock text={stream.lines.join('\n')} /> : null}
          {!stream.active && stream.lines.length === 0 && !stream.error ? (
            <Body muted>Keine Ausgabe — es gab nichts zu tun.</Body>
          ) : null}
          {stream.active ? <Button label="Abbrechen" onPress={stream.cancel} /> : null}
        </Card>
      ) : null}

      <ConfirmDialog
        visible={confirm !== null}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmLabel="Ausführen"
        destructive
        onConfirm={() => {
          const pending = confirm;
          setConfirm(null);
          pending?.run();
        }}
        onCancel={() => setConfirm(null)}
      />
    </ScreenScroll>
  );
}

/**
 * A streaming call the user starts and can restart.
 *
 * useLogStream owns its lifetime through props, which suits a log tail but not
 * a job that is fired on a button press and needs to be runnable twice.
 */
function useStreamJob() {
  const [lines, setLines] = useState<string[]>([]);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const handle = useRef<StreamHandle | null>(null);
  const buffer = useRef('');

  useEffect(() => () => handle.current?.cancel(), []);

  const start = (method: MethodName, params: unknown, next: Job) => {
    handle.current?.cancel();
    buffer.current = '';
    setLines([]);
    setError(null);
    setJob(next);
    setActive(true);

    handle.current = client.stream(
      method,
      params,
      (_stream, data) => {
        buffer.current += data;
        const parts = buffer.current.split('\n');
        buffer.current = parts.pop() ?? '';
        if (parts.length === 0) return;
        setLines((previous) => {
          const merged = [...previous, ...parts];
          return merged.length > MAX_STREAM_LINES
            ? merged.slice(merged.length - MAX_STREAM_LINES)
            : merged;
        });
      },
      (err) => {
        setActive(false);
        // Flush a final line that never got its newline.
        if (buffer.current) {
          const tail = buffer.current;
          buffer.current = '';
          setLines((previous) => [...previous, tail]);
        }
        if (err) setError(describeError(err));
      },
    );
  };

  const cancel = () => {
    handle.current?.cancel();
    handle.current = null;
    setActive(false);
  };

  return { lines, active, error, job, start, cancel };
}

function jobTitle(job: Job): string {
  switch (job.kind) {
    case 'preview':
      return 'Probelauf';
    case 'restore':
      return 'Wiederherstellung';
    default:
      return 'Dump einspielen';
  }
}

function SnapshotChip({
  snapshot,
  selected,
  onPress,
}: {
  snapshot: SnapshotInfo;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: selected ? theme.accent : theme.border,
        backgroundColor: selected ? theme.accent + '18' : theme.surfaceAlt,
        opacity: pressed ? 0.8 : 1,
        gap: 2,
      })}
    >
      <Mono style={{ fontSize: 13, fontWeight: '700', color: selected ? theme.accent : theme.text }}>
        {snapshot.id}
      </Mono>
      <Body muted style={{ fontSize: 11 }}>
        {relativeAge(snapshot.mtime)}
      </Body>
    </Pressable>
  );
}

function EntryRow({ entry, onPress }: { entry: FileEntry; onPress?: () => void }) {
  const theme = useTheme();
  const isDir = entry.type === 'dir';

  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : 'text'}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: 44,
        paddingVertical: spacing.sm,
        opacity: pressed && onPress ? 0.6 : 1,
      })}
    >
      <Body style={{ flex: 1, color: isDir ? theme.accent : theme.text }} numberOfLines={1}>
        {isDir ? `${entry.name}/` : entry.name}
      </Body>
      <Mono style={{ fontSize: 11, color: theme.textFaint }}>
        {isDir ? '' : formatBytes(entry.size)}
      </Mono>
    </Pressable>
  );
}

function DumpRow({
  dump,
  busy,
  onRestore,
}: {
  dump: DumpInfo;
  busy: boolean;
  onRestore: () => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: spacing.sm, paddingVertical: spacing.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Body style={{ flex: 1 }} numberOfLines={1}>
          {dump.name}
        </Body>
        <Badge
          label={dump.generation === 'current' ? 'aktuell' : 'älter'}
          color={dump.generation === 'current' ? theme.success : theme.textFaint}
        />
      </View>
      <Mono style={{ fontSize: 11, color: theme.textFaint }}>
        {formatBytes(dump.size)} · {relativeAge(dump.mtime)}
      </Mono>
      <Button label="Einspielen" onPress={onRestore} disabled={busy} />
    </View>
  );
}

/** The parent directory, or null once we are at a root the account may browse. */
function parentOf(path: string, roots: string[]): string | null {
  if (roots.includes(path)) return null;
  const cut = path.lastIndexOf('/');
  if (cut <= 0) return null;
  const parent = path.slice(0, cut);
  return roots.some((root) => parent === root || parent.startsWith(`${root}/`)) ? parent : null;
}

function relativeAge(mtime: number | null): string {
  if (mtime === null || !Number.isFinite(mtime)) return 'unbekannt';
  const minutes = Math.round((Date.now() - mtime) / 60_000);
  if (minutes < 60) return `vor ${Math.max(minutes, 0)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `vor ${hours} h`;
  return `vor ${Math.round(hours / 24)} Tagen`;
}
