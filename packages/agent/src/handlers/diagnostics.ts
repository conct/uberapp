/**
 * Disk and memory forensics.
 *
 * These answer the two questions the dashboard cannot: "the quota is full and
 * I cannot find what is using it", and "my service keeps dying". Both have a
 * documented cause that is invisible from a file listing — space held by
 * deleted-but-open files, and the 1.5 GB per-account memory ceiling.
 */

import type { DeletedFile, DiskUsageEntry, MemoryUsage } from '@uberctrl/protocol';
import { MEMORY_LIMIT_BYTES } from '@uberctrl/protocol';
import type { AgentConfig } from '../config.js';
import { run } from '../exec.js';
import { RpcError, type Handler } from '../rpc.js';
import { asObject, requireString } from '../validate.js';

/**
 * The paths worth measuring when the quota does not add up.
 *
 * The manual's own command also lists /tmp and /var/tmp. Those are deliberately
 * left out here: on a shared host they hold every other account's files, so
 * `du` walks a tree that is neither ours nor bounded — measured on a live host
 * it did not finish inside twenty seconds, while the account's own directories
 * take about three. What we measure has to be what we own.
 */
export function usagePaths(config: AgentConfig): string[] {
  return [
    config.home,
    `/var/www/virtual/${config.user}`,
    `/var/lib/php-sessions/${config.user}`,
  ];
}

/** `du -sb` prints "<bytes>\t<path>" per argument. */
export function parseDiskUsage(stdout: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const line of stdout.split('\n')) {
    const match = /^(\d+)\s+(.+)$/.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    sizes.set(match[2], Number(match[1]));
  }
  return sizes;
}

const diskUsage: Handler = async (_params, ctx) => {
  const paths = usagePaths(ctx.config);

  // du exits non-zero when any argument is unreadable but still reports the
  // rest, so the exit code is not the signal here — a missing entry is.
  const result = await run('du', ['-sb', ...paths], { timeoutMs: 120_000 });
  const sizes = parseDiskUsage(result.stdout);

  const entries: DiskUsageEntry[] = paths.map((path) => {
    const bytes = sizes.get(path);
    return bytes === undefined
      ? { path, bytes: 0, error: 'nicht lesbar oder nicht vorhanden' }
      : { path, bytes, error: null };
  });

  return { entries, raw: result.stderr.trim() };
};

/**
 * Parse `lsof -u <user> +L1`, which lists open files whose link count dropped
 * to zero. Columns: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NLINK NODE NAME.
 */
export function parseDeletedFiles(stdout: string): DeletedFile[] {
  const files: DeletedFile[] = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('COMMAND')) continue;

    const columns = trimmed.split(/\s+/);
    if (columns.length < 10) continue;

    const pid = Number(columns[1]);
    const bytes = Number(columns[6]);
    if (!Number.isInteger(pid)) continue;

    files.push({
      pid,
      process: columns[0] ?? '',
      bytes: Number.isFinite(bytes) ? bytes : 0,
      // The path may contain spaces, so take everything from column 9 on.
      path: columns.slice(9).join(' '),
    });
  }

  // Biggest first: that is the one worth restarting a process for.
  return files.sort((a, b) => b.bytes - a.bytes).slice(0, 100);
}

const deletedFiles: Handler = async (_params, ctx) => {
  let result;
  try {
    result = await run('lsof', ['-u', ctx.config.user, '+L1'], { timeoutMs: 60_000 });
  } catch {
    throw RpcError.notFound('lsof is not available on this host');
  }

  // lsof exits 1 when it finds nothing, which is a perfectly good answer.
  const files = parseDeletedFiles(result.stdout);
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  return { files, totalBytes: total };
};

/**
 * Sum resident memory across the account's processes.
 *
 * ps reports RSS in kilobytes. Shared pages are counted once per process, so
 * this overstates slightly — but it overstates in the same direction as the
 * limit that kills things, which is the useful side to err on.
 */
export function parseMemory(stdout: string): { rssBytes: number; processCount: number } {
  let rssBytes = 0;
  let processCount = 0;

  for (const line of stdout.split('\n')) {
    const value = Number(line.trim());
    if (!Number.isFinite(value) || line.trim().length === 0) continue;
    rssBytes += value * 1024;
    processCount += 1;
  }

  return { rssBytes, processCount };
}

const memory: Handler = async (_params, ctx) => {
  const result = await run('ps', ['-u', ctx.config.user, '-o', 'rss=']);
  const { rssBytes, processCount } = parseMemory(result.stdout);

  const usage: MemoryUsage = {
    rssBytes,
    limitBytes: MEMORY_LIMIT_BYTES,
    percent: Math.round((rssBytes / MEMORY_LIMIT_BYTES) * 1000) / 10,
    processCount,
  };
  return usage;
};

// --- login shell -----------------------------------------------------------

/** `chsh -l` prints one shell path per line. */
export function parseShells(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/'));
}

const shellList: Handler = async () => {
  const result = await run('chsh', ['-l']);
  const shells = parseShells(result.stdout);
  if (shells.length === 0) {
    throw RpcError.notFound('chsh could not list the available shells on this host');
  }
  return { shells, current: process.env['SHELL'] ?? null };
};

const shellSet: Handler = async (params) => {
  const p = asObject(params);
  const shell = requireString(p, 'shell', { maxLength: 128 });

  // Only a shell the host itself offers; anything else is not a login shell.
  const available = parseShells((await run('chsh', ['-l'])).stdout);
  if (!available.includes(shell)) {
    throw RpcError.badRequest(`${shell} is not one of the shells this host offers`);
  }

  const result = await run('chsh', ['--shell', shell], { timeoutMs: 30_000 });
  const output = (result.stdout + result.stderr).trim();
  if (!result.ok) {
    // chsh asks for a password on some systems, and stdin is closed here.
    throw RpcError.commandFailed(
      /password/i.test(output)
        ? 'chsh asked for a password, which the agent cannot answer. Change the shell over SSH.'
        : output.split('\n')[0] || 'Could not change the login shell',
      output,
    );
  }
  return { shell, output };
};

export const diagnosticsHandlers: Record<string, Handler> = {
  'system.diskUsage': diskUsage,
  'system.deletedFiles': deletedFiles,
  'system.memory': memory,
  'system.shell.list': shellList,
  'system.shell.set': shellSet,
};
