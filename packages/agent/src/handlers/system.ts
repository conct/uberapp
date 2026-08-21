/**
 * Monitoring and host maintenance: quota, processes, tool versions, cron.
 */

import { loadavg, uptime as osUptime } from 'node:os';
import type { ProcessInfo, QuotaInfo, SystemInfo, ToolVersion } from '@uberapp/protocol';
import { AGENT_VERSION } from '../config.js';
import { run } from '../exec.js';
import { RpcError, type Handler } from '../rpc.js';
import { asObject, requireString, toolName, versionString } from '../validate.js';

const info: Handler = async (_params, ctx) => {
  const [one = 0, five = 0, fifteen = 0] = loadavg();

  const result: SystemInfo = {
    user: ctx.config.user,
    hostname: ctx.config.host,
    uptime: formatDuration(osUptime()),
    // Shared host: this is the whole machine's load, not just this account.
    loadAverage: [one, five, fifteen],
    agentVersion: AGENT_VERSION,
    nodeVersion: process.version,
  };
  return result;
};

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Parse `quota -gs`, whose human-readable sizes carry a unit suffix:
 *
 *   Disk quotas for group isabell (gid 1234):
 *        Filesystem   space   quota   limit   grace   files   quota   limit
 *         /dev/sdb1   4096M  10240M  10240M             12k      0k      0k
 */
export function parseQuota(stdout: string): QuotaInfo {
  const raw = stdout.trim();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    // The data row is the one starting with a device path.
    if (!trimmed.startsWith('/')) continue;

    const columns = trimmed.split(/\s+/);
    const used = parseSize(columns[1]);
    const limit = parseSize(columns[2]);

    if (used === null) continue;
    return {
      used,
      limit,
      percent: limit && limit > 0 ? Math.round((used / limit) * 1000) / 10 : null,
      raw,
    };
  }

  return { used: 0, limit: null, percent: null, raw };
}

/** "4096M" / "10240M" / "1.5G" / "0" -> bytes. A trailing * marks over-quota. */
function parseSize(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^([\d.]+)([KMGT]?)\*?$/i.exec(value);
  if (!match?.[1]) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const multipliers: Record<string, number> = {
    '': 1024, // quota -s reports in kibibytes when no suffix is present
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
  };
  return amount * (multipliers[(match[2] ?? '').toUpperCase()] ?? 1024);
};

const quota: Handler = async () => {
  // -l keeps quota to local filesystems. Without it, it also queries the NFS
  // quota server, which on some hosts is unreachable and only adds noise.
  const result = await run('quota', ['-gsl']);
  // quota exits 1 when a limit is exceeded, which is exactly when the user
  // most wants to see the numbers.
  if (!result.stdout.trim() && !result.ok) {
    throw RpcError.commandFailed('Could not read quota', result.stderr);
  }

  const parsed = parseQuota(result.stdout);

  // Empty output is not "zero used" — it is quota finding no group to report
  // on. supervisord starts the agent without supplementary groups, and the
  // Uberspace quota is a group quota, so `quota -g` sees nothing at all. Say
  // that rather than reporting a comfortable-looking 0.
  if (!parsed.raw.trim()) {
    throw RpcError.commandFailed(
      'The quota is a group quota, and this process was started without its group, so quota reports nothing.',
      'Uberspace supervisord starts services with an empty supplementary group list. ' +
        'Disk usage under Diagnose still works — it measures the directories directly.',
    );
  }

  return parsed;
};

const processes: Handler = async (_params, ctx) => {
  const result = await run('ps', [
    '-u',
    ctx.config.user,
    '-o',
    'pid=,pcpu=,pmem=,rss=,args=',
    '--sort=-rss',
  ]);

  const list: ProcessInfo[] = [];
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = /^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;

    list.push({
      pid: Number(match[1]),
      cpu: Number(match[2]),
      mem: Number(match[3]),
      rssKb: Number(match[4]),
      command: (match[5] ?? '').slice(0, 200),
    });
  }
  return list.slice(0, 100);
};

// --- tool versions ---------------------------------------------------------

/**
 * Tools Uberspace lets you switch. Probed individually; misses are skipped,
 * so listing one the host does not offer costs a probe and nothing else.
 * The database entries matter as much as the languages: switching a major
 * PostgreSQL or MongoDB version is the same command.
 */
const KNOWN_TOOLS = [
  'php',
  'node',
  'python',
  'ruby',
  'erlang',
  'elixir',
  'go',
  'deno',
  'rust',
  'java',
  'postgresql',
  'mongodb',
  'redis',
  'influxdb',
];

const toolVersions: Handler = async () => {
  const versions: ToolVersion[] = [];

  await Promise.all(
    KNOWN_TOOLS.map(async (tool) => {
      const [show, list] = await Promise.all([
        run('uberspace', ['tools', 'version', 'show', tool], { timeoutMs: 15_000 }),
        run('uberspace', ['tools', 'version', 'list', tool], { timeoutMs: 15_000 }),
      ]);

      // A tool that is not switchable on this host exits non-zero for both.
      if (!show.ok && !list.ok) return;

      versions.push({
        tool,
        current: extractVersion(show.stdout) ?? null,
        available: list.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => /^[\d.]+$/.test(line)),
      });
    }),
  );

  return versions.sort((a, b) => a.tool.localeCompare(b.tool));
};

/** "Using 'php' version: '8.2'" -> "8.2" */
function extractVersion(stdout: string): string | undefined {
  const quoted = /version:?\s*'([^']+)'/i.exec(stdout);
  if (quoted?.[1]) return quoted[1];
  const bare = /([\d]+(?:\.[\d]+)*)/.exec(stdout.trim());
  return bare?.[1];
}

const setToolVersion: Handler = async (params) => {
  const p = asObject(params);
  const tool = toolName(p);
  const version = versionString(p);

  const result = await run('uberspace', ['tools', 'version', 'use', tool, version], {
    timeoutMs: 60_000,
  });
  const output = (result.stdout + result.stderr).trim();
  if (!result.ok) {
    throw RpcError.commandFailed(output.split('\n')[0] ?? 'Could not switch version', output);
  }
  return { tool, version, output };
};

// --- cron ------------------------------------------------------------------

const cronList: Handler = async () => {
  const result = await run('crontab', ['-l']);
  // An empty crontab exits 1 with "no crontab for ..."; that is not an error.
  if (!result.ok && /no crontab/i.test(result.stderr)) {
    return { content: '', exists: false };
  }
  if (!result.ok) {
    throw RpcError.commandFailed('Could not read crontab', result.stderr);
  }
  return { content: result.stdout, exists: true };
};

const MAX_CRONTAB_BYTES = 64 * 1024;

const cronSet: Handler = async (params) => {
  const p = asObject(params);
  const content = requireString(p, 'content', { maxLength: MAX_CRONTAB_BYTES });

  // crontab reads the new table from stdin; a missing trailing newline makes
  // some implementations drop the last entry.
  const normalized = content.endsWith('\n') ? content : content + '\n';
  const result = await run('crontab', ['-'], { input: normalized, timeoutMs: 30_000 });

  if (!result.ok) {
    throw RpcError.commandFailed(
      result.stderr.trim().split('\n')[0] ?? 'crontab rejected the input',
      result.stderr,
    );
  }
  return { ok: true, bytes: Buffer.byteLength(normalized, 'utf8') };
};

export const systemHandlers: Record<string, Handler> = {
  'system.info': info,
  'system.quota': quota,
  'system.processes': processes,
  'system.toolVersions': toolVersions,
  'system.setToolVersion': setToolVersion,
  'system.cron.list': cronList,
  'system.cron.set': cronSet,
};
