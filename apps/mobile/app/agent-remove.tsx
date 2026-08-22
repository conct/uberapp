/**
 * Remove Uberapp from an Uberspace.
 *
 * The counterpart to the setup, and deliberately a screen rather than a
 * button: it undoes an installation on a real host, and the last thing it does
 * is delete the agent answering the request. A tap should not be able to start
 * that from a corner of the overview.
 *
 * The ending mirrors the update screen — the connection drops because the
 * agent is gone, which is success. What follows is different, though: there is
 * nothing left to reconnect to, so the account is dropped from this device too
 * and the app returns to the connection screen.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useRouter } from 'expo-router';

import { client, RpcCallError } from '../src/api/client';
import type { StreamHandle } from '../src/api/client';
import { describeError, useConnection } from '../src/api/hooks';
import { getActiveId, getToken, removeAccount } from '../src/api/storage';
import {
  Body,
  Button,
  Card,
  ConfirmDialog,
  ErrorBanner,
  OutputBlock,
  SectionTitle,
  spacing,
} from '../src/ui/components';
import { ScreenScroll } from '../src/ui/Screen';
import { useTheme } from '../src/ui/theme';

/** The agent prints this immediately before it deletes itself. */
const FAREWELL = '==> Removing the agent itself';

export default function AgentRemoveScreen() {
  const theme = useTheme();
  const router = useRouter();
  const connection = useConnection();

  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [tooOld, setTooOld] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handle = useRef<StreamHandle | null>(null);
  const buffer = useRef('');
  const sawFarewell = useRef(false);

  useEffect(() => () => handle.current?.cancel(), []);

  /** The token on the host is gone, so keeping it here would only mislead. */
  const forgetLocally = async () => {
    const active = await getActiveId();
    if (!active) return;
    const fallback = await removeAccount(active);
    if (!fallback) {
      client.disconnect();
      return;
    }
    const token = await getToken(fallback.id);
    if (token) client.connect(fallback.url, token);
    else client.disconnect();
  };

  const start = () => {
    handle.current?.cancel();
    buffer.current = '';
    sawFarewell.current = false;
    setLines([]);
    setError(null);
    setDone(false);
    setTooOld(false);
    setRunning(true);

    handle.current = client.stream(
      'system.uninstall',
      undefined,
      (_stream, data) => {
        buffer.current += data;
        const parts = buffer.current.split('\n');
        buffer.current = parts.pop() ?? '';
        if (parts.some((line) => line.includes(FAREWELL))) sawFarewell.current = true;
        if (parts.length > 0) setLines((previous) => [...previous, ...parts].slice(-300));
      },
      (err) => {
        setRunning(false);
        if (buffer.current) {
          const tail = buffer.current;
          buffer.current = '';
          setLines((previous) => [...previous, tail]);
        }

        if (sawFarewell.current) {
          setDone(true);
          void forgetLocally();
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
        <SectionTitle>Uberapp vom Host entfernen</SectionTitle>
        <Body muted>
          Entfernt genau das, was die Einrichtung angelegt hat: die beiden Dienste samt
          .ini-Dateien, die Web-Backends, die Unterdomain mit ihrer Web-Ansicht, das Token und das
          Verzeichnis <Body>~/uberapp</Body>.
        </Body>
        <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
          Deine eigenen Dienste, Domains und Dateien bleiben unangetastet — der Uberspace selbst
          natürlich auch. Rückgängig machen geht nur durch eine neue Einrichtung über SSH.
        </Body>
        <Button
          label={running ? 'Läuft…' : 'Uberapp entfernen'}
          variant="danger"
          onPress={() => setConfirmOpen(true)}
          disabled={running || done}
          loading={running}
        />
      </Card>

      {/*
        Reachable without failing first. The way out used to live only inside
        the card below, which appears after the call has been refused — so
        somebody who knew their agent was too old still had to provoke an
        error to be shown the door. Quiet, and only while the louder version
        is not on screen, so there is one route at a time.
      */}
      {!tooOld && !done ? (
        <Card>
          <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
            Entfernen setzt einen Agenten voraus, der es beherrscht. Ältere Fassungen können sich
            zuerst selbst aktualisieren — ohne SSH und ohne Passwort.
          </Body>
          <Link href="/agent-update" asChild>
            <Button label="Agent aktualisieren" onPress={() => {}} />
          </Link>
        </Card>
      ) : null}

      {tooOld ? (
        <Card>
          <SectionTitle>Der Agent kennt diesen Aufruf noch nicht</SectionTitle>
          <Body muted>
            Auf dem Host läuft eine Fassung, die älter ist als das Entfernen. Sie kann sich aber
            selbst aktualisieren — danach geht es hier weiter.
          </Body>
          {/*
            Without this the card was a dead end with advice in it. The way out
            is one screen away and needs no password, so it belongs here as a
            button rather than as a sentence telling somebody to go and find it.
          */}
          <Link href="/agent-update" asChild>
            <Button label="Agent aktualisieren" variant="primary" onPress={() => {}} />
          </Link>
        </Card>
      ) : null}

      {error ? <ErrorBanner message={error} /> : null}

      {done ? (
        <Card>
          <SectionTitle>Entfernt</SectionTitle>
          <Body muted>
            Der Agent hat sich zuletzt selbst abgeräumt, deshalb ist die Verbindung weg. Der Zugang
            wurde auch von diesem Gerät entfernt, denn sein Token gibt es auf dem Host nicht mehr.
          </Body>
          <Button
            label="Zur Einrichtung"
            variant="primary"
            onPress={() => router.replace('/connect')}
          />
        </Card>
      ) : null}

      {lines.length > 0 ? <OutputBlock text={lines.join('\n')} /> : null}

      <ConfirmDialog
        visible={confirmOpen}
        title="Uberapp entfernen"
        message={
          `Auf ${connection.session?.host ?? 'dem Host'} werden die beiden Uberapp-Dienste, ihre ` +
          'Konfiguration, die Web-Backends, die Unterdomain, das Token und ~/uberapp gelöscht. ' +
          'Deine eigenen Dienste bleiben. Das lässt sich von hier aus nicht zurücknehmen.'
        }
        confirmLabel="Entfernen"
        destructive
        onConfirm={() => {
          setConfirmOpen(false);
          start();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </ScreenScroll>
  );
}
