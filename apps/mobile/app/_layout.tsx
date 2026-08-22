import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { NavigationBar } from 'expo-navigation-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useColorScheme } from 'react-native';

import { client } from '../src/api/client';
import { loadCredentials } from '../src/api/storage';
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
      const credentials = await loadCredentials();
      if (cancelled) return;

      if (credentials) client.connect(credentials.url, credentials.token);
      setRestored(true);
      if (!credentials) router.replace('/connect');
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!restored) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, justifyContent: 'center' }}>
        <NavigationBar hidden />
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
          headerStyle: { backgroundColor: theme.surface },
          headerTintColor: theme.text,
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: theme.bg },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
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
      </Stack>
    </SafeAreaProvider>
  );
}
