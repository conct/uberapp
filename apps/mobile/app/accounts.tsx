/**
 * The Uberspaces this device knows, as a grid to pick from.
 *
 * Until now the app held exactly one address and one token under fixed keys,
 * and the only route to the connection screen appeared while *not* connected.
 * So a second account could only replace the first, and signing out was
 * unreachable the moment a connection succeeded. This screen is the way back
 * in: it is reachable while connected, and switching is a tap.
 *
 * Tapping a tile connects to it. Removing one is deliberately not a tap —
 * it deletes a token that cannot be recovered from here, only re-issued on the
 * host — so it sits behind a long press and a confirmation.
 */

import { useCallback, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { client } from '../src/api/client';
import { useConnection } from '../src/api/hooks';
import {
  getActiveId,
  getToken,
  listAccounts,
  removeAccount,
  setActive,
  type Account,
} from '../src/api/storage';
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
  SectionTitle,
  Title,
  spacing,
  radius,
} from '../src/ui/components';
import { ConnectionStrip } from '../src/ui/Screen';
import { useTheme, type Theme } from '../src/ui/theme';

export default function AccountsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const connection = useConnection();

  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toRemove, setToRemove] = useState<Account | null>(null);

  const load = useCallback(() => {
    void (async () => {
      const [list, active] = await Promise.all([listAccounts(), getActiveId()]);
      setAccounts(list);
      setActiveId(active);
    })();
  }, []);

  // Re-read on every visit: the connection screen may have added one while
  // this screen was mounted but in the background.
  useFocusEffect(load);

  const switchTo = async (account: Account) => {
    setError(null);
    const token = await getToken(account.id);
    if (!token) {
      setError(
        `Für ${account.label} ist kein Token mehr hinterlegt. Richte den Zugang neu ein.`,
      );
      return;
    }
    await setActive(account.id);
    setActiveId(account.id);
    client.connect(account.url, token);
    router.replace('/');
  };

  const confirmRemove = async (account: Account) => {
    const fallback = await removeAccount(account.id);
    load();

    // Only the connection to the account that just went away is stale.
    if (activeId !== account.id) return;

    if (!fallback) {
      client.disconnect();
      router.replace('/connect');
      return;
    }

    const token = await getToken(fallback.id);
    if (token) client.connect(fallback.url, token);
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ConnectionStrip />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        <View style={{ gap: spacing.xs }}>
          <Title>Uberspaces</Title>
          <Body muted>
            {accounts === null
              ? 'Wird geladen…'
              : accounts.length === 1
                ? 'Ein Zugang auf diesem Gerät.'
                : `${accounts.length} Zugänge auf diesem Gerät.`}
          </Body>
        </View>

        {error ? <ErrorBanner message={error} /> : null}

        {accounts === null ? (
          <Loading />
        ) : accounts.length === 0 ? (
          <Card>
            <EmptyState
              title="Noch kein Zugang"
              hint="Richte einen Uberspace ein, dann erscheint er hier."
            />
          </Card>
        ) : (
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: spacing.md,
            }}
          >
            {accounts.map((account) => (
              <AccountTile
                key={account.id}
                account={account}
                active={account.id === activeId}
                state={account.id === activeId ? connection.state : 'idle'}
                theme={theme}
                onPress={() => void switchTo(account)}
                onLongPress={() => setToRemove(account)}
              />
            ))}
          </View>
        )}

        <Card>
          <SectionTitle>Hinzufügen</SectionTitle>
          <Body muted>
            Ein weiterer Uberspace kommt über dieselbe Einrichtung wie der erste — per SSH, oder
            mit Adresse und Token.
          </Body>
          <Button
            label="Uberspace hinzufügen"
            variant="primary"
            // Explicitly a new one: the connection screen otherwise fills
            // itself with the account already stored, which here would mean
            // saving over the existing one instead of adding beside it.
            onPress={() => router.push({ pathname: '/connect', params: { mode: 'new' } })}
          />
        </Card>

        {accounts && accounts.length > 0 ? (
          <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
            Zum Entfernen eine Kachel gedrückt halten. Das löscht nur das Token auf diesem Gerät —
            der Agent auf dem Host läuft weiter.
          </Body>
        ) : null}
      </ScrollView>

      <ConfirmDialog
        visible={toRemove !== null}
        title="Zugang entfernen"
        message={
          toRemove
            ? `${toRemove.label} wird von diesem Gerät entfernt und das Token gelöscht. Der Agent auf dem Host bleibt unberührt — du kannst den Zugang später neu einrichten.`
            : ''
        }
        confirmLabel="Entfernen"
        destructive
        onConfirm={() => {
          const account = toRemove;
          setToRemove(null);
          if (account) void confirmRemove(account);
        }}
        onCancel={() => setToRemove(null)}
      />
    </View>
  );
}

function AccountTile({
  account,
  active,
  state,
  theme,
  onPress,
  onLongPress,
}: {
  account: Account;
  active: boolean;
  state: ReturnType<typeof useConnection>['state'];
  theme: Theme;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const status = active
    ? state === 'ready'
      ? { label: 'verbunden', color: theme.success }
      : state === 'error'
        ? { label: 'Fehler', color: theme.danger }
        : { label: 'verbindet…', color: theme.warning }
    : null;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${account.label}, ${account.url}${active ? ', aktiv' : ''}`}
      style={({ pressed }) => ({
        // Two per row, with the gap between them taken out of the width.
        width: '47%',
        flexGrow: 1,
        minHeight: 108,
        justifyContent: 'space-between',
        gap: spacing.sm,
        padding: spacing.md,
        borderRadius: radius.md,
        backgroundColor: theme.surface,
        borderWidth: active ? 2 : 1,
        borderColor: active ? theme.accent : theme.border,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <View style={{ gap: 2 }}>
        <Body style={{ fontWeight: '700' }} numberOfLines={1}>
          {account.label}
        </Body>
        <Mono style={{ fontSize: 11, color: theme.textFaint }} numberOfLines={2}>
          {account.url}
        </Mono>
      </View>
      {status ? (
        <View style={{ flexDirection: 'row' }}>
          <Badge label={status.label} color={status.color} />
        </View>
      ) : null}
    </Pressable>
  );
}
