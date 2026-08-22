/**
 * Cron editor.
 *
 * The crontab is still one text file on the host — this reads it, shows each
 * job as a line you can read and switch off, and writes the whole file back.
 * Anything the parser does not recognise round-trips untouched, so editing one
 * job never rewrites someone's carefully commented crontab.
 *
 * There is deliberately no "run this now" button: that would mean a method
 * that executes an arbitrary command line, which is exactly what the rest of
 * this protocol is built to avoid.
 */

import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { describeSchedule, parseCrontab, serializeCrontab, type CronLine } from '@uberapp/protocol';

import { useMutation, useQuery } from '../src/api/hooks';
import {
  Badge,
  Body,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  Field,
  InfoBanner,
  Loading,
  Mono,
  SectionTitle,
  Toggle,
  spacing,
} from '../src/ui/components';
import { ScreenScroll } from '../src/ui/Screen';
import { useTheme } from '../src/ui/theme';

export default function CronScreen() {
  const theme = useTheme();
  const crontab = useQuery<{ content: string; exists: boolean }>('system.cron.list');

  const [lines, setLines] = useState<CronLine[] | null>(null);
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState('');
  const [saving, setSaving] = useState(false);

  const save = useMutation<{ content: string }>('system.cron.set', {
    onSuccess: () => crontab.refresh(),
  });

  // Reset the working copy whenever the server's version changes underneath.
  const loaded = crontab.data?.content;
  useEffect(() => {
    if (loaded === undefined) return;
    setLines(parseCrontab(loaded));
    setRawText(loaded);
  }, [loaded]);

  const jobs = lines?.filter((line) => line.kind === 'job') ?? [];
  const envs = lines?.filter((line) => line.kind === 'env') ?? [];
  const content = raw ? rawText : lines ? serializeCrontab(lines) : '';
  const dirty = loaded !== undefined && content !== loaded;

  const toggle = (index: number, enabled: boolean) => {
    setLines((current) =>
      current?.map((line, i) => (i === index ? { ...line, enabled } : line)) ?? null,
    );
  };

  return (
    <ScreenScroll refreshing={crontab.refreshing} onRefresh={crontab.refresh}>
      <View style={{ gap: spacing.xs }}>
        <Body muted>Geplante Aufgaben deines Uberspace</Body>
      </View>

      {crontab.error ? <ErrorBanner message={crontab.error} onRetry={crontab.refresh} /> : null}
      {save.error ? <ErrorBanner message={save.error} /> : null}

      {crontab.loading ? (
        <Loading label="Lade crontab…" />
      ) : raw ? (
        <Card>
          <SectionTitle>Rohtext</SectionTitle>
          <Field label="crontab" value={rawText} onChangeText={setRawText} multiline monospace />
          <Button label="Zur Liste zurück" onPress={() => setRaw(false)} />
        </Card>
      ) : (
        <>
          <Card>
            <SectionTitle>Aufgaben</SectionTitle>
            {jobs.length === 0 ? (
              <EmptyState
                title="Keine Aufgaben"
                hint="Im Rohtext lässt sich die erste Zeile anlegen."
              />
            ) : (
              lines?.map((line, index) =>
                line.kind !== 'job' ? null : (
                  <View key={index} style={{ gap: 4, paddingVertical: spacing.sm }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                      <Mono style={{ fontSize: 12, color: theme.accent }}>{line.schedule}</Mono>
                      {describeSchedule(line.schedule) ? (
                        <Badge label={describeSchedule(line.schedule) ?? ''} color={theme.textFaint} />
                      ) : null}
                    </View>
                    <Mono
                      style={{
                        fontSize: 12,
                        color: line.enabled ? theme.text : theme.textFaint,
                      }}
                      numberOfLines={2}
                    >
                      {line.command}
                    </Mono>
                    <Toggle
                      label={line.enabled ? 'Aktiv' : 'Ausgeschaltet'}
                      value={line.enabled}
                      onValueChange={(enabled) => toggle(index, enabled)}
                    />
                  </View>
                ),
              )
            )}
          </Card>

          {envs.length > 0 ? (
            <Card>
              <SectionTitle>Umgebung</SectionTitle>
              {envs.map((line, index) => (
                <Mono key={index} style={{ fontSize: 12 }}>
                  {line.command}
                </Mono>
              ))}
            </Card>
          ) : null}

          <InfoBanner message="Cron liest weder .bashrc noch .bash_profile. Ohne vollständigen Pfad im Befehl oder ein gesetztes PATH findet der Job sein Programm nicht." />

          <Card>
            <SectionTitle>Bearbeiten</SectionTitle>
            <Body muted style={{ fontSize: 13 }}>
              Zeilen, die hier nicht als Aufgabe erscheinen — Kommentare, eigene Formatierung —
              bleiben beim Speichern unverändert erhalten.
            </Body>
            <Button label="Rohtext bearbeiten" onPress={() => setRaw(true)} />
          </Card>
        </>
      )}

      <Button
        label={dirty ? 'Speichern' : 'Keine Änderungen'}
        variant="primary"
        onPress={() => setSaving(true)}
        disabled={!dirty || save.pending}
        loading={save.pending}
      />

      <ConfirmDialog
        visible={saving}
        title="Crontab speichern"
        message="Die komplette crontab wird ersetzt. Ausgeschaltete Aufgaben bleiben als kommentierte Zeilen erhalten."
        confirmLabel="Speichern"
        onConfirm={() => {
          setSaving(false);
          void save.run({ content }).catch(() => {});
        }}
        onCancel={() => setSaving(false)}
      />
    </ScreenScroll>
  );
}
