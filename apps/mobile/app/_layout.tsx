import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { NavigationBar } from 'expo-navigation-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useColorScheme } from 'react-native';

import { client } from '../src/api/client';
import { listAccounts, loadCredentials } from '../src/api/storage';
import { AppBar } from '../src/ui/AppBar';
import { Loading } from '../src/ui/components';
import { useTheme } from '../src/ui/theme';

export default function RootLayout() {
  const theme = useTheme();
  const scheme = useColorScheme();
  const router = useRouter();
  const [restored, setRestored] = useState(false);

  // Reconnect with the stored credentials on cold start, before any screen
  // fires a call; otherwise every tab would show a spurious "not connected".
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [accounts, credentials] = await Promise.all([listAccounts(), loadCredentials()]);
      if (cancelled) return;

      // Start reconnecting to the account that was last active, so that by the
      // time a tile is tapped the session is usually already up.
      if (credentials) client.connect(credentials.url, credentials.token);
      setRestored(true);

      // The app opens on one of two things: the first-time setup when this
      // device knows no Uberspace, or the tiles to choose between the ones it
      // does. Landing straight in the tabs would again leave no way to reach
      // the other accounts.
      router.replace(accounts.length === 0 ? '/connect' : '/accounts');
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!restored) {
    return (
      // No <NavigationBar> here on purpose: this branch lasts a moment, and
      // mounting one only to swap it for the one below makes the bar hide,
      // unhide and hide again. Each of those is a call into the activity, and
      // if the activity is going away — a reload, a restart — the call is
      // rejected with nothing to catch it.
      <View style={{ flex: 1, backgroundColor: theme.bg, justifyContent: 'center' }}>
        <Loading label="Verbindung wird wiederhergestellt…" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      {/*
        Android draws edge-to-edge by default since SDK 54, so the system
        navigation bar sits on top of the content and the tab bar has to keep
        clear of it. Hiding it gives that strip back; a swipe from the bottom
        still brings it up temporarily. Renders as null on iOS and web.
      */}
      <NavigationBar hidden />
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          /*
            The same bar the tabs carry, so a pushed screen does not change
            height, colour and padding on the way in. It brings its own back
            arrow; the stack only says whether there is anywhere to go.
          */
          header: ({ options, navigation, back }) => (
            <AppBar
              title={options.title}
              onBack={back ? () => navigation.goBack() : undefined}
            />
          ),
          contentStyle: { backgroundColor: theme.bg },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        {/*
          Both the landing screen and a destination pushed from the overview's
          "Wechseln". Keeping the header handles both: the stack shows a back
          arrow only when there is something to go back to.
        */}
        <Stack.Screen name="accounts" options={{ title: 'Uberspaces' }} />
        <Stack.Screen name="connect" options={{ title: 'Verbindung', presentation: 'modal' }} />
        <Stack.Screen name="service/[name]" options={{ title: 'Service' }} />
        <Stack.Screen name="ports" options={{ title: 'Ports' }} />
        <Stack.Screen name="deploy" options={{ title: 'Dienst anlegen' }} />
        <Stack.Screen name="backup" options={{ title: 'Backup' }} />
        <Stack.Screen name="databases" options={{ title: 'Datenbanken' }} />
        <Stack.Screen name="mail-rules" options={{ title: 'Regeln & Filter' }} />
        <Stack.Screen name="web-extras" options={{ title: 'Web-Details' }} />
        <Stack.Screen name="diagnostics" options={{ title: 'Diagnose' }} />
        <Stack.Screen name="cron" options={{ title: 'Cron' }} />
        <Stack.Screen name="pair" options={{ title: 'Gerät koppeln' }} />
        <Stack.Screen name="setup-ssh" options={{ title: 'Einfache Einrichtung' }} />
        <Stack.Screen name="agent-update" options={{ title: 'Agent aktualisieren' }} />
        <Stack.Screen name="agent-remove" options={{ title: 'Uberapp entfernen' }} />
      </Stack>
    </SafeAreaProvider>
  );
}
