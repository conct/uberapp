/**
 * Update the agent on the host, from the host.
 *
 * The alternative was a full SSH setup run for every change to the agent:
 * account password again, log in again, re-run install.sh — to fetch a commit
 * and restart a service. This asks the agent to do it to itself.
 *
 * The screen exists rather than a button on the overview because the update
 * streams a build that takes minutes, and because of two endings that need
 * explaining: the agent restarts, dropping the connection this very output
 * arrives through — success, not failure — and an agent too old to know this
 * call at all, which is a circle only one SSH run can break. See the restart
 * handling in start() and TooOldCard.
 */

import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Link } from 'expo-router';
import type { SystemInfo } from '@uberapp/protocol';

import { client, RpcCallError } from '../src/api/client';
import { describeError, useConnection, useQuery } from '../src/api/hooks';
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
  // Set when the agent does not know this call yet - see TooOldCard.
  const [tooOld, setTooOld] = useState(false);

  const info = useQuery<SystemInfo>('system.info');

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
    setTooOld(false);
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
        if (err instanceof RpcCallError && err.code === 'unknown_method') {
          setTooOld(true);
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

      {tooOld ? <TooOldCard info={info.data ?? null} /> : null}

      {/*
        The SSH route, without having to fail into it first. It used to live
        only inside TooOldCard, which appears after the agent has refused the
        call — so the one situation where it is needed most, a host whose
        update cannot fix itself, was also the one where it stayed hidden
        until something went wrong on purpose. Quiet, and only while the
        louder version is not on screen.
      */}
      {!tooOld && !restarting ? <SshFallback info={info.data ?? null} /> : null}

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

/**
 * The bootstrap case, which cannot be avoided and should not be a dead end.
 *
 * An agent old enough to lack this call cannot install the call that would
 * have updated it. Exactly one SSH run is needed to break that circle, and
 * from then on this screen does the job. Saying so here, with the host and
 * user already filled in, is the difference between a next step and a wall.
 */
function TooOldCard({ info }: { info: SystemInfo | null }) {
  const host = info ? `${info.hostname.split('.')[0]}.uberspace.de` : undefined;

  return (
    <Card>
      <SectionTitle>Der Agent kennt diesen Aufruf noch nicht</SectionTitle>
      <Body muted>
        Auf dem Host läuft eine Fassung, die älter ist als die Selbstaktualisierung — und sie kann
        sich die Neuerung nicht selbst aufspielen. Dafür braucht es genau einmal die Einrichtung
        über SSH. Danach genügt dieser Bildschirm.
      </Body>
      <Link
        href={{ pathname: '/setup-ssh', params: { ...(host ? { host } : {}), ...(info ? { user: info.user } : {}) } }}
        asChild
      >
        <Button label="Einmalig über SSH einrichten" variant="primary" onPress={() => {}} />
      </Link>
      {info ? (
        <Body muted style={{ fontSize: 12 }}>
          {`Host und Benutzer sind vorausgefüllt (${info.user}@${host}); es fehlt nur dein SSH-Passwort.`}
        </Body>
      ) : null}
    </Card>
  );
}

/**
 * The way in that never depends on the agent.
 *
 * A self-update can leave a host it cannot repair from — a build that fails
 * never reaches the restart, so the agent that would carry the fix never runs
 * it. install.sh has no such problem: it comes over SSH, from a login shell,
 * and does not need the agent to be working at all.
 */
function SshFallback({ info }: { info: SystemInfo | null }) {
  const theme = useTheme();
  const host = info ? `${info.hostname.split('.')[0]}.uberspace.de` : undefined;

  return (
    <Card>
      <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
        Kommt die Aktualisierung nicht durch, hilft die Einrichtung über SSH: sie braucht den
        Agenten nicht und baut den Host in jedem Fall neu auf.
      </Body>
      <Link
        href={{ pathname: '/setup-ssh', params: { ...(host ? { host } : {}), ...(info ? { user: info.user } : {}) } }}
        asChild
      >
        <Button label="Über SSH einrichten" onPress={() => {}} />
      </Link>
    </Card>
  );
}
