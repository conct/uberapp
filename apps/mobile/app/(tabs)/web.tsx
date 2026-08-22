/**
 * Domains, web backends and log switches.
 */

import { useState } from 'react';
import { View } from 'react-native';
import { Link } from 'expo-router';
import {
  isValidDomain,
  isValidPort,
  type BackendInfo,
  type DomainInfo,
  type WebLogStatus,
} from '@uberapp/protocol';

import { useMutation, useQuery } from '../../src/api/hooks';
import {
  Badge,
  Body,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  Field,
  Loading,
  Mono,
  OutputBlock,
  SectionTitle,
  Title,
  spacing,
} from '../../src/ui/components';
import { ScreenScroll } from '../../src/ui/Screen';
import { useTheme } from '../../src/ui/theme';

export default function WebScreen() {
  const domains = useQuery<DomainInfo[]>('web.domains.list');
  const backends = useQuery<BackendInfo[]>('web.backends.list');
  const logs = useQuery<WebLogStatus[]>('web.log.status');

  const refresh = () => {
    domains.refresh();
    backends.refresh();
    logs.refresh();
  };

  return (
    <ScreenScroll refreshing={domains.refreshing} onRefresh={refresh}>
      <View style={{ gap: spacing.xs }}>
        <Title>Web</Title>
        <Body muted>Domains, Backends und Logs</Body>
      </View>

      <DomainsCard query={domains} onChanged={refresh} />
      <BackendsCard query={backends} onChanged={refresh} />
      <LogsCard query={logs} onChanged={() => logs.refresh()} />

      <Card>
        <SectionTitle>Web-Details</SectionTitle>
        <Body muted>
          Zertifikatslaufzeiten samt automatischem Neustart danach, HTTP-Header, die Fehlerseite
          und die Rechte-Reparatur.
        </Body>
        <Link href="/web-extras" asChild>
          <Button label="Öffnen" onPress={() => {}} />
        </Link>
      </Card>
    </ScreenScroll>
  );
}

function DomainsCard({
  query,
  onChanged,
}: {
  query: ReturnType<typeof useQuery<DomainInfo[]>>;
  onChanged: () => void;
}) {
  const theme = useTheme();
  const [newDomain, setNewDomain] = useState('');
  const [toDelete, setToDelete] = useState<string | null>(null);

  const add = useMutation('web.domains.add', { onSuccess: onChanged });
  const del = useMutation('web.domains.del', { onSuccess: onChanged });
  const records = useMutation('web.records.show');

  const invalid = newDomain.length > 0 && !isValidDomain(newDomain.trim());

  return (
    <Card>
      <SectionTitle>Domains</SectionTitle>

      {query.loading ? (
        <Loading />
      ) : query.error ? (
        <ErrorBanner message={query.error} onRetry={query.refresh} />
      ) : (query.data?.length ?? 0) === 0 ? (
        <EmptyState title="Keine Domains" />
      ) : (
        // Also de-duplicated in the agent, which is the right place for it —
        // but the agent on a host can be older than the app talking to it, and
        // `uberspace web domain list` repeats <user>.uber.space. Rendering the
        // same domain twice would give two rows with one key between them.
        uniqueBy(query.data ?? [], (entry) => entry.domain).map((entry) => (
          <View
            key={entry.domain}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: spacing.sm,
            }}
          >
            <Mono style={{ flexShrink: 1 }}>{entry.domain}</Mono>
            <View style={{ flexDirection: 'row', gap: spacing.xs }}>
              <Button
                label="DNS"
                onPress={() => void records.run({ domain: entry.domain }).catch(() => {})}
              />
              <Button label="Löschen" variant="danger" onPress={() => setToDelete(entry.domain)} />
            </View>
          </View>
        ))
      )}

      {/*
        The error belongs here as much as the output. Without it a failing
        "DNS" button looked like a button that did nothing at all: the call
        rejects, the catch swallows it, and no branch renders anything.
      */}
      {records.error ? <ErrorBanner message={records.error} /> : null}
      {records.output ? <OutputBlock text={records.output} /> : null}
      {add.error ? <ErrorBanner message={add.error} /> : null}
      {add.output ? <OutputBlock text={add.output} /> : null}
      {del.error ? <ErrorBanner message={del.error} /> : null}

      <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
        <Field
          label="Domain hinzufügen"
          value={newDomain}
          onChangeText={setNewDomain}
          placeholder="www.deine-domain.de"
          keyboardType="url"
          error={invalid ? 'Muss ein vollständiger Domainname sein' : null}
          hint="Wildcards gehen nicht — jede Subdomain einzeln anlegen."
        />
        <Button
          label="Hinzufügen"
          variant="primary"
          loading={add.pending}
          disabled={!newDomain.trim() || invalid}
          onPress={() => {
            void add
              .run({ domain: newDomain.trim() })
              .then(() => setNewDomain(''))
              .catch(() => {});
          }}
        />
        <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
          Nach dem Anlegen dauert es einige Minuten, bis Let&apos;s Encrypt das Zertifikat
          ausgestellt hat.
        </Body>
      </View>

      <ConfirmDialog
        visible={toDelete !== null}
        title="Domain löschen"
        message={`${toDelete} wird vom Webserver entfernt.`}
        confirmLabel="Löschen"
        destructive
        onConfirm={() => {
          const domain = toDelete;
          setToDelete(null);
          if (domain) void del.run({ domain }).catch(() => {});
        }}
        onCancel={() => setToDelete(null)}
      />
    </Card>
  );
}

function BackendsCard({
  query,
  onChanged,
}: {
  query: ReturnType<typeof useQuery<BackendInfo[]>>;
  onChanged: () => void;
}) {
  const theme = useTheme();
  const [path, setPath] = useState('/');
  const [port, setPort] = useState('');
  const [removePrefix, setRemovePrefix] = useState(false);
  const [confirmSet, setConfirmSet] = useState(false);
  const [toDelete, setToDelete] = useState<BackendInfo | null>(null);

  const set = useMutation('web.backends.set', { onSuccess: onChanged });
  const del = useMutation('web.backends.del', { onSuccess: onChanged });

  const portNumber = Number(port);
  const portInvalid = port.length > 0 && !isValidPort(portNumber);
  const pathInvalid = !path.startsWith('/');

  return (
    <Card>
      <SectionTitle>Backends</SectionTitle>

      {query.loading ? (
        <Loading />
      ) : query.error ? (
        <ErrorBanner message={query.error} onRetry={query.refresh} />
      ) : (query.data?.length ?? 0) === 0 ? (
        <EmptyState title="Keine Backends" />
      ) : (
        query.data?.map((backend) => (
          <View key={backend.raw} style={{ gap: spacing.xs }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.sm,
              }}
            >
              <Mono style={{ flexShrink: 1 }}>
                {backend.domain}
                {backend.path}
              </Mono>
              <Badge
                label={backend.port ? `:${backend.port}` : backend.type}
                color={/ok/i.test(backend.status) ? theme.success : theme.warning}
              />
            </View>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing.sm,
              }}
            >
              <Mono style={{ color: theme.textMuted, fontSize: 11, flexShrink: 1 }}>
                {backend.status}
              </Mono>
              {backend.type !== 'apache' ? (
                <Button label="Entfernen" variant="danger" onPress={() => setToDelete(backend)} />
              ) : null}
            </View>
          </View>
        ))
      )}

      {set.error ? <ErrorBanner message={set.error} /> : null}
      {set.output ? <OutputBlock text={set.output} /> : null}
      {del.error ? <ErrorBanner message={del.error} /> : null}

      <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
        <Field
          label="Pfad"
          value={path}
          onChangeText={setPath}
          placeholder="/"
          error={pathInvalid ? 'Muss mit / beginnen' : null}
        />
        <Field
          label="Port"
          value={port}
          onChangeText={setPort}
          placeholder="9000"
          keyboardType="numeric"
          error={portInvalid ? '1024–65535' : null}
          hint="Leer lassen, um wieder auf Apache zu leiten."
        />
        <Button
          label={removePrefix ? '☑  Präfix entfernen' : '☐  Präfix entfernen'}
          onPress={() => setRemovePrefix((value) => !value)}
        />
        <Button
          label="Backend setzen"
          variant="primary"
          loading={set.pending}
          disabled={pathInvalid || portInvalid}
          onPress={() => setConfirmSet(true)}
        />
        <Body muted style={{ fontSize: 12 }}>
          Deine Anwendung muss auf 0.0.0.0 lauschen — auf 127.0.0.1 erreicht der Webserver sie
          nicht.
        </Body>
      </View>

      <ConfirmDialog
        visible={confirmSet}
        title="Backend setzen"
        message={
          port
            ? `${path} wird an Port ${port} weitergeleitet.`
            : `${path} wird wieder von Apache bedient.`
        }
        confirmLabel="Setzen"
        onConfirm={() => {
          setConfirmSet(false);
          void set
            .run({
              path,
              ...(port ? { port: portNumber, removePrefix } : {}),
            })
            .catch(() => {});
        }}
        onCancel={() => setConfirmSet(false)}
      />

      <ConfirmDialog
        visible={toDelete !== null}
        title="Backend entfernen"
        message={`${toDelete?.domain ?? ''}${toDelete?.path ?? ''} geht danach wieder an Apache.`}
        confirmLabel="Entfernen"
        destructive
        onConfirm={() => {
          const backend = toDelete;
          setToDelete(null);
          if (backend) {
            void del.run({ domain: backend.domain, path: backend.path }).catch(() => {});
          }
        }}
        onCancel={() => setToDelete(null)}
      />
    </Card>
  );
}

const LOG_LABELS: Record<string, string> = {
  access: 'Zugriffe',
  apache_error: 'Apache-Fehler',
  php_error: 'PHP-Fehler',
};

function LogsCard({
  query,
  onChanged,
}: {
  query: ReturnType<typeof useQuery<WebLogStatus[]>>;
  onChanged: () => void;
}) {
  const theme = useTheme();
  const toggle = useMutation('web.log.setEnabled', { onSuccess: onChanged });

  return (
    <Card>
      <SectionTitle>Logs</SectionTitle>
      {query.loading ? (
        <Loading />
      ) : query.error ? (
        <ErrorBanner message={query.error} onRetry={query.refresh} />
      ) : (
        query.data?.map((entry) => (
          <View
            key={entry.kind}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: spacing.sm,
            }}
          >
            <View style={{ flexShrink: 1 }}>
              <Body>{LOG_LABELS[entry.kind] ?? entry.kind}</Body>
              <Mono style={{ color: theme.textFaint, fontSize: 11 }}>{entry.path}</Mono>
            </View>
            <Button
              label={entry.enabled ? 'An' : 'Aus'}
              variant={entry.enabled ? 'primary' : 'secondary'}
              disabled={toggle.pending}
              onPress={() => {
                void toggle.run({ kind: entry.kind, enabled: !entry.enabled }).catch(() => {});
              }}
            />
          </View>
        ))
      )}
      {toggle.error ? <ErrorBanner message={toggle.error} /> : null}
    </Card>
  );
}

/**
 * Keep the first entry for each key and drop later repeats.
 *
 * The app cannot choose which agent version a host runs, so a list that should
 * be a set may not be one. Filtering here keeps the rendered rows honest and
 * their React keys unique, without pretending the data was already clean.
 */
function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
