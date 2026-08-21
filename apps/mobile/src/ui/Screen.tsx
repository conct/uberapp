/**
 * Screen shell: connection gate, pull-to-refresh and a live status strip.
 *
 * Every tab is a live view of the server, so each one needs the same answer to
 * "what if we are not connected right now" — this puts that in one place.
 */

import type { ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';

import { useConnection } from '../api/hooks';
import { Button, EmptyState, Loading, spacing } from './components';
import { useTheme } from './theme';

export function ConnectionStrip() {
  const theme = useTheme();
  const connection = useConnection();

  if (connection.state === 'ready') return null;

  const message =
    connection.state === 'reconnecting'
      ? `Verbindung verloren — neuer Versuch (${connection.attempt}.)…`
      : connection.state === 'connecting' || connection.state === 'authenticating'
        ? 'Verbinde…'
        : (connection.error ?? 'Nicht verbunden');

  const color = connection.state === 'error' ? theme.danger : theme.warning;

  return (
    <View
      style={{
        backgroundColor: color + '18',
        borderBottomColor: color + '44',
        borderBottomWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
      }}
    >
      <Text style={{ color, fontSize: 12, fontWeight: '600' }}>{message}</Text>
    </View>
  );
}

export function ScreenScroll({
  children,
  refreshing,
  onRefresh,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const theme = useTheme();
  const connection = useConnection();

  if (connection.state === 'idle' || connection.state === 'error') {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        <ConnectionStrip />
        <View style={{ flex: 1, justifyContent: 'center', padding: spacing.lg }}>
          <EmptyState
            title="Nicht verbunden"
            hint={connection.error ?? 'Hinterlege Adresse und Token des Agenten.'}
          />
          <Link href="/connect" asChild>
            <Button label="Verbindung einrichten" variant="primary" onPress={() => {}} />
          </Link>
        </View>
      </View>
    );
  }

  if (connection.state !== 'ready' && connection.attempt === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        <ConnectionStrip />
        <Loading label="Verbinde mit dem Agenten…" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ConnectionStrip />
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xl }}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={!!refreshing}
              onRefresh={onRefresh}
              tintColor={theme.textMuted}
            />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
    </View>
  );
}
