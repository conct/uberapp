/**
 * Update the agent on the host, from the host.
 *
 * The alternative was a full SSH setup run for every change to the agent:
 * account password again, log in again, re-run install.sh — to fetch a commit
 * and restart a service. This asks the agent to do it to itself.
 *
 * The screen exists rather than a button on the overview because the update
 * streams a build that takes minutes, and because of the ending: the agent
 * restarts, which drops the connection this very output arrives through. That
 * is the expected outcome, not a failure, and saying so needs more room than a
 * button has. See `expected` below.
 */

import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { client } from '../src/api/client';
import { describeError, useConnection } from '../src/api/hooks';
import type { StreamHandle } from '../src/api/client';
import {
  Body,
  Button,
  Card,
  ConfirmDialog,
  ErrorBanner,
  Mono,
  OutputBlock,
  SectionTitle,
  spacing,
} from '../src/ui/components';
import { ScreenScroll } from '../src/ui/Screen';
import { useTheme } from '../src/ui/theme';

/** The agent prints this immediately before it restarts itself. */
const RESTART_MARKER = '==> Restarting';

export default function AgentUpdateScreen() {
  const theme = useTheme();
  const connection = useConnection();

  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handle = useRef<StreamHandle | null>(null);
  const buffer = useRef('');
  const sawRestart = useRef(false);

  useEffect(() => () => handle.current?.cancel(), []);

  const start = () => {
    handle.current?.cancel();
    buffer.current = '';
    sawRestart.current = false;
    setLines([]);
    setError(null);
    setRestarting(false);
    setRunning(true);

    handle.current = client.stream(
      'system.selfUpdate',
      undefined,
      (_stream, data) => {
        buffer.current += data;
        const parts = buffer.current.split('\n');
        buffer.current = parts.pop() ?? '';
        if (parts.some((line) => line.includes(RESTART_MARKER))) sawRestart.current = true;
        if (parts.length > 0) setLines((previous) => [...previous, ...parts].slice(-300));
      },
      (err) => {
        setRunning(false);
        if (buffer.current) {
          const tail = buffer.current;
          buffer.current = '';
          setLines((previous) => [...previous, tail]);
        }

        // The last thing the agent does is stop itself, so the socket carrying
        // this call dies on purpose. Once the restart notice has arrived, a
        // dropped connection is the success case — reporting it as an error
        // would call every successful update a failure.
        if (sawRestart.current) {
          setRestarting(true);
          return;
        }
        if (err) setError(describeError(err));
      },
    );
  };

  return (
    <ScreenScroll>
      <Card>
        <SectionTitle>Agent aktualisieren</SectionTitle>
        <Body muted>
          Der Agent holt sich den neuen Stand selbst, baut ihn und startet neu — ohne SSH und ohne
          dein Passwort. Er läuft aus einem git-Verzeichnis auf dem Host, und genau das wird
          aktualisiert.
        </Body>
        <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
          Dauert ein paar Minuten: Abhängigkeiten und ein vollständiger Bau auf einem geteilten
          Host. Am Ende bricht die Verbindung ab — das gehört dazu, die App verbindet sich von
          allein neu.
        </Body>
        <Button
          label={running ? 'Läuft…' : 'Jetzt aktualisieren'}
          variant="primary"
          onPress={() => setConfirmOpen(true)}
          disabled={running}
          loading={running}
        />
      </Card>

      {error ? <ErrorBanner message={error} /> : null}

      {restarting ? (
        <Card>
          <SectionTitle>Neustart läuft</SectionTitle>
          <Body muted>
            Der neue Stand ist gebaut, der Agent startet gerade neu. Sobald oben wieder „verbunden"
            steht, läuft er mit der neuen Fassung.
          </Body>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Mono style={{ fontSize: 12, color: theme.textMuted }}>
              Verbindung: {connection.state}
            </Mono>
          </View>
        </Card>
      ) : null}

      {lines.length > 0 ? <OutputBlock text={lines.join('\n')} /> : null}

      <ConfirmDialog
        visible={confirmOpen}
        title="Agent aktualisieren"
        message={
          'Der Agent holt den neuen Stand, baut ihn und startet sich neu. Laufende Aufrufe brechen ' +
          'dabei ab. Deine Dienste auf dem Host sind davon nicht betroffen.'
        }
        confirmLabel="Aktualisieren"
        onConfirm={() => {
          setConfirmOpen(false);
          start();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </ScreenScroll>
  );
}
