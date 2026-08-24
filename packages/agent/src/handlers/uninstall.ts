/**
 * Remove uberCTRL from the host, from the host.
 *
 * The counterpart to install.sh, and it undoes exactly what that script and
 * the phone-driven setup created — nothing else. An account's own services,
 * domains and files are none of this call's business, and it never touches
 * them: every path and every service name below is a constant that install.sh
 * itself writes, and the caller supplies nothing at all.
 *
 * What gets removed:
 *   - the uberctrl-connect and uberctrl-agent services, and their .ini files
 *   - the web backends for /uberctrl and uberctrl.<user>.uber.space/connect
 *   - that subdomain and its DocumentRoot
 *   - the token in ~/.config/uberctrl
 *   - the checkout the agent runs from
 *
 * As with a self-update, the ending is inherent: the last two steps stop the
 * process serving this call and delete the code it is running. Everything that
 * can be reported while alive is done first and streamed; only the tail that
 * removes the agent itself runs detached. See the script in scheduleRemoval().
 */

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../exec.js';
import { type CallContext, type Handler } from '../rpc.js';

/** The checkout this agent runs from — four levels up, as in selfUpdate. */
const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * The tail that cannot report back, because it ends this process.
 *
 * Written with positional parameters rather than interpolation: the two paths
 * arrive as arguments, so nothing is ever spliced into the script text. It
 * runs detached and in its own process group, so supervisord stopping the
 * agent does not take the rest of the removal down with it.
 */
const REMOVAL_TAIL = [
  'sleep 2',
  'supervisorctl stop uberctrl-agent',
  'supervisorctl remove uberctrl-agent',
  'rm -f "$2"',
  'supervisorctl reread',
  'supervisorctl update',
  'rm -rf "$1"',
].join('\n');

function scheduleRemoval(repoDir: string, serviceFile: string): void {
  const child = spawn('sh', ['-c', REMOVAL_TAIL, 'sh', repoDir, serviceFile], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

const uninstall: Handler = async (_params, ctx: CallContext) => {
  const { home, user } = ctx.config;
  const webDomain = `uberctrl.${user}.uber.space`;
  const agentService = join(home, 'etc', 'services.d', 'uberctrl-agent.ini');
  const connectService = join(home, 'etc', 'services.d', 'uberctrl-connect.ini');

  /** Report every step, and let none of them stop the removal. */
  const step = async (label: string, work: () => Promise<string>) => {
    ctx.emit('stdout', `\n==> ${label}\n`);
    try {
      const detail = await work();
      if (detail) ctx.emit('stdout', `${detail}\n`);
    } catch (err) {
      // A piece that was already gone, or never existed, is a step with
      // nothing to do — not a reason to leave the rest of uberCTRL behind.
      ctx.emit('stderr', `skipped: ${String(err)}\n`);
    }
  };

  const cmd = async (file: string, args: string[]) => {
    const result = await run(file, args, { timeoutMs: 60_000 });
    return (result.stdout + result.stderr).trim();
  };

  await step('Removing the /uberctrl backend', () =>
    cmd('uberspace', ['web', 'backend', 'del', '/uberctrl']),
  );
  await step('Removing the broker backend', () =>
    cmd('uberspace', ['web', 'backend', 'del', `${webDomain}/connect`]),
  );
  await step('Removing the subdomain', () =>
    cmd('uberspace', ['web', 'domain', 'del', webDomain]),
  );
  await step('Removing the web view', async () => {
    const root = join('/var/www/virtual', user, webDomain);
    await rm(root, { recursive: true, force: true });
    return root;
  });

  await step('Stopping the broker', () => cmd('supervisorctl', ['stop', 'uberctrl-connect']));
  await step('Removing the broker', () => cmd('supervisorctl', ['remove', 'uberctrl-connect']));
  await step('Deleting the broker service file', async () => {
    await rm(connectService, { force: true });
    return connectService;
  });

  await step('Deleting the token', async () => {
    const tokenDir = join(home, '.config', 'uberctrl');
    await rm(tokenDir, { recursive: true, force: true });
    return tokenDir;
  });

  ctx.emit(
    'stdout',
    '\n==> Removing the agent itself. The connection ends here, by design.\n',
  );
  scheduleRemoval(REPO_DIR, agentService);

  return { removed: true, repo: REPO_DIR };
};

export const uninstallHandlers: Record<string, Handler> = {
  'system.uninstall': uninstall,
};
