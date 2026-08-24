/**
 * Snapshots and restores.
 *
 * Uberspace keeps seven daily and seven weekly snapshots under /backup, each a
 * plain mirror of the filesystem, plus database dumps under /mysql_backup.
 * Nothing here is an `uberspace` subcommand — the manual's restore procedure is
 * an rsync line with nine flags followed by a restorecon that is easy to
 * forget, and forgetting it leaves a restored site broken under SELinux.
 *
 * Two rules shape this file:
 *   - Paths are handled as POSIX strings, never through node:path's platform
 *     default, so the agent behaves the same wherever the tests run.
 *   - A restore may only write into what the account owns. rsync would happily
 *     write anywhere the user can, and a typo should not be able to reach the
 *     rest of the home directory.
 */

import { lstat, readdir, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import type { DumpInfo, FileEntry, SnapshotInfo, SnapshotKind } from '@uberctrl/protocol';
import { isOwnDatabase, isValidSnapshot } from '@uberctrl/protocol';
import type { AgentConfig } from '../config.js';
import { runStream } from '../exec.js';
import { RpcError, type CallContext, type Handler } from '../rpc.js';
import { asObject, requireString } from '../validate.js';
import { importDump } from './db.js';

export const SNAPSHOT_ROOT = '/backup';
export const DB_BACKUP_ROOT = '/mysql_backup';

const MAX_ENTRIES = 2000;

/**
 * The flags the manual prescribes. Notably absent: --delete. A restore adds
 * back what the snapshot holds and leaves newer files alone, which is the
 * recoverable direction to be wrong in.
 */
export const RSYNC_FLAGS = [
  '--verbose',
  '--recursive',
  '--links',
  '--perms',
  '--times',
  '--hard-links',
  '--acls',
  '--xattrs',
];

// --- path handling ---------------------------------------------------------

/**
 * Validate a client-supplied absolute path.
 *
 * A ".." segment is rejected rather than normalised away: in a request it is
 * either a bug or an attempt, and neither deserves to be quietly repaired.
 * Spaces are allowed — they are legal in filenames and nothing here reaches a
 * shell.
 */
export function backupPath(value: string): string {
  if (!value.startsWith('/')) {
    throw RpcError.badRequest('path must be absolute');
  }
  if (value.includes('\0')) {
    throw RpcError.badRequest('path must not contain null bytes');
  }
  if (value.split('/').includes('..')) {
    throw RpcError.badRequest('path must not contain ".." segments');
  }
  return posix.normalize(value).replace(/\/+$/, '') || '/';
}

/** Everything the account owns and may therefore restore into. */
export function restorableRoots(config: AgentConfig): string[] {
  return [posix.normalize(config.home), `/var/www/virtual/${config.user}`];
}

export function isRestorable(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function assertRestorable(path: string, config: AgentConfig): string {
  if (!isRestorable(path, restorableRoots(config))) {
    throw RpcError.forbidden(
      `Restoring is limited to ${restorableRoots(config).join(' and ')}`,
    );
  }
  return path;
}

/** Where a live path lives inside a snapshot. */
export function snapshotPath(snapshot: string, path: string): string {
  return posix.join(SNAPSHOT_ROOT, snapshot, path);
}

function snapshotId(params: Record<string, unknown>): string {
  const value = requireString(params, 'snapshot', { maxLength: 32 });
  if (!isValidSnapshot(value)) {
    throw RpcError.badRequest('snapshot must be one of daily.0-6 or weekly.1-7');
  }
  return value;
}

// --- snapshots -------------------------------------------------------------

/** Newest first: daily.0 before daily.6, all dailies before the weeklies. */
export function sortSnapshots(snapshots: SnapshotInfo[]): SnapshotInfo[] {
  return [...snapshots].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'daily' ? -1 : 1;
    return a.index - b.index;
  });
}

export function parseSnapshotName(name: string): { kind: SnapshotKind; index: number } | null {
  if (!isValidSnapshot(name)) return null;
  const [kind, index] = name.split('.');
  return { kind: kind as SnapshotKind, index: Number(index) };
}

const snapshots: Handler = async () => {
  let names: string[];
  try {
    names = await readdir(SNAPSHOT_ROOT);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES') {
      throw RpcError.notFound(`${SNAPSHOT_ROOT} is not readable on this host`);
    }
    throw err;
  }

  const found: SnapshotInfo[] = [];
  for (const name of names) {
    const parsed = parseSnapshotName(name);
    if (!parsed) continue;
    let mtime: number | null = null;
    try {
      mtime = (await stat(posix.join(SNAPSHOT_ROOT, name))).mtimeMs;
    } catch {
      // A snapshot being rotated right now still exists as a choice.
    }
    found.push({ id: name, kind: parsed.kind, index: parsed.index, mtime });
  }

  return sortSnapshots(found);
};

// --- browsing --------------------------------------------------------------

function entryType(stats: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }) {
  if (stats.isSymbolicLink()) return 'symlink' as const;
  if (stats.isDirectory()) return 'dir' as const;
  if (stats.isFile()) return 'file' as const;
  return 'other' as const;
}

const list: Handler = async (params, ctx) => {
  const p = asObject(params);
  const snapshot = snapshotId(p);
  const path = assertRestorable(
    backupPath(requireString(p, 'path', { maxLength: 4096 })),
    ctx.config,
  );
  const source = snapshotPath(snapshot, path);

  let dirents;
  try {
    dirents = await readdir(source, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw RpcError.notFound(`${path} does not exist in ${snapshot}`);
    }
    if (code === 'ENOTDIR') throw RpcError.badRequest(`${path} is not a directory in ${snapshot}`);
    if (code === 'EACCES') throw RpcError.forbidden(`Permission denied: ${source}`);
    throw err;
  }

  const entries: FileEntry[] = [];
  for (const dirent of dirents.slice(0, MAX_ENTRIES)) {
    try {
      const stats = await lstat(posix.join(source, dirent.name));
      entries.push({
        name: dirent.name,
        // The live path, because that is what the user navigates and restores.
        path: posix.join(path, dirent.name),
        type: entryType(stats),
        size: stats.size,
        mtime: stats.mtimeMs,
        mode: (stats.mode & 0o777).toString(8).padStart(3, '0'),
      });
    } catch {
      // Broken symlink or a file mid-rotation; not worth failing the listing.
    }
  }

  entries.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name);
  });

  return { snapshot, path, source, entries, truncated: dirents.length > MAX_ENTRIES };
};

// --- restore ---------------------------------------------------------------

/**
 * rsync's trailing slash decides between "copy this directory" and "copy its
 * contents". For a directory we want the contents, for a file neither side
 * may carry one.
 */
export function rsyncPair(source: string, target: string, isDirectory: boolean) {
  return isDirectory ? { source: `${source}/`, target: `${target}/` } : { source, target };
}

async function resolvePair(snapshot: string, path: string, config: AgentConfig) {
  const source = snapshotPath(snapshot, path);

  let stats;
  try {
    stats = await stat(source);
  } catch {
    throw RpcError.notFound(`${path} does not exist in ${snapshot}`);
  }

  assertRestorable(path, config);
  return rsyncPair(source, path, stats.isDirectory());
}

const preview: Handler = async (params, ctx) => {
  const p = asObject(params);
  const snapshot = snapshotId(p);
  const path = backupPath(requireString(p, 'path', { maxLength: 4096 }));
  const pair = await resolvePair(snapshot, path, ctx.config);

  return new Promise((resolve, reject) => {
    ctx.emit('stdout', `rsync --dry-run ${pair.source} -> ${pair.target}\n`);
    const handle = runStream(
      'rsync',
      ['--dry-run', ...RSYNC_FLAGS, pair.source, pair.target],
      {
        onChunk: (stream, data) => ctx.emit(stream, data),
        onDone: (code) => resolve({ ended: true, exitCode: code }),
        onError: (err) => reject(RpcError.commandFailed(err.message)),
      },
    );
    ctx.onCancel(() => handle.cancel());
  });
};

const restore: Handler = async (params, ctx) => {
  const p = asObject(params);
  const snapshot = snapshotId(p);
  const path = backupPath(requireString(p, 'path', { maxLength: 4096 }));
  const pair = await resolvePair(snapshot, path, ctx.config);

  return new Promise((resolve, reject) => {
    ctx.emit('stdout', `rsync ${pair.source} -> ${pair.target}\n`);

    const handle = runStream('rsync', [...RSYNC_FLAGS, pair.source, pair.target], {
      onChunk: (stream, data) => ctx.emit(stream, data),
      onError: (err) => reject(RpcError.commandFailed(err.message)),
      onDone: (code) => {
        if (code !== 0) {
          resolve({ ended: true, exitCode: code });
          return;
        }
        // SELinux labels come from the target directory, not the snapshot, so
        // a restore that skips this leaves files the webserver may not read.
        ctx.emit('stdout', '\nrestorecon -R\n');
        const relabel = runStream('restorecon', ['-R', pair.target], {
          onChunk: (stream, data) => ctx.emit(stream, data),
          onDone: () => resolve({ ended: true, exitCode: 0 }),
          onError: (err) => {
            // Missing restorecon must not make a completed restore look failed.
            ctx.emit('stderr', `restorecon could not run: ${err.message}\n`);
            resolve({ ended: true, exitCode: 0 });
          },
        });
        ctx.onCancel(() => relabel.cancel());
      },
    });
    ctx.onCancel(() => handle.cancel());
  });
};

// --- database dumps --------------------------------------------------------

function dumpDir(generation: 'current' | 'old', user: string): string {
  return posix.join(DB_BACKUP_ROOT, generation, user);
}

const dbList: Handler = async (_params, ctx) => {
  const dumps: DumpInfo[] = [];
  let readable = false;

  for (const generation of ['current', 'old'] as const) {
    const dir = dumpDir(generation, ctx.config.user);
    let names: string[];
    try {
      names = await readdir(dir);
      readable = true;
    } catch {
      continue;
    }

    for (const name of names) {
      const path = posix.join(dir, name);
      try {
        const stats = await stat(path);
        if (!stats.isFile()) continue;
        dumps.push({ name, path, size: stats.size, mtime: stats.mtimeMs, generation });
      } catch {
        // Rotated away between readdir and stat.
      }
    }
  }

  if (!readable) {
    throw RpcError.notFound(`${DB_BACKUP_ROOT} is not readable on this host`);
  }

  // Newest first; "current" and "old" interleave by date, which is what the
  // user is choosing between.
  dumps.sort((a, b) => b.mtime - a.mtime);
  return dumps;
};

/**
 * A dump file must sit in this account's own backup directories. Everything
 * else is either a mistake or an attempt to read someone else's data.
 */
export function isOwnDump(path: string, user: string): boolean {
  return (['current', 'old'] as const).some((generation) =>
    path.startsWith(`${dumpDir(generation, user)}/`),
  );
}

const dbRestore: Handler = async (params, ctx) => {
  const p = asObject(params);
  const file = backupPath(requireString(p, 'file', { maxLength: 4096 }));
  const database = requireString(p, 'database', { maxLength: 64 });

  if (!isOwnDump(file, ctx.config.user)) {
    throw RpcError.forbidden(`Only dumps under ${DB_BACKUP_ROOT} for this account can be restored`);
  }
  if (!isOwnDatabase(database, ctx.config.user)) {
    throw RpcError.badRequest(
      `"${database}" is not one of this account's databases; the name must be ${ctx.config.user} or start with ${ctx.config.user}_`,
    );
  }

  try {
    await stat(file);
  } catch {
    throw RpcError.notFound(`No such dump: ${file}`);
  }

  return importDump(ctx, file, database);
};

export const backupHandlers: Record<string, Handler> = {
  'backup.snapshots': snapshots,
  'backup.list': list,
  'backup.preview': preview,
  'backup.restore': restore,
  'backup.db.list': dbList,
  'backup.db.restore': dbRestore,
};
