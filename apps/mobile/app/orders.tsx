/**
 * The orders, and which of them need somebody.
 *
 * A list sorted by date would bury the one thing that matters — an order where
 * money arrived and nothing was delivered — under thirty finished ones. So the
 * ones needing attention come first, then everything still moving, then the
 * closed ones.
 *
 * The button at the top runs the catch-up pass by hand. The agent runs it every
 * quarter of an hour anyway; this is for the moment somebody is looking at an
 * order they think is wrong and does not want to wait.
 */

import { useState } from 'react';
import { View } from 'react-native';
import {
  formatMoney,
  ORDER_STATE_LABELS,
  orderIsFinished,
  orderNeedsAttention,
  type OrderRecord,
  type OrderState,
} from '@uberapp/protocol';

import { useConnection, useMutation, useQuery } from '../src/api/hooks';
import {
  Badge,
  Body,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  InfoBanner,
  KeyValue,
  Loading,
  Mono,
  SectionTitle,
  spacing,
} from '../src/ui/components';
import { ScreenScroll } from '../src/ui/Screen';
import { useTheme, type Theme } from '../src/ui/theme';

interface SweepReport {
  checked: number;
  recovered: number;
  cancelled: number;
  resolved: number;
  attention: string[];
  notes: string[];
}

function stateColor(state: OrderState, theme: Theme): string {
  if (state === 'refund_due') return theme.danger;
  if (state === 'completed') return theme.success;
  if (state === 'cancelled' || state === 'refunded') return theme.textMuted;
  return theme.warning;
}

/** Attention first, then in flight, then done. Within a group, newest first. */
function rank(order: OrderRecord): number {
  if (orderNeedsAttention(order.state)) return 0;
  if (!orderIsFinished(order.state)) return 1;
  return 2;
}

export default function OrdersScreen() {
  const theme = useTheme();
  const connection = useConnection();
  const canSell = connection.session?.capabilities.includes('payments') ?? false;

  const orders = useQuery<{ orders: OrderRecord[] }>('orders.list', undefined, {
    enabled: canSell,
  });
  const [report, setReport] = useState<SweepReport | null>(null);

  const runSweep = useMutation('orders.sweep', {
    onSuccess: (data) => {
      setReport((data as { sweep: SweepReport }).sweep);
      orders.refresh();
    },
  });

  if (connection.state === 'ready' && !canSell) {
    return (
      <ScreenScroll>
        <Card>
          <EmptyState
            title="Nichts zu verkaufen"
            hint="Auf diesem Host ist kein Zahlungsanbieter hinterlegt, deshalb gibt es hier auch keine Bestellungen."
          />
        </Card>
      </ScreenScroll>
    );
  }

  const sorted = [...(orders.data?.orders ?? [])].sort(
    (a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt),
  );
  const needing = sorted.filter((order) => orderNeedsAttention(order.state));

  return (
    <ScreenScroll refreshing={orders.refreshing} onRefresh={orders.refresh}>
      <Card>
        <SectionTitle>Abgleich</SectionTitle>
        <Body muted>
          Fragt bei Stripe, PayPal und beim Registrar nach, was wirklich passiert ist, und schreibt
          das Ergebnis in die Bestellungen. Der Agent macht das ohnehin alle 15 Minuten.
        </Body>
        <Button
          label="Jetzt abgleichen"
          onPress={() => void runSweep.run({}).catch(() => {})}
          loading={runSweep.pending}
          disabled={runSweep.pending}
        />
        {runSweep.error ? <ErrorBanner message={runSweep.error} /> : null}
        {report ? (
          <View style={{ gap: spacing.xs }}>
            <Body>
              {report.checked} geprüft · {report.recovered} nachträglich bezahlt · {report.resolved}{' '}
              geklärt · {report.cancelled} verfallen
            </Body>
            {report.notes.map((note, index) => (
              <Body key={index} muted style={{ fontSize: 12 }}>
                {note}
              </Body>
            ))}
          </View>
        ) : null}
      </Card>

      {needing.length > 0 ? (
        <InfoBanner
          message={
            needing.length === 1
              ? 'Eine Bestellung wurde bezahlt, aber nicht geliefert. Das Geld gehört zurück.'
              : `${needing.length} Bestellungen wurden bezahlt, aber nicht geliefert. Das Geld gehört zurück.`
          }
        />
      ) : null}

      {orders.loading ? (
        <Loading label="Lade Bestellungen…" />
      ) : orders.error ? (
        <ErrorBanner message={orders.error} onRetry={orders.refresh} />
      ) : sorted.length === 0 ? (
        <Card>
          <Body muted>Noch keine Bestellung.</Body>
        </Card>
      ) : (
        sorted.map((order) => <OrderCard key={order.id} order={order} />)
      )}

      <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
        Rückzahlungen macht die App nicht — die laufen beim Zahlungsanbieter, und sie sind eine
        Entscheidung, keine Automatik.
      </Body>
    </ScreenScroll>
  );
}

function OrderCard({ order }: { order: OrderRecord }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const created = new Date(order.createdAt);
  const last = order.history[order.history.length - 1];

  return (
    <Card
      style={
        orderNeedsAttention(order.state) ? { borderColor: theme.danger + '66' } : undefined
      }
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Mono style={{ flexShrink: 1 }} numberOfLines={1}>
          {order.domain}
        </Mono>
        <Badge label={ORDER_STATE_LABELS[order.state]} color={stateColor(order.state, theme)} />
      </View>

      <Body muted style={{ fontSize: 13 }}>
        {order.action === 'transfer' ? 'Umzug' : 'Registrierung'} ·{' '}
        {formatMoney(order.amountCents, order.currency)} ·{' '}
        {order.provider === 'paypal' ? 'PayPal' : 'Karte'}
      </Body>

      {last?.note ? (
        <Body style={{ fontSize: 13, color: theme.textMuted }}>{last.note}</Body>
      ) : null}

      <Button
        label={open ? 'Weniger' : 'Verlauf'}
        onPress={() => setOpen((current) => !current)}
      />

      {open ? (
        <View style={{ gap: spacing.xs }}>
          <KeyValue label="Angelegt" value={created.toLocaleString('de-DE')} />
          <KeyValue
            label="Einkauf"
            value={formatMoney(order.registrarCostCents, order.registrarCurrency)}
          />
          {order.email ? <KeyValue label="E-Mail" value={order.email} /> : null}
          {order.reference ? <KeyValue label="Beleg" value={order.reference} /> : null}
          <View style={{ gap: spacing.xs, marginTop: spacing.xs }}>
            {order.history.map((entry, index) => (
              <Body key={index} muted style={{ fontSize: 12 }}>
                {new Date(entry.at).toLocaleString('de-DE')} — {ORDER_STATE_LABELS[entry.state]}
                {entry.note ? `: ${entry.note}` : ''}
              </Body>
            ))}
          </View>
        </View>
      ) : null}
    </Card>
  );
}
