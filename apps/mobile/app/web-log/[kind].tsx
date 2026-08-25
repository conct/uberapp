/**
 * Reading one of the three web logs as it fills.
 *
 * The Web tab could already switch a log on and off and say where it lives —
 * and then left you with a path you cannot open, on a host you may have no
 * shell on. `web.log.tail` had been in the agent the whole time with nothing
 * calling it; `useLogStream` was only ever pointed at service logs.
 *
 * Enabling a log does not make it appear: apache writes the file on the next
 * request. A tail against a file that is not there yet fails with notFound, so
 * that case says what to do rather than showing an empty box.
 */

import { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import type { WebLogKind } from '@uberctrl/protocol';

import { useLogStream } from '../../src/api/hooks';
import {
  Badge,
  Body,
  Button,
  ErrorBanner,
  Mono,
  spacing,
  radius,
} from '../../src/ui/components';
import { ConnectionStrip } from '../../src/ui/Screen';
import { useTheme } from '../../src/ui/theme';

const LABELS: Record<string, string> = {
  access: 'Zugriffe',
  apache_error: 'Apache-Fehler',
  php_error: 'PHP-Fehler',
};

export default function WebLogScreen() {
  const theme = useTheme();
  const { kind } = useLocalSearchParams<{ kind: string }>();
  const logKind = String(kind ?? '') as WebLogKind;

  const { lines, error, active } = useLogStream('web.log.tail', { kind: logKind });

  const scrollRef = useRef<ScrollView>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (follow) scrollRef.current?.scrollToEnd({ animated: false });
  }, [lines, follow]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Stack.Screen options={{ title: LABELS[logKind] ?? 'Web-Log' }} />
      <ConnectionStrip />

      <View
        style={{
          flex: 1,
          padding: spacing.lg,
          gap: spacing.sm,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Body muted style={{ flex: 1, fontSize: 13 }}>
            Die letzten 200 Zeilen, danach live.
          </Body>
          <Badge label={active ? 'live' : 'aus'} color={active ? theme.success : theme.textFaint} />
        </View>

        {error ? <ErrorBanner message={error} /> : null}

        <ScrollView
          ref={scrollRef}
          style={{ flex: 1, backgroundColor: theme.mono, borderRadius: radius.sm }}
          contentContainerStyle={{ padding: spacing.md }}
          onScrollBeginDrag={() => setFollow(false)}
        >
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View>
              {lines.length === 0 ? (
                <Mono style={{ color: '#8b949e' }}>
                  {active ? 'Warte auf den nächsten Zugriff…' : 'Keine Ausgabe.'}
                </Mono>
              ) : (
                lines.map((line, index) => (
                  <Mono key={`${index}-${line.slice(0, 16)}`} style={{ color: '#c9d1d9' }}>
                    {line || ' '}
                  </Mono>
                ))
              )}
            </View>
          </ScrollView>
        </ScrollView>

        {!follow ? (
          <Button
            label="Zum Ende springen"
            onPress={() => {
              setFollow(true);
              scrollRef.current?.scrollToEnd({ animated: true });
            }}
          />
        ) : null}
      </View>
    </View>
  );
}
