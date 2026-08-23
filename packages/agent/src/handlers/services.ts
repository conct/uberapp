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
import { parseBackends } from './web.js';
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
 * supervisorctl's ways of saying "there was nothing left to do".
 *
 * Removing a service is four steps, and a person deleting one has usually
 * already done some of them by hand — stopped it last week, deleted the .ini
 * and never reread. Treating those as failures would make the sequence refuse
 * to finish exactly the cleanups that need finishing, so they are outcomes,
 * not errors. Anything else still is one.
 */
const NOTHING_TO_DO =
  /no such process|not running|already stopped|ERROR \(no such process\)/i;

export function isNothingToDo(output: string): boolean {
  return NOTHING_TO_DO.test(output);
}

/**
 * The ports a service's own config mentions.
 *
 * Used to find the web backends that point at it. The link between a service
 * and its route is the port and nothing else: the .ini names it, `uberspace
 * web backend list` maps a target to it, and the CLI deletes by target. The
 * port is the lookup key, never the thing deleted.
 *
 * Deliberately narrow. Reading every four-digit number was the obvious first
 * attempt and it is wrong in a way that costs somebody else their routing:
 * `--since 2026` is a year, not a port, and a backend on 2026 would have been
 * deleted along with an unrelated service. A missed port leaves a dead route,
 * which the step reports; a wrong one removes a live one, which it cannot.
 * So only the three forms that actually say "port" are read.
 */
const PORT_PATTERNS: readonly RegExp[] = [
  // environment=PORT="8080", which is where the create wizard puts it
  /\bPORT\s*=\s*"?(\d{4,5})"?/gi,
  // --port 8080 or --port=8080 on the command line
  /--port[= ](\d{4,5})\b/gi,
  // a bind address, 0.0.0.0:8080
  /:(\d{4,5})\b/g,
];

export function portsIn(iniContent: string): number[] {
  const found = new Set<number>();
  for (const pattern of PORT_PATTERNS) {
    for (const match of iniContent.matchAll(pattern)) {
      const port = Number(match[1]);
      if (port >= 1024 && port <= 65535) found.add(port);
    }
  }
  return [...found];
}

type StepState = 'ok' | 'skipped' | 'failed';

interface DeleteStep {
  step: string;
  state: StepState;
  detail: string;
}

/**
 * Delete a service: stop it, drop it from supervisord, remove its .ini, and
 * make supervisord forget it.
 *
 * The order matters and is not obvious — supervisord refuses to remove a
 * running process, and `update` only drops a process group once its config
 * file is gone. Doing this by hand means four commands in the right sequence,
 * with two of them failing harmlessly if the service was already half gone.
 * That is the whole reason this is one call rather than four.
 *
 * It reports every step rather than a single ok/failed, because a partial
 * result is the interesting case: the .ini deleted but supervisord not
 * reloaded leaves a service that is listed and cannot be started.
 */
const deleteService: Handler = async (params, ctx) => {
  const p = asObject(params);
  const name = serviceName(p);
  const path = join(SERVICES_DIR(ctx.config.home), `${name}.ini`);
  const steps: DeleteStep[] = [];

  // Read before anything is removed. Once the .ini is gone so is the only
  // record of which port the service used, and with it the only way to tell
  // which route belonged to it.
  const config = await readFile(path, 'utf8').catch(() => '');

  const supervisor = async (step: string, args: string[]) => {
    const result = await run('supervisorctl', args, { timeoutMs: 60_000 });
    const output = (result.stdout + result.stderr).trim();
    steps.push({
      step,
      state: result.ok ? 'ok' : isNothingToDo(output) ? 'skipped' : 'failed',
      detail: output,
    });
  };

  await supervisor('stop', ['stop', name]);
  await supervisor('remove', ['remove', name]);

  try {
    await unlink(path);
    steps.push({ step: 'config', state: 'ok', detail: path });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      steps.push({ step: 'config', state: 'skipped', detail: `${path} was already gone` });
    } else {
      steps.push({ step: 'config', state: 'failed', detail: `${path}: ${String(err)}` });
    }
  }

  // A route to a service that no longer exists is worse than no route: it
  // answers 502 rather than 404, and nothing on the host says why. The create
  // wizard makes the service and its backend in one go, so removing one
  // without the other leaves exactly the half that cannot be diagnosed from
  // the outside.
  try {
    const ports = portsIn(config);
    if (ports.length === 0) {
      steps.push({ step: 'backend', state: 'skipped', detail: 'no port in the config' });
    } else {
      const listed = await run('uberspace', ['web', 'backend', 'list'], { timeoutMs: 30_000 });
      const mine = parseBackends(listed.stdout || listed.stderr).filter(
        (backend) => backend.port !== null && ports.includes(backend.port),
      );

      if (mine.length === 0) {
        steps.push({ step: 'backend', state: 'skipped', detail: 'none pointed here' });
      } else {
        const removed: string[] = [];
        for (const backend of mine) {
          const target = `${backend.domain}${backend.path}`;
          await run('uberspace', ['web', 'backend', 'del', target], { timeoutMs: 60_000 });
          removed.push(target);
        }
        steps.push({ step: 'backend', state: 'ok', detail: removed.join(', ') });
      }
    }
  } catch (err) {
    // The service still goes. A route left behind is a loose end worth
    // reporting, not a reason to abandon a removal half-done.
    steps.push({ step: 'backend', state: 'failed', detail: String(err) });
  }

  await supervisor('reread', ['reread']);
  await supervisor('update', ['update']);

  // What counts is the end state, not whether every step had work to do: the
  // service is gone when supervisord no longer lists it and no config is left
  // to bring it back.
  const status = await run('supervisorctl', ['status', name], { timeoutMs: 30_000 });
  const stillListed = !isNothingToDo((status.stdout + status.stderr).trim());
  const configLeft = await access(path).then(
    () => true,
    () => false,
  );

  if (stillListed || configLeft) {
    const failed = steps.find((entry) => entry.state === 'failed');
    throw RpcError.commandFailed(
      failed
        ? `Could not fully remove the service (${failed.step} failed)`
        : 'The service is still there, though no step reported a failure',
      steps.map((entry) => `${entry.step}: ${entry.state} ${entry.detail}`).join('\n'),
    );
  }

  return { name, path, steps, gone: true };
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
  'services.delete': deleteService,
  'services.readConfig': readConfig,
  'services.writeConfig': writeConfig,
  'services.deleteConfig': deleteConfig,
  'services.logs': logs,
};
