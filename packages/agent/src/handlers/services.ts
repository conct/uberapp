/**
 * supervisord control.
 *
 * Uberspace gives every user their own supervisord instance; service configs
 * live in ~/etc/services.d/<name>.ini and are managed with supervisorctl.
 */

import { access, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServiceInfo, ServiceState } from '@uberapp/protocol';
import { run, runStream } from '../exec.js';
import { RpcError, type CallContext, type Handler } from '../rpc.js';
import {
  asObject,
  optionalBoolean,
  requireEnum,
  requireString,
  serviceName,
} from '../validate.js';

const SERVICES_DIR = (home: string) => join(home, 'etc', 'services.d');

const KNOWN_STATES: ServiceState[] = [
  'RUNNING',
  'STOPPED',
  'STARTING',
  'STOPPING',
  'BACKOFF',
  'EXITED',
  'FATAL',
];

/**
 * Parse `supervisorctl status` output.
 *
 *   my-daemon    RUNNING   pid 1234, uptime 0:12:33
 *   other        STOPPED   Sep 12 01:23 PM
 *   broken       FATAL     Exited too quickly (process log may have details)
 */
export function parseStatus(stdout: string): ServiceInfo[] {
  const services: ServiceInfo[] = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = /^(\S+)\s+([A-Z]+)(?:\s+(.*))?$/.exec(trimmed);
    if (!match) continue;

    const [, name, rawState, description = ''] = match;
    if (!name || !rawState) continue;

    const state: ServiceState = KNOWN_STATES.includes(rawState as ServiceState)
      ? (rawState as ServiceState)
      : 'UNKNOWN';

    const pidMatch = /pid (\d+)/.exec(description);
    services.push({
      name,
      state,
      description: description.trim(),
      pid: pidMatch?.[1] ? Number(pidMatch[1]) : null,
      uptimeSeconds: parseUptime(description),
    });
  }

  return services;
}

/** "uptime 0:12:33" or "uptime 1 day, 2:03:04" -> seconds. */
function parseUptime(description: string): number | null {
  const match = /uptime\s+(?:(\d+) days?,\s*)?(\d+):(\d{2}):(\d{2})/.exec(description);
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

const list: Handler = async () => {
  // supervisorctl exits non-zero when any process is not running, so the exit
  // code says nothing useful here; only a spawn failure is a real error.
  const result = await run('supervisorctl', ['status']);
  if (result.exitCode === null && !result.stdout) {
    throw RpcError.commandFailed('supervisorctl did not respond', result.stderr);
  }
  return parseStatus(result.stdout || result.stderr);
};

const control: Handler = async (params) => {
  const p = asObject(params);
  const name = serviceName(p);
  const action = requireEnum(p, 'action', ['start', 'stop', 'restart'] as const);

  const result = await run('supervisorctl', [action, name], { timeoutMs: 60_000 });
  const output = (result.stdout + result.stderr).trim();

  // supervisorctl reports failures in stdout with a zero exit code often
  // enough that the text is more reliable than the exit status.
  if (/ERROR|no such process|not running|already started/i.test(output) && !result.ok) {
    throw RpcError.commandFailed(output.split('\n')[0] ?? 'supervisorctl failed', output);
  }

  return { ok: result.ok, stdout: output, stderr: '', exitCode: result.exitCode };
};

const reload: Handler = async () => {
  const reread = await run('supervisorctl', ['reread'], { timeoutMs: 60_000 });
  const update = await run('supervisorctl', ['update'], { timeoutMs: 60_000 });
  return {
    ok: reread.ok && update.ok,
    stdout: [reread.stdout, update.stdout].join('\n').trim(),
    stderr: [reread.stderr, update.stderr].join('\n').trim(),
    exitCode: update.exitCode,
  };
};

const remove: Handler = async (params) => {
  const p = asObject(params);
  const name = serviceName(p);

  // supervisord refuses to remove a running process.
  await run('supervisorctl', ['stop', name], { timeoutMs: 60_000 });
  const result = await run('supervisorctl', ['remove', name], { timeoutMs: 30_000 });
  return {
    ok: result.ok,
    stdout: (result.stdout + result.stderr).trim(),
    stderr: '',
    exitCode: result.exitCode,
  };
};

const readConfig: Handler = async (params, ctx) => {
  const p = asObject(params);
  const name = serviceName(p);
  const path = join(SERVICES_DIR(ctx.config.home), `${name}.ini`);

  try {
    const content = await readFile(path, 'utf8');
    return { path, content };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw RpcError.notFound(`No service config at ${path}`);
    }
    throw err;
  }
};

const MAX_INI_BYTES = 64 * 1024;

const writeConfig: Handler = async (params, ctx) => {
  const p = asObject(params);
  const name = serviceName(p);
  const content = requireString(p, 'content', { maxLength: MAX_INI_BYTES });

  // A config that does not declare the program supervisord expects would be
  // silently ignored, which looks like the app losing the write.
  if (!content.includes(`[program:${name}]`)) {
    throw RpcError.badRequest(
      `The config must contain a [program:${name}] section matching the service name`,
    );
  }

  const dir = SERVICES_DIR(ctx.config.home);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.ini`);

  // The create flow sets this: a typo in the name must not silently replace a
  // running service's config. Editing an existing config leaves it unset.
  if (optionalBoolean(p, 'mustNotExist')) {
    const exists = await access(path).then(
      () => true,
      () => false,
    );
    if (exists) {
      throw RpcError.badRequest(`A service named "${name}" already exists`, path);
    }
  }

  await writeFile(path, content, { encoding: 'utf8', mode: 0o644 });

  return { path, bytes: Buffer.byteLength(content, 'utf8') };
};

const deleteConfig: Handler = async (params, ctx) => {
  const p = asObject(params);
  const name = serviceName(p);
  const path = join(SERVICES_DIR(ctx.config.home), `${name}.ini`);

  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw RpcError.notFound(`No service config at ${path}`);
    }
    throw err;
  }
  return { path, deleted: true };
};

/**
 * Stream a service's log.
 *
 * We use `supervisorctl tail -f` rather than tailing a file directly because
 * supervisord decides where each process's log actually lands, and asking it
 * avoids guessing at the childlogdir naming scheme.
 */
const logs: Handler = (params, ctx: CallContext) => {
  const p = asObject(params);
  const name = serviceName(p);
  const stream = requireEnum(p, 'stream', ['stdout', 'stderr'] as const);

  return new Promise((resolve, reject) => {
    const handle = runStream(
      'supervisorctl',
      ['tail', '-f', name, stream],
      {
        onChunk: (which, data) => ctx.emit(which, data),
        onDone: () => resolve({ ended: true }),
        onError: (err) => reject(RpcError.commandFailed(err.message)),
      },
    );
    ctx.onCancel(() => handle.cancel());
  });
};

export const serviceHandlers: Record<string, Handler> = {
  'services.list': list,
  'services.control': control,
  'services.reload': reload,
  'services.remove': remove,
  'services.readConfig': readConfig,
  'services.writeConfig': writeConfig,
  'services.deleteConfig': deleteConfig,
  'services.logs': logs,
};
