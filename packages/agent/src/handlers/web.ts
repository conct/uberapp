/**
 * Domains, web backends and web logs.
 *
 * All of this is driven through the `uberspace` CLI, which prints
 * human-readable text. The parsers below stay tolerant and always keep the
 * raw line, so a wording change upstream degrades the UI instead of breaking
 * it.
 */

import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { domainToASCII } from 'node:url';
import type {
  BackendInfo,
  ErrorpageCode,
  HeaderInfo,
  WebLogKind,
  WebLogStatus,
} from '@uberctrl/protocol';
import {
  ERRORPAGE_CODES,
  failureReason,
  isValidHeaderName,
  isValidHeaderValue,
} from '@uberctrl/protocol';
import { run, runOrThrow, runStream } from '../exec.js';
import { RpcError, type CallContext, type Handler } from '../rpc.js';
import {
  asObject,
  domainName,
  optionalBoolean,
  optionalNumber,
  port,
  requireEnum,
  requireString,
  toolName,
  webPath,
} from '../validate.js';

// --- domains ---------------------------------------------------------------

const domainsList: Handler = async () => {
  const result = await runOrThrow('uberspace', ['web', 'domain', 'list']);
  const domains = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  // The CLI repeats <user>.uber.space: it is listed as the account's own
  // domain and again among the configured ones. A domain list is a set, and
  // the same name twice is not two things — callers key on it, so the
  // duplicate has to go before it reaches them.
  return [...new Set(domains)].map((domain) => ({ domain }));
};

/**
 * Convert an internationalised domain to punycode.
 *
 * The manual tells you to run `idn` first and paste the result. Node's URL
 * implementation does the same conversion, so the app can just accept
 * "überspace.de" and send what the CLI expects. Returns the input unchanged
 * when it is already ASCII, and null when it cannot be represented at all.
 */
export function toPunycode(domain: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(domain)) return domain;
  const converted = domainToASCII(domain);
  return converted.length > 0 ? converted : null;
}

const domainsAdd: Handler = async (params) => {
  const p = asObject(params);
  const requested = requireString(p, 'domain', { maxLength: 253 });
  const converted = toPunycode(requested);
  if (converted === null) {
    throw RpcError.badRequest(`"${requested}" cannot be converted to a valid domain name`);
  }
  const domain = domainName({ ...p, domain: converted });

  const result = await run('uberspace', ['web', 'domain', 'add', domain], { timeoutMs: 60_000 });
  if (!result.ok) {
    throw RpcError.commandFailed(
      failureReason(result.stderr || result.stdout, 'Could not add domain'),
      result.stderr || result.stdout,
    );
  }
  // The CLI prints the DNS records that still need to be set up; the app shows
  // this verbatim because getting it wrong is the usual reason a domain never
  // goes live.
  return { domain, output: (result.stdout + result.stderr).trim() };
};

const domainsDel: Handler = async (params) => {
  const p = asObject(params);
  const domain = domainName(p);
  const result = await run('uberspace', ['web', 'domain', 'del', domain], { timeoutMs: 60_000 });
  if (!result.ok) {
    throw RpcError.commandFailed(
      failureReason(result.stderr || result.stdout, 'Could not delete domain'),
      result.stderr || result.stdout,
    );
  }
  return { domain, output: (result.stdout + result.stderr).trim() };
};

const recordsShow: Handler = async (params) => {
  const p = asObject(params);
  const domain = domainName(p);
  const result = await run('uberspace', ['records', 'show', domain]);
  return { domain, output: (result.stdout + result.stderr).trim(), ok: result.ok };
};

// --- backends --------------------------------------------------------------

/**
 * Parse `uberspace web backend list`, whose lines look like:
 *
 *   isabell.uber.space/ apache => OK
 *   isabell.example/api http:9000 => OK, listening
 */
export function parseBackends(stdout: string): BackendInfo[] {
  const backends: BackendInfo[] = [];

  for (const line of stdout.split('\n')) {
    const raw = line.trim();
    if (!raw) continue;

    const match = /^(\S+)\s+(\S+)\s*=>\s*(.*)$/.exec(raw);
    if (!match) continue;

    const [, target = '', backend = '', status = ''] = match;
    const slash = target.indexOf('/');
    const domain = slash === -1 ? target : target.slice(0, slash);
    const path = slash === -1 ? '/' : target.slice(slash) || '/';

    const portMatch = /^http:(\d+)$/.exec(backend);

    backends.push({
      domain,
      path,
      type: portMatch ? 'http' : backend,
      port: portMatch?.[1] ? Number(portMatch[1]) : null,
      removePrefix: /remove.?prefix/i.test(raw),
      status: status.trim(),
      raw,
    });
  }

  return backends;
}

const backendsList: Handler = async () => {
  const result = await runOrThrow('uberspace', ['web', 'backend', 'list']);
  return parseBackends(result.stdout);
};

const backendsSet: Handler = async (params) => {
  const p = asObject(params);
  const path = webPath(p, 'path', '/');
  const domain = p['domain'] === undefined ? undefined : domainName(p);
  const targetPort = port(p);
  const removePrefix = optionalBoolean(p, 'removePrefix');

  const target = domain ? `${domain}${path}` : path;
  const args = ['web', 'backend', 'set', target];

  if (targetPort === undefined) {
    args.push('--apache');
    if (removePrefix) {
      throw RpcError.badRequest('--remove-prefix only applies to an http backend');
    }
  } else {
    args.push('--http', '--port', String(targetPort));
    if (removePrefix) args.push('--remove-prefix');
  }

  const result = await run('uberspace', args, { timeoutMs: 60_000 });
  if (!result.ok) {
    throw RpcError.commandFailed(
      failureReason(result.stderr || result.stdout, 'Could not set backend'),
      result.stderr || result.stdout,
    );
  }
  return { target, output: (result.stdout + result.stderr).trim() };
};

const backendsDel: Handler = async (params) => {
  const p = asObject(params);
  const path = webPath(p, 'path', '/');
  const domain = p['domain'] === undefined ? undefined : domainName(p);
  const target = domain ? `${domain}${path}` : path;

  const result = await run('uberspace', ['web', 'backend', 'del', target], { timeoutMs: 60_000 });
  if (!result.ok) {
    throw RpcError.commandFailed(
      failureReason(result.stderr || result.stdout, 'Could not delete backend'),
      result.stderr || result.stdout,
    );
  }
  return { target, output: (result.stdout + result.stderr).trim() };
};

// --- logs ------------------------------------------------------------------

const LOG_KINDS = ['access', 'apache_error', 'php_error'] as const;

/** Paths per the Uberspace manual; php_error sits outside the webserver dir. */
function logPath(home: string, kind: WebLogKind): string {
  switch (kind) {
    case 'access':
      return join(home, 'logs', 'webserver', 'access_log');
    case 'apache_error':
      return join(home, 'logs', 'webserver', 'error_log_apache');
    case 'php_error':
      return join(home, 'logs', 'error_log_php');
  }
}

const logStatus: Handler = async (_params, ctx) => {
  const statuses: WebLogStatus[] = [];

  for (const kind of LOG_KINDS) {
    const result = await run('uberspace', ['web', 'log', kind, 'status']);
    const text = (result.stdout + result.stderr).toLowerCase();
    statuses.push({
      kind,
      // The CLI answers with a sentence; "disabled" contains "enabled", so
      // check for the negative first.
      enabled: !text.includes('disabled') && text.includes('enabled'),
      path: logPath(ctx.config.home, kind),
    });
  }

  return statuses;
};

const logSetEnabled: Handler = async (params) => {
  const p = asObject(params);
  const kind = requireEnum(p, 'kind', LOG_KINDS);
  const enabled = optionalBoolean(p, 'enabled');

  const result = await run('uberspace', ['web', 'log', kind, enabled ? 'enable' : 'disable'], {
    timeoutMs: 30_000,
  });
  if (!result.ok) {
    throw RpcError.commandFailed(
      failureReason(result.stderr || result.stdout, 'Could not change log setting'),
      result.stderr || result.stdout,
    );
  }
  return { kind, enabled, output: (result.stdout + result.stderr).trim() };
};

const logTail: Handler = async (params, ctx: CallContext) => {
  const p = asObject(params);
  const kind = requireEnum(p, 'kind', LOG_KINDS);
  const path = logPath(ctx.config.home, kind);

  try {
    await access(path);
  } catch {
    throw RpcError.notFound(
      `${path} does not exist yet. Enable the ${kind} log first, then wait for the next request.`,
    );
  }

  return new Promise((resolve, reject) => {
    const handle = runStream('tail', ['-n', '200', '-F', path], {
      onChunk: (which, data) => ctx.emit(which, data),
      onDone: () => resolve({ ended: true }),
      onError: (err) => reject(RpcError.commandFailed(err.message)),
    });
    ctx.onCancel(() => handle.cancel());
  });
};

// --- headers ---------------------------------------------------------------

/** The five headers Uberspace sets on every domain unless told otherwise. */
const DEFAULT_HEADERS = new Set([
  'referrer-policy',
  'strict-transport-security',
  'x-content-type-options',
  'x-xss-protection',
  'x-frame-options',
]);

/**
 * Parse `uberspace web header list`, which groups headers under the path they
 * apply to and ends with a section of the defaults:
 *
 *   /blog
 *     X-Clacks-Overhead: GNU Terry Pratchett
 *
 *   Default Headers
 *     X-Frame-Options: SAMEORIGIN
 */
export function parseHeaders(stdout: string): HeaderInfo[] {
  const headers: HeaderInfo[] = [];
  let target = '/';
  let inDefaults = false;

  for (const line of stdout.split('\n')) {
    const raw = line.replace(/\s+$/, '');
    if (!raw.trim()) continue;

    // A non-indented line starts a new group.
    if (!/^\s/.test(raw)) {
      inDefaults = /default/i.test(raw);
      target = inDefaults ? '' : raw.trim().replace(/:$/, '');
      continue;
    }

    const match = /^\s+([^:\s]+)\s*:\s*(.*)$/.exec(raw);
    if (!match?.[1]) continue;

    headers.push({
      target,
      name: match[1],
      value: (match[2] ?? '').trim(),
      isDefault: inDefaults || DEFAULT_HEADERS.has(match[1].toLowerCase()),
      raw: raw.trim(),
    });
  }

  return headers;
}

/**
 * Headers apply to a path, a domain, or a domain plus path. The CLI takes all
 * three in one argument, so it is assembled the same way as for backends.
 */
function headerTarget(p: Record<string, unknown>): string {
  const path = webPath(p, 'path', '/');
  const domain = p['domain'] === undefined ? undefined : domainName(p);
  return domain ? `${domain}${path}` : path;
}

const headersList: Handler = async () => {
  const result = await runOrThrow('uberspace', ['web', 'header', 'list']);
  return parseHeaders(result.stdout);
};

function headerName(p: Record<string, unknown>): string {
  const value = requireString(p, 'name', { maxLength: 128 });
  if (!isValidHeaderName(value)) {
    throw RpcError.badRequest('name must be a header token without spaces or colons');
  }
  return value;
}

const headersSet: Handler = async (params) => {
  const p = asObject(params);
  const target = headerTarget(p);
  const name = headerName(p);
  const value = requireString(p, 'value', { maxLength: 1024 });
  if (!isValidHeaderValue(value)) {
    throw RpcError.badRequest('value must be a single line');
  }

  const result = await run('uberspace', ['web', 'header', 'set', target, name, value], {
    timeoutMs: 60_000,
  });
  if (!result.ok) {
    throw RpcError.commandFailed(
      failureReason(result.stderr || result.stdout, 'Could not set the header'),
      result.stderr || result.stdout,
    );
  }
  return { target, name, value, output: (result.stdout + result.stderr).trim() };
};

const headersSuppress: Handler = async (params) => {
  const p = asObject(params);
  const target = headerTarget(p);
  const name = headerName(p);

  const result = await run('uberspace', ['web', 'header', 'suppress', target, name], {
    timeoutMs: 60_000,
  });
  if (!result.ok) {
    throw RpcError.commandFailed(
      failureReason(result.stderr || result.stdout, 'Could not suppress the header'),
      result.stderr || result.stdout,
    );
  }
  return { target, name, output: (result.stdout + result.stderr).trim() };
};

const headersDel: Handler = async (params) => {
  const p = asObject(params);
  const target = headerTarget(p);
  const name = headerName(p);

  const result = await run('uberspace', ['web', 'header', 'del', target, name], {
    timeoutMs: 60_000,
  });
  if (!result.ok) {
    throw RpcError.commandFailed(
      failureReason(result.stderr || result.stdout, 'Could not delete the header'),
      result.stderr || result.stdout,
    );
  }
  return { target, name, output: (result.stdout + result.stderr).trim() };
};

// --- error page ------------------------------------------------------------

function errorpageCode(p: Record<string, unknown>): string {
  const value = optionalNumber(p, 'code') ?? 500;
  if (!ERRORPAGE_CODES.includes(value as ErrorpageCode)) {
    throw RpcError.badRequest(`code must be one of: ${ERRORPAGE_CODES.join(', ')}`);
  }
  return String(value);
}

const errorpageStatus: Handler = async (params) => {
  const p = asObject(params);
  const code = errorpageCode(p);
  const result = await run('uberspace', ['web', 'errorpage', code, 'status']);
  const raw = (result.stdout + result.stderr).trim();
  return { code: Number(code), enabled: !/disabled/i.test(raw), raw };
};

const errorpageSet: Handler = async (params) => {
  const p = asObject(params);
  const code = errorpageCode(p);
  const enabled = optionalBoolean(p, 'enabled');

  const result = await run(
    'uberspace',
    ['web', 'errorpage', code, enabled ? 'enable' : 'disable'],
    { timeoutMs: 60_000 },
  );
  if (!result.ok) {
    throw RpcError.commandFailed(
      failureReason(result.stderr || result.stdout, 'Could not change the error page'),
      result.stderr || result.stdout,
    );
  }
  return { code: Number(code), enabled, output: (result.stdout + result.stderr).trim() };
};

// --- document root ---------------------------------------------------------

/**
 * Reapply the permissions and SELinux labels a web root needs.
 *
 * Two commands from the manual that always belong together: files uploaded by
 * other means routinely end up unreadable for the webserver, and chmod alone
 * does not fix it because the SELinux label is wrong too.
 */
const fixPermissions: Handler = async (params, ctx) => {
  const p = asObject(params);
  const requested = requireString(p, 'path', { maxLength: 4096 });

  if (requested.includes('\0') || requested.split('/').includes('..')) {
    throw RpcError.badRequest('path must be absolute and free of ".." segments');
  }
  const root = `/var/www/virtual/${ctx.config.user}`;
  if (requested !== root && !requested.startsWith(`${root}/`)) {
    throw RpcError.forbidden(`Only paths under ${root} can be repaired`);
  }

  const chmod = await run('chmod', ['-R', 'u=rwX,go=rX', requested], { timeoutMs: 120_000 });
  if (!chmod.ok) {
    throw RpcError.commandFailed(
      failureReason(chmod.stderr, 'chmod failed'),
      chmod.stderr || chmod.stdout,
    );
  }

  // restorecon is the half people forget; report it separately so a host
  // without SELinux tooling does not look like a failed repair.
  const relabel = await run('restorecon', ['-R', requested], { timeoutMs: 120_000 }).catch(
    (err: Error) => ({ ok: false, stdout: '', stderr: err.message, exitCode: null }),
  );

  return {
    path: requested,
    relabelled: relabel.ok,
    output: [chmod.stdout, relabel.stdout, relabel.ok ? '' : `restorecon: ${relabel.stderr}`]
      .filter(Boolean)
      .join('\n')
      .trim(),
  };
};

// --- tool restart ----------------------------------------------------------

/**
 * `uberspace tools restart <tool>` — the reload that has to follow a change in
 * ~/etc/php.d, and the one people forget before concluding their change had no
 * effect.
 */
const toolsRestart: Handler = async (params) => {
  const p = asObject(params);
  const tool = toolName(p);

  const result = await run('uberspace', ['tools', 'restart', tool], { timeoutMs: 60_000 });
  const output = (result.stdout + result.stderr).trim();
  if (!result.ok) {
    throw RpcError.commandFailed(failureReason(output, `Could not restart ${tool}`), output);
  }
  return { tool, output };
};

export const webHandlers: Record<string, Handler> = {
  'web.domains.list': domainsList,
  'web.domains.add': domainsAdd,
  'web.domains.del': domainsDel,
  'web.records.show': recordsShow,
  'web.backends.list': backendsList,
  'web.backends.set': backendsSet,
  'web.backends.del': backendsDel,
  'web.log.status': logStatus,
  'web.log.setEnabled': logSetEnabled,
  'web.log.tail': logTail,
  'web.headers.list': headersList,
  'web.headers.set': headersSet,
  'web.headers.suppress': headersSuppress,
  'web.headers.del': headersDel,
  'web.errorpage.status': errorpageStatus,
  'web.errorpage.set': errorpageSet,
  'web.docroot.fixPermissions': fixPermissions,
  'tools.restart': toolsRestart,
};
