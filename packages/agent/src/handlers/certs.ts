/**
 * TLS certificates.
 *
 * Uberspace issues and renews certificates by itself and drops them in
 * ~/etc/certificates. Nothing restarts your own services afterwards, so a
 * daemon that read the files at startup keeps presenting the old certificate
 * until it is restarted — the manual's answer is "restart once a month and
 * remember to". There is no command for it, which makes this the one place
 * where the app does something the CLI genuinely cannot.
 *
 * The watcher is deliberately dumb: it compares the newest certificate mtime
 * against the last one it acted on, and restarts the services the user chose.
 * No inotify, no daemon of its own — a poll every half hour is plenty for a
 * file that changes every few weeks.
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import type { CertInfo, CertWatchConfig } from '@uberctrl/protocol';
import { isValidServiceName } from '@uberctrl/protocol';
import type { AgentConfig } from '../config.js';
import { run } from '../exec.js';
import { RpcError, type Handler } from '../rpc.js';
import { asObject } from '../validate.js';

export const WATCH_POLL_MS = 30 * 60 * 1000;

export function certDir(config: AgentConfig): string {
  return join(config.home, 'etc', 'certificates');
}

function watchConfigPath(config: AgentConfig): string {
  return join(config.home, '.config', 'uberctrl', 'cert-watch.json');
}

const EMPTY_WATCH: CertWatchConfig = { services: [], lastSeen: null, lastRestart: null };

export async function loadWatchConfig(config: AgentConfig): Promise<CertWatchConfig> {
  try {
    const parsed: unknown = JSON.parse(await readFile(watchConfigPath(config), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY_WATCH };
    const value = parsed as Partial<CertWatchConfig>;
    return {
      // Filter on read as well as on write: the file is editable by hand.
      services: Array.isArray(value.services)
        ? value.services.filter((name): name is string =>
            typeof name === 'string' && isValidServiceName(name),
          )
        : [],
      lastSeen: typeof value.lastSeen === 'number' ? value.lastSeen : null,
      lastRestart: typeof value.lastRestart === 'number' ? value.lastRestart : null,
    };
  } catch {
    return { ...EMPTY_WATCH };
  }
}

async function saveWatchConfig(config: AgentConfig, value: CertWatchConfig): Promise<void> {
  const path = watchConfigPath(config);
  await mkdir(join(config.home, '.config', 'uberctrl'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Read every certificate in the directory.
 *
 * A file that will not parse is reported with null dates rather than dropped:
 * a certificate the agent cannot read is exactly what someone needs to see.
 */
export async function readCertificates(config: AgentConfig): Promise<CertInfo[]> {
  const dir = certDir(config);

  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw RpcError.notFound(`${dir} does not exist yet`);
    }
    throw err;
  }

  const certs: CertInfo[] = [];
  for (const name of names) {
    if (!name.endsWith('.crt')) continue;
    const path = join(dir, name);

    let mtime = 0;
    try {
      mtime = (await stat(path)).mtimeMs;
    } catch {
      continue;
    }

    let notAfter: number | null = null;
    let notBefore: number | null = null;
    try {
      const cert = new X509Certificate(await readFile(path));
      notAfter = Date.parse(cert.validTo);
      notBefore = Date.parse(cert.validFrom);
      if (Number.isNaN(notAfter)) notAfter = null;
      if (Number.isNaN(notBefore)) notBefore = null;
    } catch {
      // Reported below with null dates.
    }

    certs.push({
      domain: name.slice(0, -'.crt'.length),
      path,
      notAfter,
      notBefore,
      daysLeft: notAfter === null ? null : Math.floor((notAfter - Date.now()) / 86_400_000),
      mtime,
    });
  }

  certs.sort((a, b) => {
    // Soonest expiry first; unparsable certificates lead, since they are the
    // ones that need a human.
    if (a.daysLeft === null) return -1;
    if (b.daysLeft === null) return 1;
    return a.daysLeft - b.daysLeft;
  });
  return certs;
}

export function newestMtime(certs: CertInfo[]): number | null {
  if (certs.length === 0) return null;
  return certs.reduce((newest, cert) => Math.max(newest, cert.mtime), 0);
}

const list: Handler = async (_params, ctx) => readCertificates(ctx.config);

const watchGet: Handler = async (_params, ctx) => loadWatchConfig(ctx.config);

const watchSet: Handler = async (params, ctx) => {
  const p = asObject(params);
  const raw = p['services'];
  if (!Array.isArray(raw)) throw RpcError.badRequest('services must be an array of service names');
  if (raw.length > 32) throw RpcError.badRequest('At most 32 services can be watched');

  const services: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !isValidServiceName(entry)) {
      throw RpcError.badRequest(`"${String(entry)}" is not a valid service name`);
    }
    services.push(entry);
  }

  const current = await loadWatchConfig(ctx.config);
  // Adopt the current state as already handled, so switching the watcher on
  // does not immediately restart everything.
  const certs = await readCertificates(ctx.config).catch(() => [] as CertInfo[]);
  const next: CertWatchConfig = {
    services,
    lastSeen: newestMtime(certs) ?? current.lastSeen,
    lastRestart: current.lastRestart,
  };

  await saveWatchConfig(ctx.config, next);
  return next;
};

/**
 * One pass of the watcher. Returns the services it restarted, if any.
 *
 * Exported so it can be triggered on startup as well as on the timer, and so
 * its decision is testable without a clock.
 */
export function shouldRestart(newest: number | null, lastSeen: number | null): boolean {
  if (newest === null) return false;
  if (lastSeen === null) return false;
  return newest > lastSeen;
}

export async function runWatchPass(
  config: AgentConfig,
  log: (message: string) => void,
): Promise<string[]> {
  const watch = await loadWatchConfig(config);
  if (watch.services.length === 0) return [];

  const certs = await readCertificates(config).catch(() => [] as CertInfo[]);
  const newest = newestMtime(certs);
  if (!shouldRestart(newest, watch.lastSeen)) {
    // Still record the baseline the first time we see certificates at all.
    if (newest !== null && watch.lastSeen === null) {
      await saveWatchConfig(config, { ...watch, lastSeen: newest });
    }
    return [];
  }

  const restarted: string[] = [];
  for (const service of watch.services) {
    const result = await run('supervisorctl', ['restart', service], { timeoutMs: 60_000 });
    if (result.ok) restarted.push(service);
    else log(`could not restart ${service} after certificate renewal: ${result.stderr.trim()}`);
  }

  await saveWatchConfig(config, {
    services: watch.services,
    lastSeen: newest,
    lastRestart: Date.now(),
  });

  if (restarted.length > 0) {
    log(`certificates were renewed; restarted ${restarted.join(', ')}`);
  }
  return restarted;
}

export const certHandlers: Record<string, Handler> = {
  'web.certs.list': list,
  'web.certs.watch.get': watchGet,
  'web.certs.watch.set': watchSet,
};
