/**
 * MySQL administration.
 *
 * The credentials sit in ~/.my.cnf, so the agent logs in by itself and this
 * screen never has to ask for a password. What it does have to do is make the
 * naming rule visible before a name is submitted, and make a dump something
 * you press rather than something you compose.
 */

import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import {
  isOwnDatabase,
  MAX_DB_SUFFIX_LENGTH,
  type DatabaseInfo,
  type MethodName,
  type TableInfo,
} from '@uberctrl/protocol';

import { client, type StreamHandle } from '../src/api/client';
import { describeError, useConnection, useMutation, useQuery } from '../src/api/hooks';
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
} from '../src/ui/components';
import { ScreenScroll } from '../src/ui/Screen';
import { formatBytes, useTheme } from '../src/ui/theme';

export default function DatabasesScreen() {
  const theme = useTheme();
  const connection = useConnection();
  const supported = connection.session?.capabilities.includes('databases') ?? false;
  const user = connection.session?.user ?? 'isabell';
  const home = `/home/${user}`;

  const databases = useQuery<DatabaseInfo[]>('db.mysql.list', undefined, { enabled: supported });

  const [suffix, setSuffix] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dropping, setDropping] = useState<DatabaseInfo | null>(null);
  const [importing, setImporting] = useState<DatabaseInfo | null>(null);
  const [importPath, setImportPath] = useState('');
  const [confirmImport, setConfirmImport] = useState(false);

  const create = useMutation<{ database: string }>('db.mysql.create', {
    onSuccess: () => {
      setSuffix('');
      databases.refresh();
    },
  });
  const drop = useMutation<{ database: string }>('db.mysql.drop', {
    onSuccess: () => databases.refresh(),
  });

  const job = useStreamJob(() => databases.refresh());

  const proposed = suffix ? `${user}_${suffix}` : '';
  const nameProblem =
    proposed && !isOwnDatabase(proposed, user)
      ? `Erlaubt sind Buchstaben, Ziffern und Unterstrich, höchstens ${MAX_DB_SUFFIX_LENGTH} Zeichen.`
      : null;
  const taken = databases.data?.some((entry) => entry.name === proposed) ?? false;

  if (connection.state === 'ready' && !supported) {
    return (
      <ScreenScroll>
        <Card>
          <EmptyState
            title="Keine Datenbank-Zugangsdaten"
            hint="Der Agent findet keine ~/.my.cnf. Entweder ist er älter als diese Funktion, oder auf dem Host wurde die Datei entfernt."
          />
        </Card>
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll refreshing={databases.refreshing} onRefresh={databases.refresh}>
      <View style={{ gap: spacing.xs }}>
        <Body muted>MariaDB auf deinem Uberspace</Body>
      </View>

      {create.error ? <ErrorBanner message={create.error} /> : null}
      {drop.error ? <ErrorBanner message={drop.error} /> : null}

      <Card>
        <SectionTitle>Neue Datenbank</SectionTitle>
        <Field
          label="Name"
          value={suffix}
          onChangeText={setSuffix}
          placeholder="blog"
          monospace
          error={nameProblem ?? (taken ? 'Diese Datenbank gibt es schon.' : null)}
          hint={proposed ? `Wird angelegt als ${proposed}` : `Jede Datenbank heißt ${user}_…`}
        />
        <Button
          label="Anlegen"
          variant="primary"
          onPress={() => void create.run({ database: proposed }).catch(() => {})}
          disabled={!proposed || nameProblem !== null || taken || create.pending}
          loading={create.pending}
        />
      </Card>

      {databases.loading ? (
        <Loading label="Lade Datenbanken…" />
      ) : databases.error ? (
        <ErrorBanner message={databases.error} onRetry={databases.refresh} />
      ) : (
        databases.data?.map((database) => (
          <DatabaseCard
            key={database.name}
            database={database}
            home={home}
            busy={drop.pending || job.active}
            expanded={expanded === database.name}
            onToggle={() =>
              setExpanded((current) => (current === database.name ? null : database.name))
            }
            onDump={(path) =>
              job.start('db.mysql.dump', { database: database.name, path }, `Dump ${database.name}`)
            }
            onDrop={() => setDropping(database)}
            onImport={() => {
              setImporting(database);
              setImportPath('');
            }}
          />
        ))
      )}

      {/*
        Importing needs a path typed in, so it gets a card rather than a
        dialog — the same shape the rename in the files tab uses. The dump has
        to be somewhere under $HOME; the agent refuses anything outside it, and
        saying so here saves a round trip.
      */}
      {importing ? (
        <Card>
          <SectionTitle>Dump einspielen</SectionTitle>
          <Body muted style={{ fontSize: 13 }}>
            Wird auf <Mono>{importing.name}</Mono> angewendet. Bestehende Tabellen gleichen Namens
            überschreibt der Dump, alle anderen bleiben stehen — das Ergebnis ist beides gemischt,
            keine saubere Kopie.
          </Body>
          <Field
            label="Datei"
            value={importPath}
            onChangeText={setImportPath}
            placeholder={`${home}/${importing.name}-2026-01-01.sql`}
            hint="Muss unter deinem Home liegen. .sql oder .sql.xz."
          />
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Button label="Abbrechen" onPress={() => setImporting(null)} style={{ flex: 1 }} />
            <Button
              label="Einspielen"
              variant="danger"
              disabled={!importPath.trim() || job.active}
              onPress={() => setConfirmImport(true)}
              style={{ flex: 1 }}
            />
          </View>
        </Card>
      ) : null}

      {job.label ? (
        <Card>
          <SectionTitle>{job.label}</SectionTitle>
          {job.active ? <Loading label="Läuft…" /> : null}
          {job.error ? <ErrorBanner message={job.error} /> : null}
          {job.lines.length > 0 ? <OutputBlock text={job.lines.join('\n')} /> : null}
          {job.active ? <Button label="Abbrechen" onPress={job.cancel} /> : null}
        </Card>
      ) : null}

      <ConfirmDialog
        visible={confirmImport && importing !== null}
        title="Dump einspielen"
        message={
          importing
            ? `Der Dump wird in "${importing.name}" eingespielt. Was er enthält, ersetzt gleichnamige Tabellen; rückgängig macht das nur ein eigener Dump von vorher.`
            : ''
        }
        confirmLabel="Einspielen"
        destructive
        onConfirm={() => {
          const target = importing;
          const path = importPath.trim();
          setConfirmImport(false);
          setImporting(null);
          if (target) {
            job.start(
              'db.mysql.import',
              { database: target.name, path },
              `Einspielen in ${target.name}`,
            );
          }
        }}
        onCancel={() => setConfirmImport(false)}
      />

      <ConfirmDialog
        visible={dropping !== null}
        title="Datenbank löschen"
        message={
          dropping
            ? `"${dropping.name}" wird mit allen ${dropping.tables ?? 0} Tabellen gelöscht. Zurückholen lässt sich das nur aus einem Dump.`
            : ''
        }
        confirmLabel="Löschen"
        destructive
        onConfirm={() => {
          const target = dropping;
          setDropping(null);
          if (target) void drop.run({ database: target.name }).catch(() => {});
        }}
        onCancel={() => setDropping(null)}
      />

      <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
        Dumps landen in deinem Home und lassen sich dort per SFTP abholen. Tägliche Sicherungen
        macht Uberspace ohnehin — die findest du unter Backup.
      </Body>
    </ScreenScroll>
  );
}

function DatabaseCard({
  database,
  home,
  busy,
  expanded,
  onToggle,
  onDump,
  onDrop,
  onImport,
}: {
  database: DatabaseInfo;
  home: string;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onDump: (path: string) => void;
  onDrop: () => void;
  onImport: () => void;
}) {
  const theme = useTheme();
  const tables = useQuery<{ tables: TableInfo[] }>(
    'db.mysql.tables',
    { database: database.name },
    { enabled: expanded },
  );

  return (
    <Card>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: spacing.sm,
        }}
      >
        <Mono style={{ fontSize: 15, fontWeight: '700' }}>{database.name}</Mono>
        {database.removable ? null : <Badge label="Konto" color={theme.textFaint} />}
      </View>

      <Mono style={{ fontSize: 12, color: theme.textMuted }}>
        {database.tables === null ? 'leer' : `${database.tables} Tabellen`}
        {database.size !== null ? ` · ${formatBytes(database.size)}` : ''}
      </Mono>

      <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
        <Button
          label={expanded ? 'Tabellen verbergen' : 'Tabellen'}
          onPress={onToggle}
          style={{ flexGrow: 1, flexBasis: 110 }}
        />
        <Button
          label="Dump"
          onPress={() => onDump(`${home}/${database.name}-${today()}.sql`)}
          disabled={busy}
          style={{ flexGrow: 1, flexBasis: 110 }}
        />
        <Button
          label="Einspielen"
          onPress={onImport}
          disabled={busy}
          style={{ flexGrow: 1, flexBasis: 110 }}
        />
        {database.removable ? (
          <Button
            label="Löschen"
            variant="danger"
            onPress={onDrop}
            disabled={busy}
            style={{ flexGrow: 1, flexBasis: 110 }}
          />
        ) : null}
      </View>

      {expanded ? (
        tables.loading ? (
          <Loading label="Lade Tabellen…" />
        ) : tables.error ? (
          <ErrorBanner message={tables.error} onRetry={tables.refresh} />
        ) : (tables.data?.tables.length ?? 0) === 0 ? (
          <EmptyState title="Keine Tabellen" />
        ) : (
          <View style={{ gap: spacing.sm }}>
            {tables.data?.tables.map((table) => (
              <View
                key={table.name}
                style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}
              >
                <Body style={{ flex: 1 }} numberOfLines={1}>
                  {table.name}
                </Body>
                <Mono style={{ fontSize: 11, color: theme.textFaint }}>
                  {table.rows === null ? '—' : `~${table.rows}`} ·{' '}
                  {table.size === null ? '—' : formatBytes(table.size)}
                </Mono>
              </View>
            ))}
            <InfoBanner message="Zeilenzahlen sind bei InnoDB Schätzwerte, keine exakten Zählungen." />
          </View>
        )
      ) : null}
    </Card>
  );
}

/** A streaming call started by a button press; see backup.tsx for the twin. */
function useStreamJob(onFinished: () => void) {
  const [lines, setLines] = useState<string[]>([]);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const handle = useRef<StreamHandle | null>(null);
  const buffer = useRef('');
  const finished = useRef(onFinished);
  finished.current = onFinished;

  useEffect(() => () => handle.current?.cancel(), []);

  const start = (method: MethodName, params: unknown, next: string) => {
    handle.current?.cancel();
    buffer.current = '';
    setLines([]);
    setError(null);
    setLabel(next);
    setActive(true);

    handle.current = client.stream(
      method,
      params,
      (_stream, data) => {
        buffer.current += data;
        const parts = buffer.current.split('\n');
        buffer.current = parts.pop() ?? '';
        if (parts.length > 0) setLines((previous) => [...previous, ...parts].slice(-200));
      },
      (err) => {
        setActive(false);
        if (buffer.current) {
          const tail = buffer.current;
          buffer.current = '';
          setLines((previous) => [...previous, tail]);
        }
        if (err) setError(describeError(err));
        else finished.current();
      },
    );
  };

  const cancel = () => {
    handle.current?.cancel();
    handle.current = null;
    setActive(false);
  };

  return { lines, active, error, label, start, cancel };
}

/** Local date, so a dump filename matches the day the user thinks it is. */
function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}
