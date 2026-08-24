/**
 * The zone of one domain.
 *
 * DNS is the part of hosting where a typo is invisible for hours and then
 * takes a site down, so this screen spends its effort on two things: showing
 * what the zone currently says, and refusing a record that cannot be right
 * before it costs a round trip. The validation is the protocol's, so the agent
 * applies the same rules to the same input — a client is not to be trusted
 * about a TTL, and it should not have to be.
 *
 * The form sits above the list. What somebody came here to do is add or fix a
 * record; the existing ones are what they check afterwards.
 */

import { useState } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import {
  DNS_RECORD_TYPES,
  dnsRecordProblem,
  MIN_TTL,
  type DnsRecord,
} from '@uberapp/protocol';

import { useMutation, useQuery } from '../../src/api/hooks';
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
} from '../../src/ui/components';
import { ScreenScroll } from '../../src/ui/Screen';
import { useTheme } from '../../src/ui/theme';

/** The handful people actually reach for, in the order they reach for them. */
const COMMON_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT'] as const;

interface Draft {
  /** Set when editing an existing record; null for a new one. */
  id: string | null;
  name: string;
  type: string;
  content: string;
  ttl: string;
  priority: string;
}

const EMPTY: Draft = { id: null, name: '', type: 'A', content: '', ttl: '3600', priority: '' };

export default function DnsScreen() {
  const theme = useTheme();
  const { domain: raw } = useLocalSearchParams<{ domain: string }>();
  const domain = String(raw ?? '');

  const records = useQuery<{ domain: string; records: DnsRecord[] }>('dns.records', { domain });

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [deleting, setDeleting] = useState<DnsRecord | null>(null);
  const [showAllTypes, setShowAllTypes] = useState(false);

  const done = () => {
    setDraft(EMPTY);
    records.refresh();
  };

  const create = useMutation('dns.createRecord', { onSuccess: done });
  const update = useMutation('dns.updateRecord', { onSuccess: done });
  const remove = useMutation('dns.deleteRecord', { onSuccess: () => records.refresh() });

  const ttl = Number(draft.ttl);
  const priority = draft.priority.trim() ? Number(draft.priority) : undefined;

  const problem = dnsRecordProblem({
    domain,
    type: draft.type,
    content: draft.content,
    name: draft.name,
    ttl: draft.ttl.trim() ? ttl : undefined,
    ...(priority === undefined ? {} : { priority }),
  });

  const wantsPriority = draft.type === 'MX' || draft.type === 'SRV';
  const editing = draft.id !== null;
  const busy = create.pending || update.pending || remove.pending;

  const submit = () => {
    const payload = {
      domain,
      type: draft.type,
      content: draft.content.trim(),
      name: draft.name.trim(),
      ttl: draft.ttl.trim() ? ttl : MIN_TTL * 12,
      ...(wantsPriority && priority !== undefined ? { priority } : {}),
    };
    if (editing) {
      void update.run({ ...payload, id: draft.id }).catch(() => {});
    } else {
      void create.run(payload).catch(() => {});
    }
  };

  const types = showAllTypes ? DNS_RECORD_TYPES : COMMON_TYPES;

  return (
    <ScreenScroll refreshing={records.refreshing} onRefresh={records.refresh}>
      <Stack.Screen options={{ title: domain }} />

      <Card>
        <SectionTitle>{editing ? 'Eintrag ändern' : 'Neuer Eintrag'}</SectionTitle>

        <View style={{ gap: spacing.xs }}>
          <Body muted style={{ fontSize: 13, fontWeight: '600' }}>
            Art
          </Body>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            {types.map((type) => (
              <Button
                key={type}
                label={type}
                variant={draft.type === type ? 'primary' : 'secondary'}
                onPress={() => setDraft((current) => ({ ...current, type }))}
                style={{ paddingHorizontal: spacing.md, minWidth: 64 }}
              />
            ))}
            {!showAllTypes ? (
              <Button
                label="mehr…"
                onPress={() => setShowAllTypes(true)}
                style={{ paddingHorizontal: spacing.md }}
              />
            ) : null}
          </View>
        </View>

        <Field
          label="Name"
          value={draft.name}
          onChangeText={(name) => setDraft((current) => ({ ...current, name }))}
          placeholder="www"
          monospace
          hint={`Leer lassen für ${domain} selbst. Sonst nur die Beschriftung, ohne die Domain.`}
        />
        <Field
          label="Wert"
          value={draft.content}
          onChangeText={(content) => setDraft((current) => ({ ...current, content }))}
          placeholder={draft.type === 'A' ? '185.26.156.40' : ''}
          monospace
          multiline={draft.type === 'TXT'}
        />
        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <View style={{ flex: 1 }}>
            <Field
              label="Lebensdauer"
              value={draft.ttl}
              onChangeText={(value) => setDraft((current) => ({ ...current, ttl: value }))}
              keyboardType="numeric"
              monospace
              hint="Sekunden"
            />
          </View>
          {wantsPriority ? (
            <View style={{ flex: 1 }}>
              <Field
                label="Priorität"
                value={draft.priority}
                onChangeText={(value) => setDraft((current) => ({ ...current, priority: value }))}
                keyboardType="numeric"
                monospace
                hint="kleiner zuerst"
              />
            </View>
          ) : null}
        </View>

        {problem ? <ErrorBanner message={problem} /> : null}
        {create.error ? <ErrorBanner message={create.error} /> : null}
        {update.error ? <ErrorBanner message={update.error} /> : null}

        <Button
          label={editing ? 'Änderung speichern' : 'Eintrag anlegen'}
          variant="primary"
          onPress={submit}
          disabled={problem !== null || busy}
          loading={create.pending || update.pending}
        />
        {editing ? <Button label="Abbrechen" onPress={() => setDraft(EMPTY)} /> : null}
      </Card>

      {remove.error ? <ErrorBanner message={remove.error} /> : null}

      <SectionTitle>Einträge</SectionTitle>
      {records.loading ? (
        <Loading label="Lade Zone…" />
      ) : records.error ? (
        <ErrorBanner message={records.error} onRetry={records.refresh} />
      ) : (records.data?.records.length ?? 0) === 0 ? (
        <Card>
          <Body muted>Diese Zone ist leer.</Body>
        </Card>
      ) : (
        records.data?.records.map((record) => (
          <RecordCard
            key={record.id}
            record={record}
            domain={domain}
            busy={busy}
            onEdit={() =>
              setDraft({
                id: record.id,
                name: record.name,
                type: String(record.type),
                content: record.content,
                ttl: String(record.ttl),
                priority: record.priority === null ? '' : String(record.priority),
              })
            }
            onDelete={() => setDeleting(record)}
          />
        ))
      )}

      <ConfirmDialog
        visible={deleting !== null}
        title="Eintrag löschen"
        message={
          deleting
            ? `${deleting.type} ${deleting.name || '@'} → ${deleting.content}\n\nDNS-Änderungen wirken erst, wenn die alte Antwort überall abgelaufen ist. Das kann bis zu ${Math.round(deleting.ttl / 60)} Minuten dauern.`
            : ''
        }
        confirmLabel="Löschen"
        destructive
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (target) void remove.run({ id: target.id, domain }).catch(() => {});
        }}
        onCancel={() => setDeleting(null)}
      />

      <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
        Änderungen gehen sofort an den Registrar. Bis sie überall ankommen, vergeht die Lebensdauer
        des alten Eintrags.
      </Body>
    </ScreenScroll>
  );
}

function RecordCard({
  record,
  domain,
  busy,
  onEdit,
  onDelete,
}: {
  record: DnsRecord;
  domain: string;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const label = record.name ? `${record.name}.${domain}` : domain;

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Badge label={String(record.type)} color={theme.accent} />
        <Mono style={{ flexShrink: 1 }} numberOfLines={1}>
          {label}
        </Mono>
      </View>
      <Mono style={{ color: theme.textMuted }}>{record.content}</Mono>
      <Body muted style={{ fontSize: 12 }}>
        {record.priority !== null ? `Priorität ${record.priority} · ` : ''}
        {record.ttl} Sekunden
      </Body>
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <Button label="Ändern" onPress={onEdit} disabled={busy} style={{ flex: 1 }} />
        <Button
          label="Löschen"
          variant="danger"
          onPress={onDelete}
          disabled={busy}
          style={{ flex: 1 }}
        />
      </View>
    </Card>
  );
}
