/**
 * supervisord control: the "restart the thing from my phone" screen.
 */

import { useState } from 'react';
import { View } from 'react-native';
import { Link } from 'expo-router';
import type { ServiceAction, ServiceInfo } from '@uberapp/protocol';

import { useMutation, useQuery } from '../../src/api/hooks';
import {
  Badge,
  Body,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  Loading,
  Mono,
  OutputBlock,
  SectionTitle,
  spacing,
} from '../../src/ui/components';
import { ScreenScroll } from '../../src/ui/Screen';
import { formatDuration, serviceStateColor, useTheme } from '../../src/ui/theme';

interface PendingAction {
  name: string;
  action: ServiceAction;
}

interface DeleteStep {
  step: string;
  state: 'ok' | 'skipped' | 'failed';
  detail: string;
}

interface DeleteResult {
  name: string;
  steps: DeleteStep[];
}

/**
 * The two services the app itself depends on.
 *
 * Deleting either is allowed - they are the user's services on the user's
 * host - but the agent is what this screen is talking through, so removing it
 * ends the session mid-call and leaves SSH as the only way back. That belongs
 * in the confirmation, not in a refusal.
 */
const OWN_SERVICES = ['uberapp-agent', 'uberapp-connect'];

/** What each step of the removal did, in words rather than exit codes. */
const STEP_LABEL: Record<string, string> = {
  stop: 'Gestoppt',
  remove: 'Aus supervisord entfernt',
  config: '.ini gelöscht',
  reread: 'Neu eingelesen',
  update: 'Übernommen',
};

export default function ServicesScreen() {
  const theme = useTheme();
  const services = useQuery<ServiceInfo[]>('services.list', undefined, { pollMs: 10_000 });
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [reloadOpen, setReloadOpen] = useState(false);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const [removed, setRemoved] = useState<DeleteResult | null>(null);

  const control = useMutation<PendingAction>('services.control', {
    onSuccess: () => services.refresh(),
  });
  const reload = useMutation('services.reload', { onSuccess: () => services.refresh() });
  const remove = useMutation<{ name: string }, DeleteResult>('services.delete', {
    onSuccess: (result) => {
      setRemoved(result);
      services.refresh();
    },
  });

  const confirm = async () => {
    if (!pending) return;
    const action = pending;
    setPending(null);
    try {
      await control.run(action);
    } catch {
      // The error is rendered from control.error; nothing else to do here.
    }
  };

  return (
    <ScreenScroll refreshing={services.refreshing} onRefresh={services.refresh}>
      <View style={{ gap: spacing.xs }}>
        <Body muted>supervisord auf deinem Uberspace</Body>
      </View>

      {control.error ? <ErrorBanner message={control.error} /> : null}
      {control.output ? <OutputBlock text={control.output} /> : null}

      {remove.error ? <ErrorBanner message={remove.error} /> : null}
      {removed ? <RemovalReport result={removed} onDismiss={() => setRemoved(null)} /> : null}

      {services.loading ? (
        <Loading label="Lade Services…" />
      ) : services.error ? (
        <ErrorBanner message={services.error} onRetry={services.refresh} />
      ) : (services.data?.length ?? 0) === 0 ? (
        <Card>
          <EmptyState
            title="Keine Services"
            hint={'Lege eine .ini-Datei in ~/etc/services.d an und tippe dann auf "Neu einlesen".'}
          />
        </Card>
      ) : (
        services.data?.map((service) => (
          <ServiceCard
            key={service.name}
            service={service}
            busy={control.pending || remove.pending}
            onAction={(action) => setPending({ name: service.name, action })}
            onDelete={() => setToDelete(service.name)}
          />
        ))
      )}

      <Card>
        <SectionTitle>Neuer Dienst</SectionTitle>
        <Body muted>
          Konfiguration, Start und Erreichbarkeit in einem Ablauf — statt fünf Kommandos in der
          richtigen Reihenfolge.
        </Body>
        <Link href="/deploy" asChild>
          <Button label="Dienst anlegen" variant="primary" onPress={() => {}} />
        </Link>
      </Card>

      <Card>
        <SectionTitle>Konfiguration</SectionTitle>
        <Body muted>
          Nach dem Anlegen oder Ändern einer .ini-Datei muss supervisord sie neu einlesen
          (reread + update).
        </Body>
        <Button
          label="Neu einlesen"
          onPress={() => setReloadOpen(true)}
          loading={reload.pending}
        />
        {reload.error ? <ErrorBanner message={reload.error} /> : null}
        {reload.output ? <OutputBlock text={reload.output} /> : null}
      </Card>

      <Card>
        <SectionTitle>Firewall</SectionTitle>
        <Body muted>
          Dienste, die direkt von außen erreichbar sein sollen, brauchen einen freigegebenen Port.
        </Body>
        <Link href="/ports" asChild>
          <Button label="Ports verwalten" onPress={() => {}} />
        </Link>
      </Card>

      <ConfirmDialog
        visible={pending !== null}
        title={actionTitle(pending?.action)}
        message={
          pending
            ? `"${pending.name}" wirklich ${actionVerb(pending.action)}?`
            : ''
        }
        confirmLabel={actionTitle(pending?.action)}
        destructive={pending?.action === 'stop'}
        onConfirm={() => void confirm()}
        onCancel={() => setPending(null)}
      />

      <ConfirmDialog
        visible={toDelete !== null}
        title="Dienst löschen"
        message={
          toDelete
            ? `"${toDelete}" wird gestoppt, aus supervisord entfernt und die .ini gelöscht. ` +
              (OWN_SERVICES.includes(toDelete)
                ? 'Achtung: daran hängt diese App. Nach dem Löschen kommst du nur noch per SSH an den Host.'
                : 'Das lässt sich von hier aus nicht rückgängig machen.')
            : ''
        }
        confirmLabel="Löschen"
        destructive
        onConfirm={() => {
          const name = toDelete;
          setToDelete(null);
          setRemoved(null);
          if (name) void remove.run({ name }).catch(() => {});
        }}
        onCancel={() => setToDelete(null)}
      />

      <ConfirmDialog
        visible={reloadOpen}
        title="Neu einlesen"
        message="supervisorctl reread und update ausführen. Neue Services werden dabei gestartet."
        confirmLabel="Ausführen"
        onConfirm={() => {
          setReloadOpen(false);
          void reload.run(undefined).catch(() => {});
        }}
        onCancel={() => setReloadOpen(false)}
      />
    </ScreenScroll>
  );
}

function ServiceCard({
  service,
  busy,
  onAction,
  onDelete,
}: {
  service: ServiceInfo;
  busy: boolean;
  onAction: (action: ServiceAction) => void;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const color = serviceStateColor(service.state, theme);
  const isRunning = service.state === 'RUNNING';

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
        <Body style={{ fontWeight: '700', flexShrink: 1 }}>{service.name}</Body>
        <Badge label={service.state} color={color} />
      </View>

      <View style={{ gap: 2 }}>
        {service.pid !== null ? (
          <Mono style={{ color: theme.textMuted, fontSize: 12 }}>
            PID {service.pid} · läuft seit {formatDuration(service.uptimeSeconds)}
          </Mono>
        ) : (
          <Mono style={{ color: theme.textMuted, fontSize: 12 }}>
            {service.description || 'gestoppt'}
          </Mono>
        )}
      </View>

      <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
        <Button
          label="Neustart"
          variant="primary"
          onPress={() => onAction('restart')}
          disabled={busy}
          style={{ flexGrow: 1, flexBasis: 100 }}
        />
        {isRunning ? (
          <Button
            label="Stoppen"
            variant="danger"
            onPress={() => onAction('stop')}
            disabled={busy}
            style={{ flexGrow: 1, flexBasis: 100 }}
          />
        ) : (
          <Button
            label="Starten"
            onPress={() => onAction('start')}
            disabled={busy}
            style={{ flexGrow: 1, flexBasis: 100 }}
          />
        )}
      </View>

      <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
        <Link
          href={{ pathname: '/service/[name]', params: { name: service.name } }}
          asChild
          style={{ flexGrow: 1, flexBasis: 140 }}
        >
          <Button label="Logs & Konfiguration" onPress={() => {}} />
        </Link>
        <Button
          label="Löschen"
          variant="danger"
          onPress={onDelete}
          disabled={busy}
          style={{ flexGrow: 1, flexBasis: 100 }}
        />
      </View>
    </Card>
  );
}

/**
 * What the removal actually did, step by step.
 *
 * A single "done" would hide the part worth seeing: which steps had nothing
 * left to do. Somebody who stopped the service by hand last week should see
 * that the stop was skipped rather than wonder whether it ran.
 */
function RemovalReport({
  result,
  onDismiss,
}: {
  result: DeleteResult;
  onDismiss: () => void;
}) {
  const theme = useTheme();

  return (
    <Card>
      <SectionTitle>{`"${result.name}" ist entfernt`}</SectionTitle>
      <View style={{ gap: spacing.xs }}>
        {result.steps.map((entry) => (
          <View
            key={entry.step}
            style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}
          >
            <Badge
              label={entry.state === 'skipped' ? 'war schon' : 'ok'}
              color={entry.state === 'skipped' ? theme.textFaint : theme.success}
            />
            <Body style={{ flexShrink: 1 }}>{STEP_LABEL[entry.step] ?? entry.step}</Body>
          </View>
        ))}
      </View>
      <Button label="Ausblenden" onPress={onDismiss} />
    </Card>
  );
}

function actionTitle(action: ServiceAction | undefined): string {
  switch (action) {
    case 'start':
      return 'Starten';
    case 'stop':
      return 'Stoppen';
    default:
      return 'Neustart';
  }
}

function actionVerb(action: ServiceAction): string {
  switch (action) {
    case 'start':
      return 'starten';
    case 'stop':
      return 'stoppen';
    default:
      return 'neu starten';
  }
}
