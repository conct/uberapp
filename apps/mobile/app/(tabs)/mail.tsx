/**
 * Mail domains and mailboxes.
 *
 * Creating a mailbox is one call: name and password travel together and the
 * agent feeds them to the CLI's two password prompts. The confirmation field
 * is checked here so a typo costs nothing.
 */

import { useState } from 'react';
import { View } from 'react-native';
import { Link } from 'expo-router';
import {
  MIN_MAILBOX_PASSWORD_LENGTH,
  isValidDomain,
  isValidMailbox,
  type DomainInfo,
  type MailboxInfo,
} from '@uberapp/protocol';

import { useConnection, useMutation, useQuery } from '../../src/api/hooks';
import {
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
} from '../../src/ui/components';
import { ScreenScroll } from '../../src/ui/Screen';

export default function MailScreen() {
  const domains = useQuery<DomainInfo[]>('mail.domains.list');
  const users = useQuery<MailboxInfo[]>('mail.users.list');
  const connection = useConnection();

  const interactive = connection.session?.capabilities.includes('interactive') ?? false;

  const refresh = () => {
    domains.refresh();
    users.refresh();
  };

  return (
    <ScreenScroll refreshing={domains.refreshing} onRefresh={refresh}>
      <View style={{ gap: spacing.xs }}>
        <Body muted>Domains und Postfächer</Body>
      </View>

      {!interactive ? (
        <InfoBanner
          message={
            'Der Agent kann keine Passwörter setzen: auf dem Host fehlt ein pty-Helfer (script). ' +
            'Postfächer lassen sich anzeigen und löschen, aber nicht anlegen.'
          }
        />
      ) : null}

      <DomainsCard query={domains} onChanged={refresh} />
      <MailboxesCard query={users} onChanged={refresh} interactive={interactive} />

      <Card>
        <SectionTitle>Regeln & Filter</SectionTitle>
        <Body muted>
          Catch-all, Spam-Ordner, Weiterleitungen und Sieve-Filter — inklusive Syntaxprüfung vor
          dem Speichern.
        </Body>
        <Link href="/mail-rules" asChild>
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
  const [newDomain, setNewDomain] = useState('');
  const [toDelete, setToDelete] = useState<string | null>(null);

  const add = useMutation('mail.domains.add', { onSuccess: onChanged });
  const del = useMutation('mail.domains.del', { onSuccess: onChanged });

  const invalid = newDomain.length > 0 && !isValidDomain(newDomain.trim());

  return (
    <Card>
      <SectionTitle>Mail-Domains</SectionTitle>

      {add.error ? <ErrorBanner message={add.error} /> : null}
      {add.output ? <OutputBlock text={add.output} /> : null}
      {del.error ? <ErrorBanner message={del.error} /> : null}

      <View style={{ gap: spacing.sm }}>
        <Field
          label="Mail-Domain hinzufügen"
          value={newDomain}
          onChangeText={setNewDomain}
          placeholder="deine-domain.de"
          keyboardType="url"
          error={invalid ? 'Muss ein vollständiger Domainname sein' : null}
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
      </View>

      {query.loading ? (
        <Loading />
      ) : query.error ? (
        <ErrorBanner message={query.error} onRetry={query.refresh} />
      ) : (query.data?.length ?? 0) === 0 ? (
        <EmptyState title="Keine Mail-Domains" />
      ) : (
        query.data?.map((entry) => (
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
            <Button label="Löschen" variant="danger" onPress={() => setToDelete(entry.domain)} />
          </View>
        ))
      )}

      <ConfirmDialog
        visible={toDelete !== null}
        title="Mail-Domain löschen"
        message={`${toDelete} nimmt danach keine Mails mehr an.`}
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

function MailboxesCard({
  query,
  onChanged,
  interactive,
}: {
  query: ReturnType<typeof useQuery<MailboxInfo[]>>;
  onChanged: () => void;
  interactive: boolean;
}) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const [changing, setChanging] = useState<string | null>(null);

  const add = useMutation('mail.users.add', {
    onSuccess: () => {
      setName('');
      setPassword('');
      setConfirmation('');
      onChanged();
    },
  });
  const del = useMutation('mail.users.del', { onSuccess: onChanged });

  const nameInvalid = name.length > 0 && !isValidMailbox(name.trim());
  const passwordShort = password.length > 0 && password.length < MIN_MAILBOX_PASSWORD_LENGTH;
  const mismatch = confirmation.length > 0 && password !== confirmation;
  const canCreate =
    interactive &&
    name.trim().length > 0 &&
    !nameInvalid &&
    password.length >= MIN_MAILBOX_PASSWORD_LENGTH &&
    password === confirmation;

  return (
    <Card>
      <SectionTitle>Postfächer</SectionTitle>

      {add.error ? <ErrorBanner message={add.error} /> : null}
      {add.output ? <OutputBlock text={add.output} /> : null}
      {del.error ? <ErrorBanner message={del.error} /> : null}

      <View style={{ gap: spacing.sm }}>
        <Field
          label="Neues Postfach"
          value={name}
          onChangeText={setName}
          placeholder="post"
          error={nameInvalid ? 'Nur Buchstaben, Ziffern, Punkt, Bindestrich, Unterstrich' : null}
        />
        <Field
          label="Passwort"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          error={passwordShort ? `Mindestens ${MIN_MAILBOX_PASSWORD_LENGTH} Zeichen` : null}
          hint="Uberspace verlangt zusätzlich zxcvbn-Score 4 — nimm eine lange Passphrase."
        />
        <Field
          label="Passwort wiederholen"
          value={confirmation}
          onChangeText={setConfirmation}
          secureTextEntry
          error={mismatch ? 'Stimmt nicht überein' : null}
        />
        <Button
          label="Postfach anlegen"
          variant="primary"
          loading={add.pending}
          disabled={!canCreate}
          onPress={() => setConfirmCreate(true)}
        />
      </View>

      {query.loading ? (
        <Loading />
      ) : query.error ? (
        <ErrorBanner message={query.error} onRetry={query.refresh} />
      ) : (query.data?.length ?? 0) === 0 ? (
        <EmptyState title="Keine zusätzlichen Postfächer" />
      ) : (
        query.data?.map((entry) => (
          <View
            key={entry.name}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: spacing.sm,
            }}
          >
            <Mono style={{ flexShrink: 1 }}>{entry.name}</Mono>
            <View style={{ flexDirection: 'row', gap: spacing.xs }}>
              {interactive ? (
                <Button label="Passwort" onPress={() => setChanging(entry.name)} />
              ) : null}
              <Button label="Löschen" variant="danger" onPress={() => setToDelete(entry.name)} />
            </View>
          </View>
        ))
      )}

      <ConfirmDialog
        visible={confirmCreate}
        title="Postfach anlegen"
        message={`"${name.trim()}" wird angelegt. Bis es Mails annimmt, dauert es ein paar Minuten.`}
        confirmLabel="Anlegen"
        onConfirm={() => {
          setConfirmCreate(false);
          void add.run({ name: name.trim(), password }).catch(() => {});
        }}
        onCancel={() => setConfirmCreate(false)}
      />

      <ConfirmDialog
        visible={toDelete !== null}
        title="Postfach löschen"
        message={`"${toDelete}" und die darin gespeicherten Mails werden entfernt.`}
        confirmLabel="Löschen"
        destructive
        onConfirm={() => {
          const mailbox = toDelete;
          setToDelete(null);
          if (mailbox) void del.run({ name: mailbox }).catch(() => {});
        }}
        onCancel={() => setToDelete(null)}
      />

      {changing ? (
        <PasswordChangeDialog
          mailbox={changing}
          onClose={() => setChanging(null)}
          onChanged={onChanged}
        />
      ) : null}
    </Card>
  );
}

function PasswordChangeDialog({
  mailbox,
  onClose,
  onChanged,
}: {
  mailbox: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');

  const change = useMutation('mail.users.password', {
    onSuccess: () => {
      onChanged();
      onClose();
    },
  });

  const short = password.length > 0 && password.length < MIN_MAILBOX_PASSWORD_LENGTH;
  const mismatch = confirmation.length > 0 && password !== confirmation;
  const canSubmit = password.length >= MIN_MAILBOX_PASSWORD_LENGTH && password === confirmation;

  return (
    <Card style={{ marginTop: spacing.md }}>
      <SectionTitle>Passwort für {mailbox}</SectionTitle>
      <Field
        label="Neues Passwort"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        error={short ? `Mindestens ${MIN_MAILBOX_PASSWORD_LENGTH} Zeichen` : null}
      />
      <Field
        label="Wiederholen"
        value={confirmation}
        onChangeText={setConfirmation}
        secureTextEntry
        error={mismatch ? 'Stimmt nicht überein' : null}
      />
      {change.error ? <ErrorBanner message={change.error} /> : null}
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <Button label="Abbrechen" onPress={onClose} style={{ flex: 1 }} />
        <Button
          label="Ändern"
          variant="primary"
          loading={change.pending}
          disabled={!canSubmit}
          style={{ flex: 1 }}
          onPress={() => {
            void change.run({ name: mailbox, password }).catch(() => {});
          }}
        />
      </View>
    </Card>
  );
}
