#!/usr/bin/env node
/**
 * One-command setup: get the agent onto an Uberspace over SSH.
 *
 * This is the chicken-and-egg fix. The app talks to the agent, but the agent
 * has to get onto the host somehow, and doing that by hand is exactly the
 * console work the app exists to remove. So the *setup* uses SSH — once, from
 * your own machine — and everything after that goes through the app.
 *
 * Deliberately not part of the app: React Native has no SSH client worth
 * having, a private key does not belong on a phone, and an SSH channel would
 * undo the guarantee that the client never sends shell strings. Here on a
 * developer machine, using the system ssh is simply the right tool.
 *
 *   node tools/setup.mjs isabell@stardust.uberspace.de
 *   node tools/setup.mjs stardust --port 8399 --dir uberapp
 *
 * Safe to re-run: an existing token is kept and the service is just reloaded.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Everything that must not travel: build output, secrets, local state. */
const EXCLUDES = [
  'node_modules',
  'dist',
  '.expo',
  '.git',
  '.env',
  '.env.local',
  'agent.config.json',
  '*.tsbuildinfo',
];

function parseArgs(argv) {
  const args = { host: null, port: '8399', dir: 'uberapp' };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--port') args.port = argv[++i];
    else if (value === '--dir') args.dir = argv[++i];
    else if (value === '--help' || value === '-h') args.help = true;
    else if (!args.host) args.host = value;
  }
  return args;
}

const USAGE = `
Usage: node tools/setup.mjs <ssh-host> [options]

  <ssh-host>   Anything ssh understands: an alias from ~/.ssh/config, or
               user@host.uberspace.de

Options:
  --port <n>   Port the agent listens on inside the host (default 8399)
  --dir <name> Directory in the home to install into (default uberapp)
`;

function say(message) {
  process.stdout.write(`\n[1m==> ${message}[0m\n`);
}

function fail(message) {
  process.stderr.write(`\n[31m${message}[0m\n`);
  process.exit(1);
}

/** Run a command, inheriting stdio so the user sees progress as it happens. */
function run(file, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${file} exited with code ${code}`)),
    );
  });
}

/** Run a command and capture stdout. */
function capture(file, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolvePromise(stdout) : reject(new Error(stderr.trim() || `exit ${code}`)),
    );
  });
}

/**
 * Run a snippet on the host.
 *
 * ssh always hands its argument to the remote shell, so this is the one place
 * a shell string is unavoidable. Nothing user-supplied is interpolated into
 * it beyond the install directory, which is checked below.
 */
function remote(host, script) {
  return capture('ssh', ['-o', 'BatchMode=yes', host, script]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.host) {
    process.stdout.write(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  if (!/^[A-Za-z0-9._-]+$/.test(args.dir)) {
    fail('--dir must be a plain directory name without slashes.');
  }
  if (!/^\d{4,5}$/.test(args.port)) {
    fail('--port must be a port number.');
  }

  // --- 1. reachability -----------------------------------------------------
  say(`Connecting to ${args.host}`);
  let whoami;
  try {
    whoami = (await remote(args.host, 'echo "$USER@$(hostname)"')).trim();
  } catch (err) {
    fail(
      `Could not connect: ${err.message}\n\n` +
        'Check that `ssh ' +
        args.host +
        '` works on its own. If it asks for a passphrase, ' +
        'load the key into your agent first (ssh-add).',
    );
  }
  process.stdout.write(`Connected as ${whoami}\n`);

  const isUberspace = await remote(args.host, 'command -v uberspace >/dev/null && echo yes || echo no');
  if (isUberspace.trim() !== 'yes') {
    fail('That host has no `uberspace` command, so it is not an Uberspace 7 account.');
  }

  // --- 2. node version -----------------------------------------------------
  say('Checking Node on the host');
  const nodeVersion = (await remote(args.host, 'node -v 2>/dev/null || echo none')).trim();
  const major = Number(/^v(\d+)/.exec(nodeVersion)?.[1] ?? 0);
  process.stdout.write(`Host has Node ${nodeVersion}\n`);

  if (major < 20) {
    say('Switching the host to Node 22');
    await remote(args.host, 'uberspace tools version use node 22');
    process.stdout.write('Switched. Re-run this command so the new version is picked up.\n');
    process.exit(0);
  }

  // --- 3. copy the repository ---------------------------------------------
  say(`Copying the project to ~/${args.dir}`);

  // Straight through: tar writes to stdout, ssh reads it, tar unpacks on the
  // far side. No temp file on either end — which also sidesteps GNU tar
  // reading a Windows path like C:\... as a remote host spec.
  await new Promise((resolvePromise, reject) => {
    const pack = spawn(
      'tar',
      [
        '-czf',
        '-',
        ...EXCLUDES.flatMap((pattern) => ['--exclude', pattern]),
        '-C',
        REPO_ROOT,
        '.',
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );

    const ssh = spawn(
      'ssh',
      ['-o', 'BatchMode=yes', args.host, `mkdir -p ~/${args.dir} && tar -xzf - -C ~/${args.dir}`],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );

    pack.on('error', reject);
    ssh.on('error', reject);
    // If the far side gives up, stop reading the disk rather than dying on EPIPE.
    ssh.stdin.on('error', () => pack.kill('SIGTERM'));
    pack.stdout.pipe(ssh.stdin);

    ssh.on('close', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`upload failed with code ${code}`)),
    );
  });

  // --- 4. install ----------------------------------------------------------
  say('Building and installing the agent (this takes a minute)');
  await run('ssh', [
    '-o',
    'BatchMode=yes',
    args.host,
    `cd ~/${args.dir} && UBERAPP_PORT=${args.port} bash packages/agent/deploy/install.sh`,
  ]);

  // --- 5. report -----------------------------------------------------------
  const token = (await remote(args.host, 'cat ~/.config/uberapp/token')).trim();
  const status = (
    await remote(args.host, 'supervisorctl status uberapp-agent 2>&1 || true')
  ).trim();
  const backends = (await remote(args.host, 'uberspace web backend list 2>&1 || true')).trim();

  say('Done');
  process.stdout.write(`${status}\n\n`);

  const exposed = backends.includes(`http:${args.port}`);
  if (exposed) {
    const line = backends.split('\n').find((entry) => entry.includes(`http:${args.port}`)) ?? '';
    const target = line.trim().split(/\s+/)[0] ?? '';
    process.stdout.write(
      `The agent is reachable at:\n\n  URL:   wss://${target}\n  Token: ${token}\n\n` +
        `Check it with:  curl https://${target}healthz\n`,
    );
  } else {
    process.stdout.write(
      'The agent runs, but nothing routes to it yet. Pick a domain and run ONE of:\n\n' +
        `  ssh ${args.host} 'uberspace web backend set uberapp.YOUR-DOMAIN.tld/ --http --port ${args.port}'\n` +
        `  ssh ${args.host} 'uberspace web backend set /uberapp --http --port ${args.port} --remove-prefix'\n\n` +
        `Then in the app:\n\n  URL:   wss://<that domain or path>\n  Token: ${token}\n`,
    );
  }

  process.stdout.write('\nThat token grants full control of the account. Treat it as a password.\n');
}

main().catch((err) => fail(err.message));
