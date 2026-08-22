/**
 * Update the agent from the git checkout it was installed from.
 *
 * Until now every change to the agent cost a full SSH setup run: the phone had
 * to collect the account password again, log in, and re-run install.sh, only
 * to fetch a commit and restart a service. Worse, nothing about that was
 * visible from the app — a method added to the agent came back as "Unknown
 * method" from a host that simply had not been updated, and telling that apart
 * from a broken deploy needed a shell.
 *
 * This runs the same four commands install.sh runs, in the same directory,
 * and then restarts. No shell strings from the client: the steps below are
 * constants, and nothing the caller sends reaches any of them — this method
 * takes no parameters at all.
 *
 * The restart is the awkward part, and it is inherent: supervisord stops this
 * very process, so the call cannot report its own success. See
 * scheduleRestart() for how the result gets out first.
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runStream } from '../exec.js';
import { RpcError, type CallContext, type Handler } from '../rpc.js';

/**
 * The repository this agent was built from.
 *
 * Derived from the module's own location rather than from $HOME/uberapp, so a
 * checkout somewhere else still updates itself instead of quietly updating a
 * different copy. Four levels up from either
 * <repo>/packages/agent/dist/handlers or <repo>/packages/agent/src/handlers.
 */
const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * PATH for the child processes.
 *
 * The service file now records the PATH a login shell has, so a freshly
 * installed agent already has a usable one. This stays as the floor under it,
 * for the case that is not hypothetical: an agent whose .ini predates that
 * change updating itself for the first time. It inherited supervisord's PATH,
 * which need not contain the account's Node — the same gap that stopped the
 * service from starting at all — and npm sits next to the node binary running
 * this code, which is the one place it is certain to be.
 */
const CHILD_PATH = [
  dirname(process.execPath),
  process.env.PATH ?? '',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]
  .filter((part) => part.length > 0)
  .join(':');

const CHILD_ENV: NodeJS.ProcessEnv = { ...process.env, PATH: CHILD_PATH };

const NPM = join(dirname(process.execPath), 'npm');

/** The same sequence install.sh performs, minus the parts already in place. */
const STEPS: ReadonlyArray<{ label: string; file: string; args: string[] }> = [
  { label: 'Fetching', file: 'git', args: ['fetch', '--depth', '1', 'origin', 'main'] },
  { label: 'Updating the checkout', file: 'git', args: ['reset', '--hard', 'origin/main'] },
  {
    label: 'Installing dependencies',
    file: NPM,
    args: ['install', '--include-workspace-root', '-w', '@uberapp/protocol', '-w', '@uberapp/agent'],
  },
  { label: 'Building', file: NPM, args: ['run', 'build'] },
];

/** Refuse to run against something that is not a checkout of this project. */
async function assertCheckout(): Promise<void> {
  for (const marker of ['.git', 'package.json']) {
    const there = await access(join(REPO_DIR, marker)).then(
      () => true,
      () => false,
    );
    if (!there) {
      throw RpcError.commandFailed(
        `No git checkout at ${REPO_DIR}: this agent was not installed from one, so it cannot update itself.`,
        'Install it with packages/agent/deploy/install.sh, or update it over SSH.',
      );
    }
  }
}

function runStep(
  step: (typeof STEPS)[number],
  ctx: CallContext,
): Promise<void> {
  return new Promise((done, failed) => {
    ctx.emit('stdout', `\n==> ${step.label}\n`);
    const handle = runStream(
      step.file,
      step.args,
      {
        onChunk: (which, data) => ctx.emit(which, data),
        onDone: (code) =>
          code === 0
            ? done()
            : failed(RpcError.commandFailed(`${step.label} failed (exit code ${code})`)),
        onError: (err) => failed(RpcError.commandFailed(err.message)),
      },
      { cwd: REPO_DIR, env: CHILD_ENV },
    );
    ctx.onCancel(() => handle.cancel());
  });
}

/**
 * Restart the agent without waiting for it.
 *
 * supervisord answers `restart` by sending this process a signal, so awaiting
 * the command would mean awaiting our own death — the call would never return
 * and the app would see a dropped socket with no result. Instead the restart
 * runs detached, in its own process group so it outlives the signal, after a
 * pause long enough for the result of this call to reach the app.
 *
 * The `sh -c` is a fixed string with nothing interpolated into it; it exists
 * only because the delay and the command have to survive as one detached
 * child. No value from the caller appears anywhere in it.
 */
function scheduleRestart(): void {
  const child = spawn(
    'sh',
    ['-c', 'sleep 2; supervisorctl restart uberapp-agent uberapp-connect'],
    { detached: true, stdio: 'ignore', env: CHILD_ENV },
  );
  child.unref();
}

const selfUpdate: Handler = async (_params, ctx: CallContext) => {
  await assertCheckout();

  for (const step of STEPS) {
    await runStep(step, ctx);
  }

  ctx.emit(
    'stdout',
    '\n==> Restarting. The connection drops here — the app reconnects by itself.\n',
  );
  scheduleRestart();

  return { repo: REPO_DIR, restarting: true };
};

export const selfUpdateHandlers: Record<string, Handler> = {
  'system.selfUpdate': selfUpdate,
};
