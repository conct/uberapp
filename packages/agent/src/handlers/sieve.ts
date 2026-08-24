/**
 * Sieve filters.
 *
 * Dovecot's layout, straight from the manual: scripts live in
 * ~/users/<mailbox>/sieve/, and the one that runs is whichever
 * ~/users/<mailbox>/.dovecot.sieve points at. Activating a filter therefore
 * means moving a symlink — the kind of hand work an app should hide.
 *
 * Every write compiles first. A script that fails to compile is never allowed
 * to reach its final name, because a broken active filter does not bounce mail
 * loudly; it just stops sorting and the errors land in a log nobody reads.
 */

import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { SieveScript } from '@uberctrl/protocol';
import { isValidSieveName } from '@uberctrl/protocol';
import { run } from '../exec.js';
import { RpcError, type CallContext, type Handler } from '../rpc.js';
import { asObject, mailboxName, requireString } from '../validate.js';

const MAX_SCRIPT_BYTES = 128 * 1024;

/** ~/users/<mailbox> — where Dovecot keeps a mailbox's state. */
function mailboxDir(ctx: CallContext, mailbox: string): string {
  return join(ctx.config.home, 'users', mailbox);
}

function sieveDir(ctx: CallContext, mailbox: string): string {
  return join(mailboxDir(ctx, mailbox), 'sieve');
}

function activeLink(ctx: CallContext, mailbox: string): string {
  return join(mailboxDir(ctx, mailbox), '.dovecot.sieve');
}

function scriptName(params: Record<string, unknown>, key = 'name'): string {
  const value = requireString(params, key, { maxLength: 64 });
  if (!isValidSieveName(value)) {
    throw RpcError.badRequest('name must end in .sieve and contain no path separators');
  }
  return value;
}

/**
 * Which script the active symlink points at, or null when none is set.
 *
 * ENOENT means no filter was ever activated; EINVAL means .dovecot.sieve is a
 * regular file rather than a link, which Dovecot also accepts but this screen
 * cannot attribute to one of the listed scripts. Both are "nothing selected".
 */
export async function readActive(link: string): Promise<string | null> {
  try {
    return basename(await readlink(link));
  } catch {
    return null;
  }
}

const list: Handler = async (params, ctx) => {
  const p = asObject(params);
  const mailbox = mailboxName(p, 'mailbox');
  const dir = sieveDir(ctx, mailbox);

  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No directory yet simply means no filters, not a broken mailbox.
      return { mailbox, dir, scripts: [], active: null };
    }
    throw err;
  }

  const active = await readActive(activeLink(ctx, mailbox));
  const scripts: SieveScript[] = [];

  for (const name of names) {
    if (!isValidSieveName(name)) continue;
    const path = join(dir, name);
    try {
      const stats = await stat(path);
      if (!stats.isFile()) continue;
      scripts.push({
        name,
        path,
        size: stats.size,
        mtime: stats.mtimeMs,
        active: name === active,
      });
    } catch {
      // Removed between readdir and stat.
    }
  }

  scripts.sort((a, b) => a.name.localeCompare(b.name));
  return { mailbox, dir, scripts, active };
};

const read: Handler = async (params, ctx) => {
  const p = asObject(params);
  const mailbox = mailboxName(p, 'mailbox');
  const name = scriptName(p);
  const path = join(sieveDir(ctx, mailbox), name);

  try {
    const content = await readFile(path, 'utf8');
    return { mailbox, name, path, content };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw RpcError.notFound(`No such filter: ${name}`);
    }
    throw err;
  }
};

/**
 * Write a script, but only if it compiles.
 *
 * The candidate is written under a temporary name, compiled there, and only
 * renamed into place on success — so a syntax error leaves the previous
 * version exactly as it was.
 */
const write: Handler = async (params, ctx) => {
  const p = asObject(params);
  const mailbox = mailboxName(p, 'mailbox');
  const name = scriptName(p);
  const content = requireString(p, 'content', { maxLength: MAX_SCRIPT_BYTES });

  const dir = sieveDir(ctx, mailbox);
  await mkdir(dir, { recursive: true });

  const target = join(dir, name);
  const candidate = join(dir, `.uberctrl-check-${name}`);

  await writeFile(candidate, content, { encoding: 'utf8', mode: 0o600 });

  const cleanup = async () => {
    await rm(candidate, { force: true });
    // sievec drops a .svbin beside whatever it compiled.
    await rm(candidate.replace(/\.sieve$/, '.svbin'), { force: true });
  };

  let compiled;
  try {
    compiled = await run('sievec', [candidate], { timeoutMs: 30_000 });
  } catch (err) {
    await cleanup();
    // Refusing to save is the safe answer: an unchecked filter that fails to
    // compile silently stops sorting mail.
    throw RpcError.commandFailed(
      'sievec could not run, so the filter was not checked and has not been saved',
      (err as Error).message,
    );
  }

  if (!compiled.ok) {
    const detail = (compiled.stderr || compiled.stdout).trim();
    await cleanup();
    throw RpcError.badRequest(detail.split('\n')[0] ?? 'The filter does not compile', detail);
  }

  await rename(candidate, target);
  await rm(candidate.replace(/\.sieve$/, '.svbin'), { force: true });

  return { mailbox, name, path: target, bytes: Buffer.byteLength(content, 'utf8') };
};

const activate: Handler = async (params, ctx) => {
  const p = asObject(params);
  const mailbox = mailboxName(p, 'mailbox');
  const name = scriptName(p);

  const target = join(sieveDir(ctx, mailbox), name);
  try {
    await stat(target);
  } catch {
    throw RpcError.notFound(`No such filter: ${name}`);
  }

  const link = activeLink(ctx, mailbox);
  // symlink() will not replace an existing entry, so clear it first. A missing
  // link is the normal case for a mailbox that never had a filter.
  try {
    await lstat(link);
    await unlink(link);
  } catch {
    // Nothing to remove.
  }

  await symlink(target, link);
  return { mailbox, active: name, link };
};

const del: Handler = async (params, ctx) => {
  const p = asObject(params);
  const mailbox = mailboxName(p, 'mailbox');
  const name = scriptName(p);

  const active = await readActive(activeLink(ctx, mailbox));
  if (active === name) {
    throw RpcError.badRequest(
      `${name} is the active filter. Activate a different one first, or mail will stop being sorted.`,
    );
  }

  const path = join(sieveDir(ctx, mailbox), name);
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw RpcError.notFound(`No such filter: ${name}`);
    }
    throw err;
  }
  return { mailbox, name, deleted: true };
};

export const sieveHandlers: Record<string, Handler> = {
  'mail.sieve.list': list,
  'mail.sieve.read': read,
  'mail.sieve.write': write,
  'mail.sieve.activate': activate,
  'mail.sieve.del': del,
};
