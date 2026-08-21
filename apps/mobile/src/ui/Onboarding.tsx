/**
 * The how-to that runs before the login form.
 *
 * Shown on first use (no stored credentials) and whenever the browser has no
 * secure key store. The security section is not a footnote here: on a desktop
 * browser the token ends up in localStorage, and someone about to paste a
 * full-access credential deserves to know that before they paste it, not after.
 */

import type { ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, Text, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { radius, spacing, useTheme, type Theme } from './theme';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export function OnboardingOverlay({
  visible,
  onDismiss,
  insecureStorage,
}: {
  visible: boolean;
  onDismiss: () => void;
  /** Render the storage warning. Only true on a desktop browser. */
  insecureStorage: boolean;
}) {
  const theme = useTheme();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <View
        style={{
          flex: 1,
          backgroundColor: '#000000bb',
          alignItems: 'center',
          justifyContent: 'center',
          padding: spacing.lg,
        }}
      >
        <View
          style={{
            width: '100%',
            maxWidth: 560,
            maxHeight: '92%',
            backgroundColor: theme.surface,
            borderColor: theme.border,
            borderWidth: StyleSheet.hairlineWidth,
            borderRadius: radius.lg,
            overflow: 'hidden',
          }}
        >
          <Header theme={theme} />

          <ScrollView
            contentContainerStyle={{ padding: spacing.xl, gap: spacing.xl }}
            showsVerticalScrollIndicator
          >
            <Text style={{ color: theme.textMuted, fontSize: 15, lineHeight: 22 }}>
              Diese App steuert deinen Uberspace nicht per SSH, sondern über einen kleinen Agenten,
              der dort läuft. Der muss einmalig eingerichtet werden — danach brauchst du nur noch
              Adresse und Token.
            </Text>

            <Step
              theme={theme}
              number={1}
              title="Agent auf dem Uberspace installieren"
              body="Per SSH einloggen und das Installationsskript ausführen. Es baut den Agenten, legt einen supervisord-Service an und erzeugt ein Token."
              command={[
                'ssh dein-user@dein-host.uberspace.de',
                'git clone https://github.com/conct/uberapp.git ~/uberapp && cd ~/uberapp',
                'bash packages/agent/deploy/install.sh',
              ].join('\n')}
            />

            <Step
              theme={theme}
              number={2}
              title="Von außen erreichbar machen"
              body="Der Agent lauscht nur intern. Eine Domain oder ein Pfad muss auf seinen Port zeigen — damit bekommt er auch das Let's-Encrypt-Zertifikat deines Accounts."
              command={[
                'uberspace web domain add uberapp.deine-domain.de',
                'uberspace web backend set uberapp.deine-domain.de/ --http --port 8399',
                '',
                '# Test:',
                'curl https://uberapp.deine-domain.de/healthz',
              ].join('\n')}
            />

            <Step
              theme={theme}
              number={3}
              title="Hier verbinden"
              body={
                'Das Installationsskript zeigt am Ende Adresse und Token an. Beides unten eintragen. ' +
                'Mit "Testen" prüfst du zuerst nur die Adresse — so siehst du sofort, ob es an der ' +
                'Erreichbarkeit oder am Token liegt.'
              }
            />

            {insecureStorage ? <StorageWarning theme={theme} /> : null}
          </ScrollView>

          <Footer theme={theme} onDismiss={onDismiss} />
        </View>
      </View>
    </Modal>
  );
}

function Header({ theme }: { theme: Theme }) {
  return (
    <View
      style={{
        backgroundColor: theme.accent,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        gap: spacing.xs,
      }}
    >
      <Text style={{ color: theme.accentText, fontSize: 20, fontWeight: '800' }}>
        Uberapp einrichten
      </Text>
      <Text style={{ color: theme.accentText, fontSize: 13, opacity: 0.85 }}>
        Drei Schritte, einmalig
      </Text>
    </View>
  );
}

function Step({
  theme,
  number,
  title,
  body,
  command,
}: {
  theme: Theme;
  number: number;
  title: string;
  body: string;
  command?: string;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: spacing.md }}>
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 14,
          backgroundColor: theme.accent,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ color: theme.accentText, fontWeight: '800', fontSize: 14 }}>{number}</Text>
      </View>

      <View style={{ flex: 1, gap: spacing.sm }}>
        <Text style={{ color: theme.text, fontSize: 16, fontWeight: '700' }}>{title}</Text>
        <Text style={{ color: theme.textMuted, fontSize: 14, lineHeight: 21 }}>{body}</Text>
        {command ? <CommandBlock theme={theme} text={command} /> : null}
      </View>
    </View>
  );
}

/** Commands are selectable so they can be copied rather than retyped. */
function CommandBlock({ theme, text }: { theme: Theme; text: string }) {
  return (
    <View style={{ backgroundColor: theme.mono, borderRadius: radius.sm, padding: spacing.md }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable style={{ color: '#c9d1d9', fontSize: 12, fontFamily: MONO, lineHeight: 19 }}>
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}

/**
 * The part that matters most on a shared machine, so it gets a full block
 * rather than a line of small print.
 */
function StorageWarning({ theme }: { theme: Theme }) {
  return (
    <View
      style={{
        backgroundColor: theme.warning + '14',
        borderColor: theme.warning + '66',
        borderWidth: 1,
        borderRadius: radius.md,
        padding: spacing.lg,
        gap: spacing.md,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Ionicons name="warning" size={22} color={theme.warning} />
        <Text style={{ color: theme.warning, fontSize: 16, fontWeight: '800', flexShrink: 1 }}>
          Dieser Browser hat keinen sicheren Schlüsselspeicher
        </Text>
      </View>

      <Text style={{ color: theme.text, fontSize: 14, lineHeight: 21 }}>
        In der Handy-App landet das Token in Keychain bzw. Keystore — verschlüsselt und vom
        Betriebssystem geschützt. Im Browser gibt es das nicht. Dort liegt es im{' '}
        <Text style={{ fontFamily: MONO, fontSize: 13 }}>localStorage</Text>: als Klartext, an die
        Adresse dieser Seite gebunden, bis es jemand löscht.
      </Text>

      <Text style={{ color: theme.text, fontSize: 14, lineHeight: 21 }}>
        Wer dieses Token hat, kann alles, was du auch könntest: Dienste stoppen, Mails umleiten,
        Dateien lesen und löschen. Es ist kein Passwort für die App, sondern ein Generalschlüssel
        für den Account.
      </Text>

      <View style={{ gap: spacing.sm }}>
        <Text style={{ color: theme.text, fontSize: 14, fontWeight: '700' }}>Was das heißt</Text>
        <Bullet theme={theme} tone="ok">
          Dein eigener Rechner, den sonst niemand benutzt: unproblematisch, weiter geht&apos;s.
        </Bullet>
        <Bullet theme={theme} tone="bad">
          Fremder, geteilter oder öffentlicher Rechner: nimm die Handy-App statt des Browsers.
        </Bullet>
        <Bullet theme={theme} tone="neutral">
          Nur kurz etwas erledigen? Danach unten auf &bdquo;Zugangsdaten löschen&ldquo; tippen — das
          entfernt das Token wieder aus diesem Browser.
        </Bullet>
      </View>

      <View style={{ gap: spacing.sm }}>
        <Text style={{ color: theme.text, fontSize: 14, fontWeight: '700' }}>
          Falls das Token doch einmal abhandenkommt
        </Text>
        <Text style={{ color: theme.textMuted, fontSize: 14, lineHeight: 21 }}>
          Ein neues erzeugen und den Agenten neu starten. Alte Tokens gelten danach nicht mehr, und
          alle Geräte müssen sich neu verbinden.
        </Text>
        <CommandBlock
          theme={theme}
          text={[
            'head -c 32 /dev/urandom | base64 | tr -d "\\n" > ~/.config/uberapp/token',
            'chmod 600 ~/.config/uberapp/token',
            'supervisorctl restart uberapp-agent',
          ].join('\n')}
        />
      </View>
    </View>
  );
}

function Bullet({
  theme,
  tone,
  children,
}: {
  theme: Theme;
  tone: 'ok' | 'bad' | 'neutral';
  children: ReactNode;
}) {
  const icon =
    tone === 'ok' ? 'checkmark-circle' : tone === 'bad' ? 'close-circle' : 'information-circle';
  const color =
    tone === 'ok' ? theme.success : tone === 'bad' ? theme.danger : theme.textMuted;

  return (
    <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' }}>
      <Ionicons name={icon} size={17} color={color} style={{ marginTop: 2 }} />
      <Text style={{ color: theme.text, fontSize: 14, lineHeight: 21, flex: 1 }}>{children}</Text>
    </View>
  );
}

function Footer({ theme, onDismiss }: { theme: Theme; onDismiss: () => void }) {
  return (
    <View
      style={{
        borderTopColor: theme.border,
        borderTopWidth: StyleSheet.hairlineWidth,
        padding: spacing.lg,
        backgroundColor: theme.surfaceAlt,
      }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onDismiss}
        style={({ pressed }) => ({
          minHeight: 48,
          borderRadius: radius.sm,
          backgroundColor: theme.accent,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Text style={{ color: theme.accentText, fontSize: 16, fontWeight: '700' }}>
          Verstanden, zur Anmeldung
        </Text>
      </Pressable>
    </View>
  );
}
