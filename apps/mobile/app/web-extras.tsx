/**
 * Certificates, headers, error page and the docroot repair.
 *
 * The certificate part is the reason this screen is worth opening: Uberspace
 * renews for you but restarts nothing, so a service that read the files at
 * startup keeps serving an expired certificate. Picking services here hands
 * that chore to the agent.
 */

import { useState } from 'react';
import { View } from 'react-native';
import {
  CERT_RENEWAL_DAYS,
  isValidHeaderName,
  isValidHeaderValue,
  type CertInfo,
  type CertWatchConfig,
  type HeaderInfo,
  type ServiceInfo,
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
  Field,
  InfoBanner,
  Loading,
  Mono,
  OutputBlock,
  SectionTitle,
  Title,
  Toggle,
  spacing,
} from '../src/ui/components';
import { ScreenScroll } from '../src/ui/Screen';
import { useTheme, type Theme } from '../src/ui/theme';

export default function WebExtrasScreen() {
  return (
    <ScreenScroll>
      <View style={{ gap: spacing.xs }}>
        <Title>Web-Details</Title>
        <Body muted>Zertifikate, Header, Fehlerseite und Rechte</Body>
      </View>

      <CertificatesCard />
      <HeadersCard />
      <ErrorpageCard />
      <PermissionsCard />
    </ScreenScroll>
  );
}

function CertificatesCard() {
  const theme = useTheme();
  const certs = useQuery<CertInfo[]>('web.certs.list');
  const watch = useQuery<CertWatchConfig>('web.certs.watch.get');
  const services = useQuery<ServiceInfo[]>('services.list');

  const save = useMutation<{ services: string[] }>('web.certs.watch.set', {
    onSuccess: () => watch.refresh(),
  });

  const watched = new Set(watch.data?.services ?? []);

  const toggle = (name: string, on: boolean) => {
    const next = new Set(watched);
    if (on) next.add(name);
    else next.delete(name);
    void save.run({ services: [...next] }).catch(() => {});
  };

  return (
    <Card>
      <SectionTitle>Zertifikate</SectionTitle>
      {certs.error ? <ErrorBanner message={certs.error} onRetry={certs.refresh} /> : null}

      {certs.loading ? (
        <Loading label="Lade Zertifikate…" />
      ) : (certs.data?.length ?? 0) === 0 ? (
        <EmptyState
          title="Keine Zertifikate"
          hint="Sie entstehen automatisch, sobald eine Domain zum ersten Mal aufgerufen wird."
        />
      ) : (
        certs.data?.map((cert) => (
          <View
            key={cert.path}
            style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}
          >
            <Body style={{ flex: 1 }} numberOfLines={1}>
              {cert.domain}
            </Body>
            <Badge label={certLabel(cert)} color={certColor(cert, theme)} />
          </View>
        ))
      )}

      <InfoBanner
        message={`Uberspace erneuert automatisch, etwa ${CERT_RENEWAL_DAYS} Tage vor Ablauf. Eigene Dienste, die das Zertifikat beim Start einlesen, müssen danach neu gestartet werden — dafür ist die Liste unten da.`}
      />

      <SectionTitle>Nach Erneuerung neu starten</SectionTitle>
      {save.error ? <ErrorBanner message={save.error} /> : null}
      {watch.data?.lastRestart ? (
        <Body muted style={{ fontSize: 12 }}>
          Zuletzt ausgelöst am {new Date(watch.data.lastRestart).toLocaleDateString()}.
        </Body>
      ) : null}

      {services.loading ? (
        <Loading />
      ) : (services.data?.length ?? 0) === 0 ? (
        <Body muted>Keine Dienste vorhanden.</Body>
      ) : (
        services.data?.map((service) => (
          <Toggle
            key={service.name}
            label={service.name}
            value={watched.has(service.name)}
            onValueChange={(on) => toggle(service.name, on)}
            disabled={save.pending || watch.loading}
          />
        ))
      )}
    </Card>
  );
}

function certLabel(cert: CertInfo): string {
  if (cert.daysLeft === null) return 'nicht lesbar';
  if (cert.daysLeft < 0) return 'abgelaufen';
  return `${cert.daysLeft} Tage`;
}

function certColor(cert: CertInfo, theme: Theme): string {
  if (cert.daysLeft === null) return theme.textFaint;
  if (cert.daysLeft < 0) return theme.danger;
  if (cert.daysLeft < 14) return theme.warning;
  return theme.success;
}

function HeadersCard() {
  const theme = useTheme();
  const headers = useQuery<HeaderInfo[]>('web.headers.list');

  const [path, setPath] = useState('/');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [pending, setPending] = useState<null | { kind: 'del' | 'suppress'; header: HeaderInfo }>(
    null,
  );

  const set = useMutation<{ path: string; name: string; value: string }>('web.headers.set', {
    onSuccess: () => {
      setName('');
      setValue('');
      headers.refresh();
    },
  });
  const suppress = useMutation<{ path: string; name: string }>('web.headers.suppress', {
    onSuccess: () => headers.refresh(),
  });
  const remove = useMutation<{ path: string; name: string }>('web.headers.del', {
    onSuccess: () => headers.refresh(),
  });

  const nameBad = name.length > 0 && !isValidHeaderName(name);
  const valueBad = value.length > 0 && !isValidHeaderValue(value);

  return (
    <Card>
      <SectionTitle>HTTP-Header</SectionTitle>
      {headers.error ? <ErrorBanner message={headers.error} onRetry={headers.refresh} /> : null}
      {set.error ? <ErrorBanner message={set.error} /> : null}
      {suppress.error ? <ErrorBanner message={suppress.error} /> : null}
      {remove.error ? <ErrorBanner message={remove.error} /> : null}

      {headers.loading ? (
        <Loading />
      ) : (
        headers.data?.map((header) => (
          <View key={`${header.target}-${header.name}`} style={{ gap: 2, paddingVertical: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <Mono style={{ flex: 1, fontSize: 12 }}>{header.name}</Mono>
              {header.isDefault ? <Badge label="Standard" color={theme.textFaint} /> : null}
              <Button
                label={header.isDefault ? 'Unterdrücken' : 'Löschen'}
                variant={header.isDefault ? 'secondary' : 'danger'}
                onPress={() =>
                  setPending({ kind: header.isDefault ? 'suppress' : 'del', header })
                }
              />
            </View>
            <Mono style={{ fontSize: 11, color: theme.textFaint }}>
              {header.target || 'alle Domains'} · {header.value}
            </Mono>
          </View>
        ))
      )}

      <Field
        label="Pfad oder Domain"
        value={path}
        onChangeText={setPath}
        monospace
        hint="/ für alles, /blog für einen Unterpfad, example.com/ für eine Domain."
      />
      <Field
        label="Name"
        value={name}
        onChangeText={setName}
        placeholder="X-Robots-Tag"
        monospace
        error={nameBad ? 'Kein gültiger Header-Name.' : null}
      />
      <Field
        label="Wert"
        value={value}
        onChangeText={setValue}
        placeholder="noindex"
        monospace
        error={valueBad ? 'Der Wert muss einzeilig sein.' : null}
      />
      <Button
        label="Header setzen"
        variant="primary"
        onPress={() => void set.run({ path, name, value }).catch(() => {})}
        disabled={!name || !value || nameBad || valueBad || set.pending}
        loading={set.pending}
      />

      <ConfirmDialog
        visible={pending !== null}
        title={pending?.kind === 'suppress' ? 'Header unterdrücken' : 'Header löschen'}
        message={
          pending?.kind === 'suppress'
            ? `"${pending.header.name}" ist ein Sicherheits-Standard von Uberspace. Unterdrückt gilt er für ${pending.header.target || 'diesen Pfad'} nicht mehr.`
            : `"${pending?.header.name}" wird für ${pending?.header.target || 'diesen Pfad'} entfernt.`
        }
        confirmLabel={pending?.kind === 'suppress' ? 'Unterdrücken' : 'Löschen'}
        destructive
        onConfirm={() => {
          const target = pending;
          setPending(null);
          if (!target) return;
          const args = { path: target.header.target || '/', name: target.header.name };
          const action = target.kind === 'suppress' ? suppress : remove;
          void action.run(args).catch(() => {});
        }}
        onCancel={() => setPending(null)}
      />
    </Card>
  );
}

function ErrorpageCard() {
  const status = useQuery<{ enabled: boolean; raw: string }>('web.errorpage.status', { code: 500 });
  const set = useMutation<{ code: number; enabled: boolean }>('web.errorpage.set', {
    onSuccess: () => status.refresh(),
  });

  return (
    <Card>
      <SectionTitle>Fehlerseite 500</SectionTitle>
      {status.error ? <ErrorBanner message={status.error} onRetry={status.refresh} /> : null}
      {set.error ? <ErrorBanner message={set.error} /> : null}
      <Toggle
        label="Uberspace-Fehlerseite"
        value={status.data?.enabled ?? true}
        onValueChange={(enabled) => void set.run({ code: 500, enabled }).catch(() => {})}
        disabled={status.loading || set.pending}
        hint="Aus geschaltet zeigt der Browser die Fehlerausgabe deiner Anwendung. Praktisch beim Debuggen, unschön im Betrieb."
      />
    </Card>
  );
}

function PermissionsCard() {
  const connection = useConnection();
  const user = connection.session?.user ?? 'isabell';
  const [path, setPath] = useState(`/var/www/virtual/${user}/html`);
  const [asking, setAsking] = useState(false);

  const fix = useMutation<{ path: string }>('web.docroot.fixPermissions');

  return (
    <Card>
      <SectionTitle>Rechte reparieren</SectionTitle>
      <Body muted style={{ fontSize: 13 }}>
        Setzt Lese- und Ausführungsrechte für den Webserver und erneuert die SELinux-Kennzeichnung.
        Das ist die übliche Antwort auf „hochgeladen, aber der Server liefert 403".
      </Body>
      <Field label="Pfad" value={path} onChangeText={setPath} monospace />
      {fix.error ? <ErrorBanner message={fix.error} /> : null}
      {fix.output ? <OutputBlock text={fix.output} /> : null}
      <Button
        label="Reparieren"
        onPress={() => setAsking(true)}
        disabled={!path || fix.pending}
        loading={fix.pending}
      />

      <ConfirmDialog
        visible={asking}
        title="Rechte reparieren"
        message={`chmod -R u=rwX,go=rX und restorecon -R für ${path}. Bestehende Sonderrechte in diesem Baum gehen dabei verloren.`}
        confirmLabel="Ausführen"
        onConfirm={() => {
          setAsking(false);
          void fix.run({ path }).catch(() => {});
        }}
        onCancel={() => setAsking(false)}
      />
    </Card>
  );
}
