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
import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';

import { client, httpUrl } from '../src/api/client';
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
  spacing,
  radius,
} from '../src/ui/components';
import { ConnectionStrip } from '../src/ui/Screen';
import { useTheme, type Theme } from '../src/ui/theme';

/**
 * What a tile knows about its Uberspace right now.
 *
 * `state` is the answer to "does that host still have an agent on it", asked
 * over plain HTTPS against /healthz - it needs no token and does not disturb
 * the live connection. The WebSocket state is the stronger claim (connected
 * *and* authorised), but it only ever exists for one account at a time, so a
 * tile falls back to the probe for every other one.
 *
 * Both read "verbunden" on the tile. The difference is real - an agent that
 * answers says nothing about the token here still being valid - but it is a
 * distinction two near-identical labels would communicate badly. It lives in
 * the line under the icon instead, which names either the agent version or the
 * reason nothing came back.
 */
interface Probe {
  state: 'checking' | 'up' | 'down';
  /** Agent version, once it has said so. */
  agent?: string;
  /** Why it did not answer, kept short enough for a tile. */
  reason?: string;
}

/** Long enough for a sleepy shared host, short enough not to hang a screen. */
const PROBE_TIMEOUT_MS = 8000;

async function probeAccount(url: string): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${httpUrl(url)}/healthz`, { signal: controller.signal });
    const body = (await response.json()) as { agent?: string; ok?: boolean };
    if (!body.agent) return { state: 'down', reason: 'antwortet, aber kein Agent' };
    return { state: 'up', agent: body.agent };
  } catch (err) {
    const message = (err as Error).name === 'AbortError' ? 'keine Antwort' : (err as Error).message;
    return { state: 'down', reason: message };
  } finally {
    clearTimeout(timer);
  }
}

export default function AccountsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const connection = useConnection();

  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toRemove, setToRemove] = useState<Account | null>(null);
  const [probes, setProbes] = useState<Record<string, Probe>>({});

  const load = useCallback(() => {
    void (async () => {
      const [list, active] = await Promise.all([listAccounts(), getActiveId()]);
      setAccounts(list);
      setActiveId(active);

      // Every tile is asked at once rather than one after another: they are
      // independent hosts, and a single unreachable one must not hold up the
      // answer for the rest.
      setProbes(Object.fromEntries(list.map((entry) => [entry.id, { state: 'checking' }])));
      await Promise.all(
        list.map(async (entry) => {
          const probe = await probeAccount(entry.url);
          setProbes((previous) => ({ ...previous, [entry.id]: probe }));
        }),
      );
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

  /**
   * Removing a tile takes uberCTRL off the host with it.
   *
   * It used to delete only the token here, which left both services running,
   * the backends routed and the checkout in place — with the one thing that
   * could have reached them now gone from the device. That is not a removal,
   * it is losing the key to a room you left the lights on in.
   *
   * The work happens on the removal screen rather than behind this dialog:
   * it is a sequence of steps against a real host and it ends by deleting the
   * agent serving the call, which is worth watching. That screen forgets the
   * account here once the host is clear.
   */
  const confirmRemove = async (account: Account) => {
    setError(null);
    const token = await getToken(account.id);
    if (!token) {
      // Nothing left to talk to the host with, so the local entry is all that
      // can still be removed — and it is the only thing left of it here.
      await removeAccount(account.id);
      load();
      return;
    }

    // The removal runs over this account's own connection, so it has to be the
    // one the app is holding.
    if (activeId !== account.id) {
      await setActive(account.id);
      setActiveId(account.id);
      client.connect(account.url, token);
    }
    router.push('/agent-remove');
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ConnectionStrip />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        <View style={{ gap: spacing.xs }}>
          <Body muted>
            {accounts === null
              ? 'Wird geladen…'
              : accounts.length === 1
                ? 'Ein Zugang auf diesem Gerät.'
                : `${accounts.length} Zugänge auf diesem Gerät.`}
          </Body>
          {accounts && accounts.length > 0 ? (
            <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
              Das Symbol zeigt beim aktiven Zugang die laufende Verbindung, bei den übrigen, ob ihr
              Agent auf eine Anfrage antwortet. Die Zeile darunter nennt die Fassung oder den Grund.
            </Body>
          ) : null}
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
                probe={probes[account.id]}
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
            Zum Entfernen eine Kachel gedrückt halten. Das räumt uberCTRL auch auf dem Host ab —
            deine eigenen Dienste dort bleiben unangetastet.
          </Body>
        ) : null}
      </ScrollView>

      <ConfirmDialog
        visible={toRemove !== null}
        title="Zugang entfernen"
        message={
          toRemove
            ? `Auf ${toRemove.label} werden die beiden uberCTRL-Dienste, ihre Konfiguration, die Web-Backends, die Unterdomain, das Token und ~/uberctrl gelöscht — und der Zugang danach von diesem Gerät. Deine eigenen Dienste bleiben.`
            : ''
        }
        confirmLabel="Weiter"
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
  probe,
  theme,
  onPress,
  onLongPress,
}: {
  account: Account;
  active: boolean;
  state: ReturnType<typeof useConnection>['state'];
  probe: Probe | undefined;
  theme: Theme;
  onPress: () => void;
  onLongPress: () => void;
}) {
  // Only the active tile gets words, and they name the thing that sets it
  // apart: it is the one the app is talking through. The others carry an icon
  // for whether their host answers at all - a narrower question, and one that
  // would read the same on every tile if it were spelled out.
  const status = active
    ? state === 'ready'
      ? { icon: 'wifi' as const, label: 'Aktiv', color: theme.success }
      : state === 'error'
        ? { icon: 'wifi-off' as const, label: 'Nicht verbunden', color: theme.danger }
        : { icon: 'wifi-find' as const, label: 'Verbindet…', color: theme.warning }
    : probe?.state === 'up'
      ? { icon: 'wifi' as const, label: null, color: theme.success }
      : probe?.state === 'down'
        ? { icon: 'wifi-off' as const, label: null, color: theme.danger }
        : { icon: 'wifi-find' as const, label: null, color: theme.warning };

  // Under the badge, the detail that says *why* - a version proves an agent is
  // really there, and a reason turns "nicht erreichbar" into something to act on.
  const detail =
    probe?.state === 'up'
      ? `Agent v${probe.agent}`
      : probe?.state === 'down'
        ? probe.reason
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
      <View style={{ gap: 2 }}>
        {/*
          The icon is on every tile — it is the part that can be read at a
          glance across the grid. The active one adds the word beside it, in
          the pill the rest of the app uses for a status, because that tile is
          the only one where "which of these am I talking through" needs an
          answer in writing.
        */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <MaterialIcons name={status.icon} size={15} color={status.color} />
          {status.label ? <Badge label={status.label} color={status.color} /> : null}
        </View>
        {detail ? (
          <Mono style={{ fontSize: 10, color: theme.textFaint }} numberOfLines={1}>
            {detail}
          </Mono>
        ) : null}
      </View>
    </Pressable>
  );
}
