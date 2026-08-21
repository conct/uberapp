/**
 * Mail rules: catch-all, spam folder, forwards and sieve filters.
 *
 * The filter part is the reason this screen exists. By hand, activating a
 * filter means compiling it with sievec and repointing a symlink, and getting
 * that wrong stops mail being sorted without any visible error. Here it is a
 * list with one entry marked active.
 */

import { useState } from 'react';
import { View } from 'react-native';
import {
  isValidEmail,
  SIEVE_TEMPLATE,
  type CatchallInfo,
  type ForwardInfo,
  type MailboxInfo,
  type SieveScript,
  type SpamfolderInfo,
} from '@uberapp/protocol';

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
  Field,
  InfoBanner,
  Loading,
  Mono,
  SectionTitle,
  Title,
  Toggle,
  spacing,
} from '../src/ui/components';
import { ScreenScroll } from '../src/ui/Screen';
import { useTheme } from '../src/ui/theme';

export default function MailRulesScreen() {
  const users = useQuery<MailboxInfo[]>('mail.users.list');
  const [mailbox, setMailbox] = useState<string | null>(null);

  const names = users.data?.map((entry) => entry.name) ?? [];
  const selected = mailbox ?? names[0] ?? null;

  return (
    <ScreenScroll refreshing={users.refreshing} onRefresh={users.refresh}>
      <View style={{ gap: spacing.xs }}>
        <Title>Regeln & Filter</Title>
        <Body muted>Catch-all, Spam, Weiterleitungen und Sieve</Body>
      </View>

      <DeliveryCard />

      {users.loading ? (
        <Loading label="Lade Postfächer…" />
      ) : users.error ? (
        <ErrorBanner message={users.error} onRetry={users.refresh} />
      ) : names.length === 0 ? (
        <Card>
          <EmptyState
            title="Keine Postfächer"
            hint="Weiterleitungen und Filter hängen an einem Postfach. Lege zuerst eins im Mail-Tab an."
          />
        </Card>
      ) : (
        <>
          <Card>
            <SectionTitle>Postfach</SectionTitle>
            <ChoiceGroup
              options={names.map((name) => ({ value: name, label: name }))}
              value={selected ?? ''}
              onChange={setMailbox}
            />
          </Card>

          {selected ? <ForwardCard mailbox={selected} /> : null}
          {selected ? <FiltersCard mailbox={selected} /> : null}
        </>
      )}
    </ScreenScroll>
  );
}

/** Catch-all and spam folder are account-wide, not per mailbox. */
function DeliveryCard() {
  const users = useQuery<MailboxInfo[]>('mail.users.list');
  const catchall = useQuery<CatchallInfo>('mail.catchall.status');
  const spam = useQuery<SpamfolderInfo>('mail.spamfolder.status');

  const [picking, setPicking] = useState(false);
  const [clearing, setClearing] = useState(false);

  const setCatchall = useMutation<{ mailbox: string }>('mail.catchall.set', {
    onSuccess: () => {
      setPicking(false);
      catchall.refresh();
    },
  });
  const delCatchall = useMutation('mail.catchall.del', { onSuccess: () => catchall.refresh() });
  const setSpam = useMutation<{ enabled: boolean }>('mail.spamfolder.set', {
    onSuccess: () => spam.refresh(),
  });

  return (
    <Card>
      <SectionTitle>Zustellung</SectionTitle>

      {catchall.error ? <ErrorBanner message={catchall.error} /> : null}
      {setCatchall.error ? <ErrorBanner message={setCatchall.error} /> : null}
      {delCatchall.error ? <ErrorBanner message={delCatchall.error} /> : null}

      <Body>
        Catch-all:{' '}
        <Body style={{ fontWeight: '700' }}>
          {catchall.loading ? '…' : (catchall.data?.mailbox ?? 'nicht gesetzt')}
        </Body>
      </Body>
      <Body muted style={{ fontSize: 12 }}>
        Nimmt alles an, wofür es kein eigenes Postfach gibt. Nach außen wird davon nichts
        weitergeleitet — das unterbindet Uberspace, um den Ruf des Servers zu schützen.
      </Body>

      {picking ? (
        <>
          <ChoiceGroup
            options={(users.data ?? []).map((entry) => ({ value: entry.name, label: entry.name }))}
            value={catchall.data?.mailbox ?? ''}
            onChange={(name) => void setCatchall.run({ mailbox: name }).catch(() => {})}
          />
          <Button label="Abbrechen" onPress={() => setPicking(false)} />
        </>
      ) : (
        <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
          <Button
            label={catchall.data?.mailbox ? 'Ändern' : 'Festlegen'}
            onPress={() => setPicking(true)}
            style={{ flexGrow: 1, flexBasis: 120 }}
          />
          {catchall.data?.mailbox ? (
            <Button
              label="Entfernen"
              variant="danger"
              onPress={() => setClearing(true)}
              style={{ flexGrow: 1, flexBasis: 120 }}
            />
          ) : null}
        </View>
      )}

      <Toggle
        label="Spam-Ordner"
        value={spam.data?.enabled ?? false}
        onValueChange={(enabled) => void setSpam.run({ enabled }).catch(() => {})}
        disabled={spam.loading || setSpam.pending}
        hint="Sortiert Nachrichten ab Bewertung 5 aus. Inhalte werden nach 30 Tagen gelöscht. Sieve-Filter brauchen das eingeschaltet."
      />
      {setSpam.error ? <ErrorBanner message={setSpam.error} /> : null}

      <ConfirmDialog
        visible={clearing}
        title="Catch-all entfernen"
        message="Danach werden Nachrichten an unbekannte Adressen abgewiesen statt eingesammelt."
        confirmLabel="Entfernen"
        destructive
        onConfirm={() => {
          setClearing(false);
          void delCatchall.run(undefined).catch(() => {});
        }}
        onCancel={() => setClearing(false)}
      />
    </Card>
  );
}

function ForwardCard({ mailbox }: { mailbox: string }) {
  const forward = useQuery<ForwardInfo>('mail.forward.list', { mailbox });
  const [target, setTarget] = useState('');
  const [clearing, setClearing] = useState(false);

  const set = useMutation<{ mailbox: string; target: string }>('mail.forward.set', {
    onSuccess: () => {
      setTarget('');
      forward.refresh();
    },
  });
  const remove = useMutation<{ mailbox: string }>('mail.forward.del', {
    onSuccess: () => forward.refresh(),
  });

  const invalid = target.length > 0 && !isValidEmail(target);

  return (
    <Card>
      <SectionTitle>Weiterleitung</SectionTitle>
      {forward.error ? <ErrorBanner message={forward.error} /> : null}
      {set.error ? <ErrorBanner message={set.error} /> : null}
      {remove.error ? <ErrorBanner message={remove.error} /> : null}

      <Body>
        {forward.loading
          ? '…'
          : forward.data?.target
            ? `${mailbox} geht an ${forward.data.target}`
            : `${mailbox} wird nicht weitergeleitet`}
      </Body>

      <Field
        label="Neues Ziel"
        value={target}
        onChangeText={setTarget}
        placeholder="post@example.com"
        keyboardType="email-address"
        error={invalid ? 'Das sieht nicht nach einer Adresse aus.' : null}
        hint="Ersetzt eine bestehende Weiterleitung. Als Spam bewertete Nachrichten werden nicht weitergeleitet."
      />

      <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
        <Button
          label="Setzen"
          variant="primary"
          onPress={() => void set.run({ mailbox, target }).catch(() => {})}
          disabled={!target || invalid || set.pending}
          loading={set.pending}
          style={{ flexGrow: 1, flexBasis: 120 }}
        />
        {forward.data?.target ? (
          <Button
            label="Aufheben"
            variant="danger"
            onPress={() => setClearing(true)}
            style={{ flexGrow: 1, flexBasis: 120 }}
          />
        ) : null}
      </View>

      <ConfirmDialog
        visible={clearing}
        title="Weiterleitung aufheben"
        message={`Nachrichten an ${mailbox} bleiben danach im Postfach liegen, sofern es eines gibt.`}
        confirmLabel="Aufheben"
        destructive
        onConfirm={() => {
          setClearing(false);
          void remove.run({ mailbox }).catch(() => {});
        }}
        onCancel={() => setClearing(false)}
      />
    </Card>
  );
}

interface SieveListing {
  scripts: SieveScript[];
  active: string | null;
}

function FiltersCard({ mailbox }: { mailbox: string }) {
  const theme = useTheme();
  const listing = useQuery<SieveListing>('mail.sieve.list', { mailbox });

  const [editing, setEditing] = useState<{ name: string; content: string } | null>(null);
  const [newName, setNewName] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  const write = useMutation<{ mailbox: string; name: string; content: string }>(
    'mail.sieve.write',
    {
      onSuccess: () => {
        setEditing(null);
        setNewName('');
        listing.refresh();
      },
    },
  );
  const activate = useMutation<{ mailbox: string; name: string }>('mail.sieve.activate', {
    onSuccess: () => listing.refresh(),
  });
  const remove = useMutation<{ mailbox: string; name: string }>('mail.sieve.del', {
    onSuccess: () => listing.refresh(),
  });
  const open = useMutation<{ mailbox: string; name: string }>('mail.sieve.read');

  const openScript = async (name: string) => {
    const data = (await open.run({ mailbox, name })) as { content: string };
    setEditing({ name, content: data.content });
  };

  return (
    <Card>
      <SectionTitle>Filter</SectionTitle>

      {listing.error ? <ErrorBanner message={listing.error} /> : null}
      {write.error ? <ErrorBanner message={write.error} /> : null}
      {activate.error ? <ErrorBanner message={activate.error} /> : null}
      {remove.error ? <ErrorBanner message={remove.error} /> : null}
      {open.error ? <ErrorBanner message={open.error} /> : null}

      {editing ? (
        <>
          <Mono style={{ fontSize: 12, color: theme.textMuted }}>{editing.name}</Mono>
          <Field
            label="Sieve"
            value={editing.content}
            onChangeText={(content) => setEditing({ ...editing, content })}
            multiline
            monospace
            hint="Wird vor dem Speichern kompiliert. Ein Filter mit Syntaxfehler wird nicht abgelegt."
          />
          <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
            <Button
              label="Speichern"
              variant="primary"
              onPress={() =>
                void write
                  .run({ mailbox, name: editing.name, content: editing.content })
                  .catch(() => {})
              }
              loading={write.pending}
              style={{ flexGrow: 1, flexBasis: 120 }}
            />
            <Button
              label="Verwerfen"
              onPress={() => setEditing(null)}
              style={{ flexGrow: 1, flexBasis: 120 }}
            />
          </View>
        </>
      ) : (
        <>
          {listing.loading ? (
            <Loading label="Lade Filter…" />
          ) : (listing.data?.scripts.length ?? 0) === 0 ? (
            <EmptyState title="Keine Filter" hint="Lege unten einen an." />
          ) : (
            listing.data?.scripts.map((script) => (
              <View key={script.name} style={{ gap: spacing.sm, paddingVertical: spacing.sm }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <Mono style={{ flex: 1, fontSize: 13 }}>{script.name}</Mono>
                  {script.active ? <Badge label="aktiv" color={theme.success} /> : null}
                </View>
                <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
                  <Button
                    label="Bearbeiten"
                    onPress={() => void openScript(script.name).catch(() => {})}
                    disabled={open.pending}
                    style={{ flexGrow: 1, flexBasis: 100 }}
                  />
                  {script.active ? null : (
                    <Button
                      label="Aktivieren"
                      variant="primary"
                      onPress={() =>
                        void activate.run({ mailbox, name: script.name }).catch(() => {})
                      }
                      style={{ flexGrow: 1, flexBasis: 100 }}
                    />
                  )}
                  {script.active ? null : (
                    <Button
                      label="Löschen"
                      variant="danger"
                      onPress={() => setDeleting(script.name)}
                      style={{ flexGrow: 1, flexBasis: 100 }}
                    />
                  )}
                </View>
              </View>
            ))
          )}

          <InfoBanner message="Es läuft immer genau ein Filter. Der Spam-Ordner muss dafür eingeschaltet sein." />

          <Field
            label="Neuer Filter"
            value={newName}
            onChangeText={setNewName}
            placeholder="privat"
            monospace
            hint="Endung .sieve wird ergänzt."
          />
          <Button
            label="Anlegen"
            onPress={() =>
              setEditing({ name: `${newName}.sieve`, content: SIEVE_TEMPLATE })
            }
            disabled={!newName}
          />
        </>
      )}

      <ConfirmDialog
        visible={deleting !== null}
        title="Filter löschen"
        message={`"${deleting}" wird entfernt. Der aktive Filter bleibt davon unberührt.`}
        confirmLabel="Löschen"
        destructive
        onConfirm={() => {
          const name = deleting;
          setDeleting(null);
          if (name) void remove.run({ mailbox, name }).catch(() => {});
        }}
        onCancel={() => setDeleting(null)}
      />
    </Card>
  );
}
