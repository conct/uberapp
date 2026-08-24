/**
 * File browsing and editing, confined to the configured root (the home
 * directory by default).
 *
 * Confinement is enforced on the *resolved* path: we resolve symlinks on the
 * nearest existing ancestor before deciding, so a symlink inside the root that
 * points outside it cannot be used to step out.
 */

import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FileEntry } from '@uberctrl/protocol';
import { RpcError, type CallContext, type Handler } from '../rpc.js';
import { asObject, optionalBoolean, requireString } from '../validate.js';

const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 2000;

/**
 * Turn a client-supplied path into an absolute path guaranteed to sit inside
 * the root, or throw.
 */
async function safePath(ctx: CallContext, input: string): Promise<string> {
  if (input.includes('\0')) throw RpcError.badRequest('Path must not contain null bytes');

  const root = await realpath(ctx.config.fileRoot);
  // A relative path is taken relative to the root, not the process cwd.
  const absolute = isAbsolute(input) ? resolve(input) : resolve(root, input);

  // Resolve symlinks on the deepest ancestor that exists; the tail may not
  // exist yet (files.write, files.mkdir).
  let existing = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(existing);
      if (parent === existing) throw RpcError.badRequest(`Cannot resolve path: ${input}`);
      tail.unshift(existing.slice(parent.length + 1));
      existing = parent;
    }
  }

  const resolved = tail.length > 0 ? join(existing, ...tail) : existing;
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw RpcError.forbidden(`Path is outside the allowed root: ${input}`);
  }
  return resolved;
}

function entryType(stats: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }) {
  if (stats.isSymbolicLink()) return 'symlink' as const;
  if (stats.isDirectory()) return 'dir' as const;
  if (stats.isFile()) return 'file' as const;
  return 'other' as const;
}

const list: Handler = async (params, ctx) => {
  const p = asObject(params);
  const path = await safePath(ctx, requireString(p, 'path', { maxLength: 4096 }));
  const showHidden = optionalBoolean(p, 'hidden');

  let dirents;
  try {
    dirents = await readdir(path, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw RpcError.notFound(`No such directory: ${path}`);
    if (code === 'ENOTDIR') throw RpcError.badRequest(`Not a directory: ${path}`);
    if (code === 'EACCES') throw RpcError.forbidden(`Permission denied: ${path}`);
    throw err;
  }

  const entries: FileEntry[] = [];
  for (const dirent of dirents.slice(0, MAX_ENTRIES)) {
    if (!showHidden && dirent.name.startsWith('.')) continue;
    const full = join(path, dirent.name);
    try {
      const stats = await lstat(full);
      entries.push({
        name: dirent.name,
        path: full,
        type: entryType(stats),
        size: stats.size,
        mtime: stats.mtimeMs,
        mode: (stats.mode & 0o777).toString(8).padStart(3, '0'),
      });
    } catch {
      // A file that vanished between readdir and lstat is not worth failing on.
    }
  }

  entries.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name);
  });

  return { path, entries, truncated: dirents.length > MAX_ENTRIES };
};

const read: Handler = async (params, ctx) => {
  const p = asObject(params);
  const path = await safePath(ctx, requireString(p, 'path', { maxLength: 4096 }));

  let stats;
  try {
    stats = await stat(path);
  } catch {
    throw RpcError.notFound(`No such file: ${path}`);
  }
  if (stats.isDirectory()) throw RpcError.badRequest(`Is a directory: ${path}`);

  const buffer = await readFile(path);
  const truncated = buffer.length > MAX_READ_BYTES;
  const slice = truncated ? buffer.subarray(0, MAX_READ_BYTES) : buffer;

  // Binary files would arrive as mojibake; say so instead of pretending.
  if (slice.includes(0)) {
    throw RpcError.badRequest(`${path} looks like a binary file and cannot be shown as text`);
  }

  return {
    path,
    content: slice.toString('utf8'),
    size: stats.size,
    truncated,
  };
};

const write: Handler = async (params, ctx) => {
  const p = asObject(params);
  const path = await safePath(ctx, requireString(p, 'path', { maxLength: 4096 }));
  const content = requireString(p, 'content', { maxLength: MAX_WRITE_BYTES });

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return { path, bytes: Buffer.byteLength(content, 'utf8') };
};

const makeDir: Handler = async (params, ctx) => {
  const p = asObject(params);
  const path = await safePath(ctx, requireString(p, 'path', { maxLength: 4096 }));
  await mkdir(path, { recursive: true });
  return { path, created: true };
};

const remove: Handler = async (params, ctx) => {
  const p = asObject(params);
  const path = await safePath(ctx, requireString(p, 'path', { maxLength: 4096 }));
  const recursive = optionalBoolean(p, 'recursive');

  const root = await realpath(ctx.config.fileRoot);
  if (path === root) throw RpcError.forbidden('Refusing to delete the root directory');

  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw RpcError.notFound(`No such path: ${path}`);
  }
  if (stats.isDirectory() && !recursive) {
    throw RpcError.badRequest(`${path} is a directory; pass recursive: true to delete it`);
  }

  await rm(path, { recursive, force: false });
  return { path, deleted: true };
};

const move: Handler = async (params, ctx) => {
  const p = asObject(params);
  const from = await safePath(ctx, requireString(p, 'from', { maxLength: 4096 }));
  const to = await safePath(ctx, requireString(p, 'to', { maxLength: 4096 }));

  try {
    await lstat(to);
    throw RpcError.badRequest(`Target already exists: ${to}`);
  } catch (err) {
    if (err instanceof RpcError) throw err;
    // ENOENT is what we want.
  }

  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
  return { from, to };
};

export const fileHandlers: Record<string, Handler> = {
  'files.list': list,
  'files.read': read,
  'files.write': write,
  'files.mkdir': makeDir,
  'files.remove': remove,
  'files.move': move,
};

export const __testing = { safePath, sep };
