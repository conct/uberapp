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
 *   node tools/setup.mjs stardust --port 8399 --dir uberctrl
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
  const args = { host: null, port: '8399', dir: 'uberctrl', path: 'uberctrl', domain: null };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--port') args.port = argv[++i];
    else if (value === '--dir') args.dir = argv[++i];
    else if (value === '--domain') args.domain = argv[++i];
    else if (value === '--path') args.path = String(argv[++i]).replace(/^\/+/, '');
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
  --dir <name> Directory in the home to install into (default uberctrl)
  --domain <d> Route a whole domain to the agent. Needs a DNS record at your
               registrar first. Without this, a path on <user>.uber.space is
               used, which works immediately.
  --path <p>   Path on the default domain (default uberctrl)
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

/**
 * Find an existing backend for our port, as "domain/path".
 *
 * A path-only backend prints without a domain — it hangs off the account's
 * default domain, so spell that out rather than returning a hostless URL.
 */
async function findBackend(host, port, user) {
  const backends = await remote(host, 'uberspace web backend list 2>&1 || true');
  const line = backends.split('\n').find((entry) => entry.includes(`http:${port}`));
  if (!line) return null;

  const target = line.trim().split(/\s+/)[0] ?? '';
  if (!target) return null;
  return target.startsWith('/') ? `${user}.uber.space${target}` : target.replace(/\/$/, '');
}

/** Ask the host itself, so DNS and certificate delays do not mask a working agent. */
async function probe(host, target) {
  try {
    const body = await remote(
      host,
      `curl -sS -m 10 https://${target}/healthz 2>&1 || echo REQUEST_FAILED`,
    );
    const text = body.trim();
    return { ok: text.includes('"ok":true'), body: text.slice(0, 200) };
  } catch (err) {
    return { ok: false, body: err.message };
  }
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
  // Both of these end up inside an ssh command line, so they are checked
  // rather than escaped: a value that does not look right is refused.
  if (!/^[A-Za-z0-9._-]+$/.test(args.path)) {
    fail('--path must be a single plain path segment.');
  }
  if (args.domain !== null && !/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(args.domain)) {
    fail('--domain must be a domain name.');
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
    `cd ~/${args.dir} && UBERCTRL_PORT=${args.port} bash packages/agent/deploy/install.sh`,
  ]);

  // --- 5. make it reachable ------------------------------------------------
  // This is the step that used to be left to the user, and it is the one that
  // goes wrong: a backend pointing at the wrong port, or a domain whose DNS is
  // not set up yet. Doing it here is the whole point of the tool.
  const user = (await remote(args.host, 'echo "$USER"')).trim();
  let target = await findBackend(args.host, args.port, user);

  if (!target) {
    if (args.domain) {
      say(`Routing ${args.domain} to the agent`);
      // add is idempotent enough: an existing domain just reports as such.
      await remote(args.host, `uberspace web domain add ${args.domain} 2>&1 || true`);
      await remote(
        args.host,
        `uberspace web backend set ${args.domain}/ --http --port ${args.port}`,
      );
      target = args.domain;
    } else {
      // The default domain always exists and already has a certificate, so a
      // path on it works immediately and needs no DNS anywhere.
      say(`Routing ${user}.uber.space/${args.path} to the agent`);
      await remote(
        args.host,
        `uberspace web backend set /${args.path} --http --port ${args.port} --remove-prefix`,
      );
      target = `${user}.uber.space/${args.path}`;
    }
  }

  // --- 6. verify -----------------------------------------------------------
  say('Checking that it answers');
  const health = await probe(args.host, target);

  const token = (await remote(args.host, 'cat ~/.config/uberctrl/token')).trim();
  const status = (
    await remote(args.host, 'supervisorctl status uberctrl-agent 2>&1 || true')
  ).trim();

  say('Done');
  process.stdout.write(`${status}\n`);
  process.stdout.write(
    health.ok
      ? `Endpoint answers: ${health.body}\n`
      : `Endpoint not answering yet: ${health.body}\n` +
        (args.domain
          ? 'A new domain needs its DNS record at your registrar, and the certificate ' +
            'takes a few minutes after that.\n'
          : ''),
  );

  process.stdout.write(
    `\nEnter these in the app:\n\n  URL:   wss://${target}\n  Token: ${token}\n`,
  );

  process.stdout.write('\nThat token grants full control of the account. Treat it as a password.\n');
}

main().catch((err) => fail(err.message));
