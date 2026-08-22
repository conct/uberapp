/**
 * Shared UI primitives. Everything is theme-aware and sized for one-handed
 * phone use: touch targets stay at or above 44pt.
 */

import { type ReactNode, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { radius, spacing, useTheme, type Theme } from './theme';

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: theme.surface,
          borderColor: theme.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: radius.md,
          padding: spacing.lg,
          gap: spacing.md,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <Text
      style={{
        color: theme.textMuted,
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0.8,
        textTransform: 'uppercase',
      }}
    >
      {children}
    </Text>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <Text style={{ color: theme.text, fontSize: 22, fontWeight: '700' }}>{children}</Text>;
}

export function Body({
  children,
  muted,
  style,
  numberOfLines,
}: {
  children: ReactNode;
  muted?: boolean;
  style?: StyleProp<TextStyle>;
  /** Truncate instead of wrapping — for filenames and other unbounded values. */
  numberOfLines?: number;
}) {
  const theme = useTheme();
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[{ color: muted ? theme.textMuted : theme.text, fontSize: 15 }, style]}
    >
      {children}
    </Text>
  );
}

export function Mono({
  children,
  style,
  numberOfLines,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  /** Truncate instead of wrapping — paths and commands are unbounded. */
  numberOfLines?: number;
}) {
  const theme = useTheme();
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        {
          color: theme.text,
          fontSize: 13,
          fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export function Badge({ label, color }: { label: string; color: string }) {
  return (
    <View
      style={{
        paddingHorizontal: spacing.sm,
        paddingVertical: 3,
        borderRadius: radius.sm,
        backgroundColor: color + '22',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: color + '55',
      }}
    >
      <Text style={{ color, fontSize: 11, fontWeight: '700', letterSpacing: 0.4 }}>{label}</Text>
    </View>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger';

export function Button({
  label,
  onPress,
  variant = 'secondary',
  disabled,
  loading,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const colors = buttonColors(variant, theme);
  const inactive = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      onPress={inactive ? undefined : onPress}
      style={({ pressed }) => [
        {
          minHeight: 44,
          paddingHorizontal: spacing.lg,
          borderRadius: radius.sm,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: spacing.sm,
          backgroundColor: colors.bg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          opacity: inactive ? 0.5 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={colors.text} /> : null}
      <Text style={{ color: colors.text, fontWeight: '600', fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

function buttonColors(variant: ButtonVariant, theme: Theme) {
  switch (variant) {
    case 'primary':
      return { bg: theme.accent, text: theme.accentText, border: theme.accent };
    case 'danger':
      return { bg: theme.danger + '18', text: theme.danger, border: theme.danger + '55' };
    default:
      return { bg: theme.surfaceAlt, text: theme.text, border: theme.border };
  }
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  autoCapitalize = 'none',
  keyboardType,
  hint,
  error,
  multiline,
  monospace,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  keyboardType?: 'default' | 'numeric' | 'email-address' | 'url';
  hint?: string;
  error?: string | null;
  multiline?: boolean;
  monospace?: boolean;
}) {
  const theme = useTheme();

  // Offered on every masked field. A password typed on a phone keyboard is
  // worth checking before it goes somewhere that answers with nothing more
  // useful than "Anmeldung abgelehnt".
  const [revealed, setRevealed] = useState(false);
  const canReveal = Boolean(secureTextEntry);

  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={{ color: theme.textMuted, fontSize: 13, fontWeight: '600' }}>{label}</Text>
      <View>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.textFaint}
          secureTextEntry={canReveal && !revealed}
          autoCapitalize={autoCapitalize}
          autoCorrect={false}
          keyboardType={keyboardType}
          multiline={multiline}
          style={{
            minHeight: multiline ? 120 : 44,
            color: theme.text,
            backgroundColor: theme.surfaceAlt,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: error ? theme.danger : theme.border,
            borderRadius: radius.sm,
            paddingHorizontal: spacing.md,
            // Room for the button, so the text never runs underneath it.
            paddingRight: canReveal ? 44 + spacing.xs : spacing.md,
            paddingVertical: spacing.sm,
            fontSize: 15,
            textAlignVertical: multiline ? 'top' : 'center',
            fontFamily: monospace
              ? Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })
              : undefined,
          }}
        />
        {canReveal ? (
          <Pressable
            onPress={() => setRevealed((shown) => !shown)}
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Passwort verbergen' : 'Passwort anzeigen'}
            style={{
              position: 'absolute',
              right: 0,
              top: 0,
              bottom: 0,
              width: 44,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons
              name={revealed ? 'eye-off-outline' : 'eye-outline'}
              size={20}
              color={theme.textMuted}
            />
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <Text style={{ color: theme.danger, fontSize: 12 }}>{error}</Text>
      ) : hint ? (
        <Text style={{ color: theme.textFaint, fontSize: 12 }}>{hint}</Text>
      ) : null}
    </View>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const theme = useTheme();
  return (
    <View
      style={{
        backgroundColor: theme.danger + '14',
        borderColor: theme.danger + '55',
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: radius.sm,
        padding: spacing.md,
        gap: spacing.sm,
      }}
    >
      <Text style={{ color: theme.danger, fontSize: 14 }}>{message}</Text>
      {onRetry ? <Button label="Erneut versuchen" onPress={onRetry} /> : null}
    </View>
  );
}

export function InfoBanner({ message }: { message: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        backgroundColor: theme.warning + '14',
        borderColor: theme.warning + '55',
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: radius.sm,
        padding: spacing.md,
      }}
    >
      <Text style={{ color: theme.warning, fontSize: 13 }}>{message}</Text>
    </View>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  const theme = useTheme();
  return (
    <View style={{ padding: spacing.xl, alignItems: 'center', gap: spacing.sm }}>
      <Text style={{ color: theme.textMuted, fontSize: 15, fontWeight: '600' }}>{title}</Text>
      {hint ? (
        <Text style={{ color: theme.textFaint, fontSize: 13, textAlign: 'center' }}>{hint}</Text>
      ) : null}
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  const theme = useTheme();
  return (
    <View style={{ padding: spacing.xl, alignItems: 'center', gap: spacing.md }}>
      <ActivityIndicator color={theme.accent} />
      {label ? <Text style={{ color: theme.textMuted, fontSize: 13 }}>{label}</Text> : null}
    </View>
  );
}

export function KeyValue({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md }}>
      <Text style={{ color: theme.textMuted, fontSize: 14 }}>{label}</Text>
      <Text style={{ color: theme.text, fontSize: 14, fontWeight: '600', flexShrink: 1 }}>
        {value}
      </Text>
    </View>
  );
}

/**
 * A confirmation sheet for destructive or state-changing actions.
 *
 * Restarting a service or deleting a domain from a phone is easy to do by
 * accident, so mutating actions route through this rather than firing on tap.
 */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = 'Bestätigen',
  destructive,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        onPress={onCancel}
        style={{
          flex: 1,
          backgroundColor: '#00000088',
          justifyContent: 'center',
          padding: spacing.xl,
        }}
      >
        <Pressable onPress={(event) => event.stopPropagation()}>
          <Card>
            <Text style={{ color: theme.text, fontSize: 17, fontWeight: '700' }}>{title}</Text>
            <Text style={{ color: theme.textMuted, fontSize: 14 }}>{message}</Text>
            <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm }}>
              <Button label="Abbrechen" onPress={onCancel} style={{ flex: 1 }} />
              <Button
                label={confirmLabel}
                variant={destructive ? 'danger' : 'primary'}
                onPress={onConfirm}
                style={{ flex: 1 }}
              />
            </View>
          </Card>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** Collapsible block for raw command output. */
export function OutputBlock({ text }: { text: string }) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const lines = text.trim().split('\n');
  const isLong = lines.length > 4;
  const shown = expanded || !isLong ? text.trim() : lines.slice(0, 4).join('\n');

  return (
    <View
      style={{
        backgroundColor: theme.mono,
        borderRadius: radius.sm,
        padding: spacing.md,
        gap: spacing.sm,
      }}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Mono style={{ color: '#c9d1d9' }}>{shown}</Mono>
      </ScrollView>
      {isLong ? (
        <Pressable onPress={() => setExpanded((value) => !value)} accessibilityRole="button">
          <Text style={{ color: theme.accent, fontSize: 12, fontWeight: '600' }}>
            {expanded ? 'Weniger anzeigen' : `Alle ${lines.length} Zeilen anzeigen`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A labelled on/off switch sized for the same rhythm as Field. */
export function Toggle({
  label,
  value,
  onValueChange,
  hint,
  disabled,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: 44,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: theme.text, fontSize: 15 }}>{label}</Text>
        {hint ? <Text style={{ color: theme.textFaint, fontSize: 12 }}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: theme.surfaceAlt, true: theme.accent }}
        thumbColor={theme.surface}
      />
    </View>
  );
}

/**
 * A vertical set of exclusive choices.
 *
 * Vertical rather than segmented because each option carries a line of
 * explanation, and on a phone that does not fit side by side.
 */
export function ChoiceGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string; hint?: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: spacing.sm }}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: spacing.md,
              minHeight: 44,
              padding: spacing.md,
              borderRadius: radius.sm,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: selected ? theme.accent : theme.border,
              backgroundColor: selected ? theme.accent + '14' : theme.surfaceAlt,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <View
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                marginTop: 2,
                borderWidth: 2,
                borderColor: selected ? theme.accent : theme.textFaint,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {selected ? (
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: theme.accent,
                  }}
                />
              ) : null}
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: theme.text, fontSize: 15, fontWeight: selected ? '600' : '400' }}>
                {option.label}
              </Text>
              {option.hint ? (
                <Text style={{ color: theme.textMuted, fontSize: 12 }}>{option.hint}</Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

export { spacing, radius };
