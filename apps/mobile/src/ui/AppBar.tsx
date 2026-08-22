/**
 * The bar across the top of every tab.
 *
 * It replaces the navigator's own header, which could only show a title. The
 * things a person reaches for most — switching Uberspace, pairing a browser,
 * looking at diagnostics — lived several screens deep, and one of them was
 * only reachable through a door labelled something else entirely.
 *
 * Rendered outside the tab navigator on purpose: one instance, identical in
 * every tab, and it does not remount when a tab changes.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Link, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useConnection } from '../api/hooks';
import { spacing } from './components';
import { useTheme, type Theme } from './theme';

/** Tab paths to the name shown; the tab bar itself is only icons plus a label. */
const TITLES: Record<string, string> = {
  '/': 'Übersicht',
  '/services': 'Services',
  '/web': 'Web',
  '/mail': 'Mail',
  '/files': 'Dateien',
};

interface QuickAction {
  href: '/accounts' | '/pair' | '/diagnostics';
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
}

/**
 * Kept short deliberately. A bar of icons that all look equally plausible is a
 * puzzle, not a shortcut — these are the three that are wanted from anywhere
 * and are otherwise buried.
 */
const ACTIONS: readonly QuickAction[] = [
  { href: '/accounts', icon: 'swap-horizontal-outline', label: 'Uberspace wechseln' },
  { href: '/pair', icon: 'qr-code-outline', label: 'Gerät koppeln' },
  { href: '/diagnostics', icon: 'medkit-outline', label: 'Diagnose' },
];

/** One dot, because the state is either fine or it is not. */
function statusColor(state: ReturnType<typeof useConnection>['state'], theme: Theme): string {
  if (state === 'ready') return theme.success;
  if (state === 'error') return theme.danger;
  return theme.warning;
}

export interface AppBarProps {
  /** Given on a pushed screen, where the route has its own name. */
  title?: string;
  /** Present when there is somewhere to go back to. */
  onBack?: () => void;
}

/**
 * Both bars are this one.
 *
 * A pushed screen gets a back arrow and its own title; a tab gets the quick
 * actions. Two components would drift apart in height, colour and padding, and
 * the seam would show every time a tab pushes a screen.
 */
export function AppBar({ title: given, onBack }: AppBarProps = {}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const connection = useConnection();

  const title = given ?? TITLES[pathname] ?? 'Uberapp';

  return (
    <View
      style={{
        paddingTop: insets.top,
        backgroundColor: theme.surface,
        borderBottomColor: theme.border,
        borderBottomWidth: StyleSheet.hairlineWidth,
      }}
    >
      <View
        style={{
          height: 52,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: spacing.lg,
          // The buttons carry their own padding out to the edge.
          paddingRight: spacing.xs,
          gap: spacing.sm,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 }}>
          {onBack ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Zurück"
              onPress={onBack}
              hitSlop={12}
              style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
            >
              <Ionicons name="chevron-back" size={24} color={theme.text} />
            </Pressable>
          ) : (
            <View
              accessibilityLabel={`Verbindung: ${connection.state}`}
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: statusColor(connection.state, theme),
              }}
            />
          )}
          <Text
            numberOfLines={1}
            style={{ color: theme.text, fontSize: 18, fontWeight: '700', flexShrink: 1 }}
          >
            {title}
          </Text>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          {(onBack ? [] : ACTIONS).map((action) => (
            <Link key={action.href} href={action.href} asChild>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={action.label}
                // 44 wide, so the targets stay reachable one-handed even
                // though the icons themselves are small.
                style={({ pressed }) => ({
                  width: 44,
                  height: 44,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed ? 0.5 : 1,
                })}
              >
                <Ionicons name={action.icon} size={21} color={theme.textMuted} />
              </Pressable>
            </Link>
          ))}
        </View>
      </View>
    </View>
  );
}
