/**
 * The how-to that runs before the login form.
 *
 * Interactive rather than a static wall of commands: the reader types their
 * username, host and domain once, and every command below is rebuilt with
 * those values and can be copied as-is. Retyping a command by hand from a
 * phone screen is where setup instructions usually go wrong.
 *
 * Shown on first use (no stored credentials) and whenever the browser has no
 * secure key store. The security section is not a footnote here: on a desktop
 * browser the token ends up in localStorage, and someone about to paste a
 * full-access credential deserves to know that before they paste it.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';

import { Field } from './components';
import { radius, spacing, useTheme, type Theme } from './theme';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

const REPO_URL = 'https://github.com/conct/uberapp.git';
const AGENT_PORT = 8399;

// Shown in the commands until the reader fills the fields in.
const PLACEHOLDER_USER = 'dein-user';
const PLACEHOLDER_HOST = 'dein-host.uberspace.de';
const PLACEHOLDER_DOMAIN = 'uberapp.deine-domain.de';

/** Uberspace usernames are lowercase alphanumeric. */
const RE_USER = /^[a-z][a-z0-9]{0,31}$/;
const RE_HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Accept what people actually type: "stardust", "stardust.uberspace.de", or a
 * pasted "ssh://stardust.uberspace.de". A bare name gets the uberspace.de suffix,
 * because that is the only thing it can sensibly mean here.
 */
export function normalizeHost(input: string): string {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^ssh:\/\//, '')
    .replace(/\/+$/, '');
  if (!host) return '';
  return host.includes('.') ? host : `${host}.uberspace.de`;
}

export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

export function OnboardingOverlay({
  visible,
  onDismiss,
  insecureStorage,
  onApplyUrl,
}: {
  visible: boolean;
  onDismiss: () => void;
  /** Render the storage warning. Only true on a desktop browser. */
  insecureStorage: boolean;
  /** Hand the finished agent address to the login form. */
  onApplyUrl?: (url: string) => void;
}) {
  const theme = useTheme();

  const [user, setUser] = useState('');
  const [host, setHost] = useState('');
  const [domain, setDomain] = useState('');

  const values = useMemo(() => {
    const cleanUser = user.trim().toLowerCase();
    const cleanHost = normalizeHost(host);
    const cleanDomain = normalizeDomain(domain);
    return {
      user: cleanUser,
      host: cleanHost,
      domain: cleanDomain,
      // What actually goes into the commands.
      shownUser: cleanUser || PLACEHOLDER_USER,
      shownHost: cleanHost || PLACEHOLDER_HOST,
      shownDomain: cleanDomain || PLACEHOLDER_DOMAIN,
      complete: Boolean(cleanUser && cleanHost),
    };
  }, [user, host, domain]);

  const userError = values.user && !RE_USER.test(values.user) ? 'Nur Kleinbuchstaben und Ziffern' : null;
  const hostError = values.host && !RE_HOSTNAME.test(values.host) ? 'Kein gültiger Hostname' : null;
  const domainError =
    values.domain && !RE_HOSTNAME.test(values.domain) ? 'Kein gültiger Domainname' : null;

  const agentUrl = `https://${values.shownDomain}`;

  const installCommand = [
    `ssh ${values.shownUser}@${values.shownHost}`,
    `git clone ${REPO_URL} ~/uberapp && cd ~/uberapp`,
    'bash packages/agent/deploy/install.sh',
  ].join('\n');

  const exposeCommand = [
    `uberspace web domain add ${values.shownDomain}`,
    `uberspace web backend set ${values.shownDomain}/ --http --port ${AGENT_PORT}`,
  ].join('\n');

  const testCommand = `curl ${agentUrl}/healthz`;

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
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
          >
            <Text style={{ color: theme.textMuted, fontSize: 15, lineHeight: 22 }}>
              Diese App steuert deinen Uberspace nicht per SSH, sondern über einen kleinen Agenten,
              der dort läuft. Trag unten deine Daten ein — die Befehle passen sich an und lassen
              sich direkt kopieren.
            </Text>

            <View
              style={{
                backgroundColor: theme.surfaceAlt,
                borderRadius: radius.md,
                padding: spacing.lg,
                gap: spacing.md,
              }}
            >
              <Text style={{ color: theme.text, fontSize: 15, fontWeight: '700' }}>Deine Daten</Text>

              <Field
                label="Benutzername"
                value={user}
                onChangeText={setUser}
                placeholder={PLACEHOLDER_USER}
                error={userError}
              />
              <Field
                label="Host"
                value={host}
                onChangeText={setHost}
                placeholder="stardust"
                error={hostError}
                hint={
                  values.host && values.host !== host.trim().toLowerCase()
                    ? `Wird zu ${values.host}`
                    : 'Kurzform reicht — .uberspace.de wird ergänzt.'
                }
              />
              <Field
                label="Domain für den Agenten"
                value={domain}
                onChangeText={setDomain}
                placeholder={PLACEHOLDER_DOMAIN}
                error={domainError}
                hint="Eine eigene Subdomain ist am saubersten."
              />

              {!values.complete ? (
                <Text style={{ color: theme.textFaint, fontSize: 12 }}>
                  Solange die Felder leer sind, stehen Platzhalter in den Befehlen.
                </Text>
              ) : null}
            </View>

            <Step
              theme={theme}
              number={1}
              title="Agent auf dem Uberspace installieren"
              body="Per SSH einloggen und das Installationsskript ausführen. Es baut den Agenten, legt einen supervisord-Service an und erzeugt ein Token."
            >
              <CommandBlock theme={theme} text={installCommand} />
            </Step>

            <Step
              theme={theme}
              number={2}
              title="Von außen erreichbar machen"
              body={`Der Agent lauscht nur intern auf Port ${AGENT_PORT}. Eine Domain muss darauf zeigen — damit bekommt er auch das Let's-Encrypt-Zertifikat deines Accounts.`}
            >
              <CommandBlock theme={theme} text={exposeCommand} />
              <Text style={{ color: theme.textMuted, fontSize: 13, lineHeight: 20 }}>
                Danach prüfen, ob er antwortet. Bis das Zertifikat ausgestellt ist, dauert es ein
                paar Minuten.
              </Text>
              <CommandBlock theme={theme} text={testCommand} />
            </Step>

            <Step
              theme={theme}
              number={3}
              title="Hier verbinden"
              body={
                'Das Installationsskript zeigt am Ende das Token an. Adresse und Token unten ' +
                'eintragen. Mit "Testen" prüfst du zuerst nur die Adresse — so siehst du sofort, ' +
                'ob es an der Erreichbarkeit oder am Token liegt.'
              }
            >
              <AddressRow
                theme={theme}
                url={agentUrl}
                enabled={Boolean(values.domain) && !domainError}
                // Distinguish "nothing entered yet" from "entered but wrong";
                // telling someone to fill a field they just filled is useless.
                disabledHint={
                  values.domain
                    ? 'Die Domain ist noch nicht gültig.'
                    : 'Trag oben eine Domain ein, dann lässt sie sich übernehmen.'
                }
                onApply={() => {
                  onApplyUrl?.(values.domain);
                  onDismiss();
                }}
              />
            </Step>

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
  children,
}: {
  theme: Theme;
  number: number;
  title: string;
  body: string;
  children?: ReactNode;
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
        {children}
      </View>
    </View>
  );
}

/**
 * A command with a copy button. The text stays selectable as well, so a
 * clipboard permission prompt is never the only way to get at it.
 */
function CommandBlock({ theme, text }: { theme: Theme; text: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = async () => {
    try {
      await Clipboard.setStringAsync(text);
      setFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Some browsers refuse clipboard access; the text is selectable anyway.
      setFailed(true);
    }
  };

  return (
    <View style={{ backgroundColor: theme.mono, borderRadius: radius.sm, overflow: 'hidden' }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          padding: spacing.md,
          gap: spacing.sm,
        }}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }}>
          <Text
            selectable
            style={{ color: '#c9d1d9', fontSize: 12, fontFamily: MONO, lineHeight: 19 }}
          >
            {text}
          </Text>
        </ScrollView>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Befehl kopieren"
          onPress={() => void copy()}
          hitSlop={6}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            paddingHorizontal: spacing.sm,
            paddingVertical: 6,
            borderRadius: radius.sm,
            backgroundColor: copied ? theme.success + '33' : '#ffffff14',
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Ionicons
            name={copied ? 'checkmark' : 'copy-outline'}
            size={14}
            color={copied ? theme.success : '#c9d1d9'}
          />
          <Text
            style={{
              color: copied ? theme.success : '#c9d1d9',
              fontSize: 12,
              fontWeight: '600',
            }}
          >
            {copied ? 'Kopiert' : 'Kopieren'}
          </Text>
        </Pressable>
      </View>

      {failed ? (
        <Text
          style={{
            color: theme.warning,
            fontSize: 11,
            paddingHorizontal: spacing.md,
            paddingBottom: spacing.sm,
          }}
        >
          Kopieren wurde blockiert — der Text lässt sich aber markieren.
        </Text>
      ) : null}
    </View>
  );
}

/** Offers to carry the address over into the login form. */
function AddressRow({
  theme,
  url,
  enabled,
  disabledHint,
  onApply,
}: {
  theme: Theme;
  url: string;
  enabled: boolean;
  disabledHint: string;
  onApply: () => void;
}) {
  return (
    <View
      style={{
        borderColor: theme.border,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: radius.sm,
        padding: spacing.md,
        gap: spacing.sm,
      }}
    >
      <Text style={{ color: theme.textMuted, fontSize: 12, fontWeight: '600' }}>
        Adresse des Agenten
      </Text>
      <Text selectable style={{ color: theme.text, fontSize: 13, fontFamily: MONO }}>
        {url}
      </Text>

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !enabled }}
        onPress={enabled ? onApply : undefined}
        style={({ pressed }) => ({
          minHeight: 40,
          borderRadius: radius.sm,
          backgroundColor: theme.surfaceAlt,
          borderColor: theme.border,
          borderWidth: StyleSheet.hairlineWidth,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: enabled ? (pressed ? 0.8 : 1) : 0.5,
        })}
      >
        <Text style={{ color: theme.text, fontSize: 14, fontWeight: '600' }}>
          Ins Formular übernehmen
        </Text>
      </Pressable>

      {!enabled ? (
        <Text style={{ color: theme.textFaint, fontSize: 11 }}>{disabledHint}</Text>
      ) : null}
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
  const color = tone === 'ok' ? theme.success : tone === 'bad' ? theme.danger : theme.textMuted;

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
