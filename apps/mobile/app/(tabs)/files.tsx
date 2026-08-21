/**
 * File browser, rooted at the home directory.
 *
 * Enough to check a deploy landed and fix a config in place — not a full file
 * manager. Uploads are deliberately absent: rsync over SSH does that better
 * than a phone ever will.
 */

import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Link } from 'expo-router';
import type { FileContent, FileEntry } from '@uberapp/protocol';

import { useMutation, useQuery } from '../../src/api/hooks';
import {
  Body,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  Field,
  Loading,
  Mono,
  SectionTitle,
  Title,
  spacing,
} from '../../src/ui/components';
import { ScreenScroll } from '../../src/ui/Screen';
import { formatBytes, useTheme } from '../../src/ui/theme';

interface Listing {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export default function FilesScreen() {
  const theme = useTheme();
  const [path, setPath] = useState('.');
  const [showHidden, setShowHidden] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<FileEntry | null>(null);
  const [newFolder, setNewFolder] = useState('');

  const listing = useQuery<Listing>('files.list', { path, hidden: showHidden });
  const remove = useMutation('files.remove', { onSuccess: () => listing.refresh() });
  const mkdir = useMutation('files.mkdir', {
    onSuccess: () => {
      setNewFolder('');
      listing.refresh();
    },
  });

  const currentPath = listing.data?.path ?? path;

  return (
    <ScreenScroll refreshing={listing.refreshing} onRefresh={listing.refresh}>
      <View style={{ gap: spacing.xs }}>
        <Title>Dateien</Title>
        <Mono style={{ color: theme.textMuted, fontSize: 12 }}>{currentPath}</Mono>
      </View>

      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <Button
          label="Nach oben"
          onPress={() => setPath(parentOf(currentPath))}
          disabled={listing.loading}
          style={{ flex: 1 }}
        />
        <Button
          label={showHidden ? 'Versteckte: an' : 'Versteckte: aus'}
          onPress={() => setShowHidden((value) => !value)}
          style={{ flex: 1 }}
        />
      </View>

      {remove.error ? <ErrorBanner message={remove.error} /> : null}
      {mkdir.error ? <ErrorBanner message={mkdir.error} /> : null}

      <Card>
        <SectionTitle>Backup</SectionTitle>
        <Body muted>
          Sieben tägliche und sieben wöchentliche Snapshots, dazu die Datenbank-Dumps — durchsuchen
          und gezielt zurückholen.
        </Body>
        <Link href="/backup" asChild>
          <Button label="Snapshots öffnen" onPress={() => {}} />
        </Link>
      </Card>

      <Card>
        {listing.loading ? (
          <Loading />
        ) : listing.error ? (
          <ErrorBanner message={listing.error} onRetry={listing.refresh} />
        ) : (listing.data?.entries.length ?? 0) === 0 ? (
          <EmptyState title="Leeres Verzeichnis" />
        ) : (
          listing.data?.entries.map((entry) => (
            <FileRow
              key={entry.path}
              entry={entry}
              onOpen={() => {
                if (entry.type === 'dir') {
                  setPath(entry.path);
                  setViewing(null);
                } else {
                  setViewing(entry.path);
                }
              }}
              onDelete={() => setToDelete(entry)}
            />
          ))
        )}
        {listing.data?.truncated ? (
          <Body muted style={{ fontSize: 12 }}>
            Sehr viele Einträge — die Liste ist gekürzt.
          </Body>
        ) : null}
      </Card>

      {viewing ? <FileViewer path={viewing} onClose={() => setViewing(null)} /> : null}

      <Card>
        <SectionTitle>Neuer Ordner</SectionTitle>
        <Field label="Name" value={newFolder} onChangeText={setNewFolder} placeholder="deploy" />
        <Button
          label="Anlegen"
          variant="primary"
          loading={mkdir.pending}
          disabled={!newFolder.trim()}
          onPress={() => {
            void mkdir.run({ path: joinPath(currentPath, newFolder.trim()) }).catch(() => {});
          }}
        />
      </Card>

      <ConfirmDialog
        visible={toDelete !== null}
        title="Löschen"
        message={
          toDelete?.type === 'dir'
            ? `Der Ordner "${toDelete.name}" wird mit seinem gesamten Inhalt gelöscht.`
            : `"${toDelete?.name}" wird gelöscht.`
        }
        confirmLabel="Löschen"
        destructive
        onConfirm={() => {
          const entry = toDelete;
          setToDelete(null);
          if (entry) {
            void remove
              .run({ path: entry.path, recursive: entry.type === 'dir' })
              .catch(() => {});
          }
        }}
        onCancel={() => setToDelete(null)}
      />
    </ScreenScroll>
  );
}

function FileRow({
  entry,
  onOpen,
  onDelete,
}: {
  entry: FileEntry;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const icon =
    entry.type === 'dir' ? 'folder' : entry.type === 'symlink' ? 'link' : 'document-text';

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          minHeight: 44,
        }}
      >
        <Ionicons
          name={icon}
          size={18}
          color={entry.type === 'dir' ? theme.accent : theme.textMuted}
        />
        <View style={{ flex: 1 }}>
          <Body style={{ flexShrink: 1 }}>{entry.name}</Body>
          <Mono style={{ color: theme.textFaint, fontSize: 11 }}>
            {entry.type === 'dir' ? entry.mode : `${formatBytes(entry.size)} · ${entry.mode}`}
          </Mono>
        </View>
      </Pressable>
      <Pressable
        onPress={onDelete}
        accessibilityRole="button"
        accessibilityLabel={`${entry.name} löschen`}
        hitSlop={8}
        style={{ padding: spacing.sm }}
      >
        <Ionicons name="trash-outline" size={18} color={theme.danger} />
      </Pressable>
    </View>
  );
}

function FileViewer({ path, onClose }: { path: string; onClose: () => void }) {
  const theme = useTheme();
  const file = useQuery<FileContent>('files.read', { path });
  const [draft, setDraft] = useState<string | null>(null);
  const [confirmSave, setConfirmSave] = useState(false);

  const save = useMutation('files.write', {
    onSuccess: () => {
      file.refresh();
      setDraft(null);
    },
  });

  const content = draft ?? file.data?.content ?? '';
  const dirty = draft !== null && draft !== file.data?.content;

  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm }}>
        {/* Not SectionTitle: it uppercases, and file names are case-sensitive. */}
        <Body style={{ fontWeight: '700', flexShrink: 1 }}>{basename(path)}</Body>
        <Pressable onPress={onClose} accessibilityRole="button" hitSlop={8}>
          <Ionicons name="close" size={20} color={theme.textMuted} />
        </Pressable>
      </View>

      {file.loading ? (
        <Loading />
      ) : file.error ? (
        <ErrorBanner message={file.error} onRetry={file.refresh} />
      ) : (
        <>
          {file.data?.truncated ? (
            <Body muted style={{ fontSize: 12 }}>
              Datei ist groß — nur der Anfang wird angezeigt. Speichern ist deshalb deaktiviert.
            </Body>
          ) : null}
          <Field
            label="Inhalt"
            value={content}
            onChangeText={setDraft}
            multiline
            monospace
          />
          {save.error ? <ErrorBanner message={save.error} /> : null}
          <Button
            label="Speichern"
            variant="primary"
            disabled={!dirty || file.data?.truncated}
            loading={save.pending}
            onPress={() => setConfirmSave(true)}
          />
        </>
      )}

      <ConfirmDialog
        visible={confirmSave}
        title="Datei speichern"
        message={`${path} wird überschrieben.`}
        confirmLabel="Speichern"
        onConfirm={() => {
          setConfirmSave(false);
          void save.run({ path, content: draft ?? '' }).catch(() => {});
        }}
        onCancel={() => setConfirmSave(false)}
      />
    </Card>
  );
}

// --- path helpers ----------------------------------------------------------
// The agent reports POSIX paths, so these stay POSIX regardless of the client
// platform.

/** Last separator, tolerating the backslashes a Windows dev host reports. */
function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
}

function parentOf(path: string): string {
  if (path === '.' || path === '/') return path;
  const index = lastSeparator(path);
  if (index <= 0) return '.';
  return path.slice(0, index);
}

function joinPath(base: string, name: string): string {
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
}

function basename(path: string): string {
  return path.slice(lastSeparator(path) + 1) || path;
}
