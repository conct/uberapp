/**
 * Overview: who we are talking to, how full the account is, and whether
 * anything is on fire.
 */

import { View } from 'react-native';
import { Link } from 'expo-router';
import type { ProcessInfo, QuotaInfo, ServiceInfo, SystemInfo } from '@uberapp/protocol';

import { useConnection, useQuery } from '../../src/api/hooks';
import {
  Badge,
  Body,
  Button,
  Card,
  ErrorBanner,
  KeyValue,
  Loading,
  Mono,
  SectionTitle,
  Title,
  spacing,
  radius,
} from '../../src/ui/components';
import { ScreenScroll } from '../../src/ui/Screen';
import { formatBytes, useTheme } from '../../src/ui/theme';

export default function OverviewScreen() {
  const theme = useTheme();
  const connection = useConnection();

  const info = useQuery<SystemInfo>('system.info');
  const quota = useQuery<QuotaInfo>('system.quota');
  const services = useQuery<ServiceInfo[]>('services.list', undefined, { pollMs: 15_000 });
  const processes = useQuery<ProcessInfo[]>('system.processes');

  const refresh = () => {
    info.refresh();
    quota.refresh();
    services.refresh();
    processes.refresh();
  };

  const running = services.data?.filter((s) => s.state === 'RUNNING').length ?? 0;
  const failing = services.data?.filter((s) => s.state === 'FATAL' || s.state === 'BACKOFF') ?? [];

  return (
    <ScreenScroll refreshing={info.refreshing} onRefresh={refresh}>
      <View style={{ gap: spacing.xs }}>
        <Title>{connection.session?.user ?? 'Uberspace'}</Title>
        <Body muted>{connection.session?.host ?? ''}</Body>
      </View>

      {failing.length > 0 ? (
        <Card style={{ borderColor: theme.danger + '66' }}>
          <SectionTitle>Achtung</SectionTitle>
          <Body>
            {failing.length === 1
              ? `Der Service "${failing[0]?.name}" läuft nicht.`
              : `${failing.length} Services laufen nicht.`}
          </Body>
          {failing.map((service) => (
            <Mono key={service.name} style={{ color: theme.danger }}>
              {service.name}: {service.description || service.state}
            </Mono>
          ))}
          <Link href="/services" asChild>
            <Button label="Zu den Services" variant="primary" onPress={() => {}} />
          </Link>
        </Card>
      ) : null}

      <Card>
        <SectionTitle>Speicher</SectionTitle>
        {quota.loading ? (
          <Loading />
        ) : quota.error ? (
          <ErrorBanner message={quota.error} onRetry={quota.refresh} />
        ) : quota.data ? (
          <QuotaBar quota={quota.data} />
        ) : null}
      </Card>

      <Card>
        <SectionTitle>Weiter</SectionTitle>
        <Link href="/databases" asChild>
          <Button label="Datenbanken" onPress={() => {}} />
        </Link>
        <Link href="/backup" asChild>
          <Button label="Backup & Wiederherstellung" onPress={() => {}} />
        </Link>
        <Link href="/cron" asChild>
          <Button label="Cron" onPress={() => {}} />
        </Link>
        <Link href="/diagnostics" asChild>
          <Button label="Diagnose" onPress={() => {}} />
        </Link>
      </Card>

      <Card>
        <SectionTitle>Services</SectionTitle>
        {services.loading ? (
          <Loading />
        ) : services.error ? (
          <ErrorBanner message={services.error} onRetry={services.refresh} />
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
              <Badge label={`${running} laufen`} color={theme.success} />
              {failing.length > 0 ? (
                <Badge label={`${failing.length} fehlerhaft`} color={theme.danger} />
              ) : null}
              <Badge label={`${services.data?.length ?? 0} gesamt`} color={theme.textMuted} />
            </View>
            {(services.data?.length ?? 0) === 0 ? (
              <Body muted>Noch keine Services eingerichtet.</Body>
            ) : null}
          </>
        )}
      </Card>

      <Card>
        <SectionTitle>System</SectionTitle>
        {info.loading ? (
          <Loading />
        ) : info.error ? (
          <ErrorBanner message={info.error} onRetry={info.refresh} />
        ) : info.data ? (
          <>
            <KeyValue label="Host-Laufzeit" value={info.data.uptime} />
            <KeyValue
              label="Last (1/5/15 min)"
              value={info.data.loadAverage.map((value) => value.toFixed(2)).join(' · ')}
            />
            <KeyValue label="Node" value={info.data.nodeVersion} />
            <KeyValue label="Agent" value={`v${info.data.agentVersion}`} />
            <Body muted style={{ fontSize: 12 }}>
              Die Last gilt für den gesamten geteilten Host, nicht nur für deinen Account.
            </Body>
          </>
        ) : null}
      </Card>

      <Card>
        <SectionTitle>Größte Prozesse</SectionTitle>
        {processes.loading ? (
          <Loading />
        ) : processes.error ? (
          <ErrorBanner message={processes.error} onRetry={processes.refresh} />
        ) : (
          (processes.data ?? []).slice(0, 5).map((process) => (
            <View key={process.pid} style={{ gap: 2 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Mono style={{ flexShrink: 1 }} >{shortenCommand(process.command)}</Mono>
                <Mono style={{ color: theme.textMuted }}>{formatBytes(process.rssKb * 1024)}</Mono>
              </View>
            </View>
          ))
        )}
        {processes.data?.length === 0 ? <Body muted>Keine Prozesse gefunden.</Body> : null}
      </Card>
    </ScreenScroll>
  );
}

function QuotaBar({ quota }: { quota: QuotaInfo }) {
  const theme = useTheme();

  if (quota.limit === null) {
    return (
      <>
        <Body muted>Kein Limit erkannt.</Body>
        <Mono style={{ color: theme.textMuted, fontSize: 11 }}>{quota.raw}</Mono>
      </>
    );
  }

  const percent = quota.percent ?? 0;
  const color = percent > 90 ? theme.danger : percent > 75 ? theme.warning : theme.success;

  return (
    <>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Body>{`${formatBytes(quota.used)} von ${formatBytes(quota.limit)}`}</Body>
        <Body style={{ color, fontWeight: '700' }}>{`${percent}%`}</Body>
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
    </>
  );
}

/** ps gives the full command line; the tail is rarely the interesting part. */
function shortenCommand(command: string): string {
  const trimmed = command.trim();
  return trimmed.length > 42 ? `${trimmed.slice(0, 42)}…` : trimmed;
}

