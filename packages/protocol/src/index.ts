/**
 * Wire protocol between the Uberapp Expo client and the agent running on the
 * Uberspace host.
 *
 * Design notes:
 *  - The client never sends shell strings. It sends a method name from the
 *    catalog below plus typed params; the agent maps that onto a fixed argv
 *    array. Nothing the user types ever reaches a shell.
 *  - Uberspace kills idle HTTP connections after three minutes, so both sides
 *    must keep the heartbeat running (see HEARTBEAT_INTERVAL_MS).
 */

export const PROTOCOL_VERSION = 1;

/** Well under Uberspace's three minute idle timeout. */
export const HEARTBEAT_INTERVAL_MS = 45_000;
/** If no pong comes back within this window, treat the socket as dead. */
export const HEARTBEAT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { t: 'auth'; token: string; client?: string }
  | { t: 'call'; id: string; method: MethodName; params?: unknown }
  | { t: 'cancel'; id: string }
  | { t: 'ping' };

export type ServerMessage =
  /** Sent on connect, before auth, so the app can detect a wrong endpoint. */
  | { t: 'hello'; protocol: number; agent: string }
  | { t: 'auth.ok'; session: SessionInfo }
  | { t: 'auth.err'; message: string }
  | { t: 'result'; id: string; data: unknown }
  | { t: 'error'; id: string; code: ErrorCode; message: string; detail?: string }
  /** Streaming output for long-running / tailing calls. */
  | { t: 'chunk'; id: string; stream: 'stdout' | 'stderr'; data: string }
  | { t: 'done'; id: string; exitCode: number | null }
  | { t: 'pong' };

export type ErrorCode =
  | 'unauthorized'
  | 'bad_request'
  | 'unknown_method'
  | 'command_failed'
  | 'timeout'
  | 'cancelled'
  | 'not_found'
  | 'forbidden'
  | 'internal';

export interface SessionInfo {
  user: string;
  host: string;
  protocol: number;
  agentVersion: string;
  /** What the agent can actually do, so the app can hide dead UI. */
  capabilities: Capability[];
  /**
   * How this connection authenticated. A paired client holds a token that
   * expires and can be revoked; the UI shows that rather than letting someone
   * discover it when the session dies mid-task.
   */
  auth?: AuthInfo;
}

export interface AuthInfo {
  /** 'master' is the token install.sh generated; 'issued' came from pairing. */
  kind: 'master' | 'issued';
  /** Identifies an issued token so it can be revoked. Null for the master. */
  id: string | null;
  label: string | null;
  /** Unix ms. Null means it does not expire. */
  expiresAt: number | null;
}

export type Capability =
  | 'services'
  | 'web'
  | 'mail'
  | 'files'
  | 'monitoring'
  /** Firewall port management. Absent on agents older than this feature. */
  | 'ports'
  /** Snapshot browsing and restore. Absent when /backup is not readable. */
  | 'backup'
  /** MySQL administration. Absent when ~/.my.cnf holds no credentials. */
  | 'databases'
  /** Only present when a pty helper is available for password prompts. */
  | 'interactive';

// ---------------------------------------------------------------------------
// Method catalog
// ---------------------------------------------------------------------------

export const METHODS = [
  // --- authentication ------------------------------------------------------
  'auth.issueToken',
  'auth.listTokens',
  'auth.revokeToken',

  // --- system / monitoring -------------------------------------------------
  'system.info',
  'system.quota',
  'system.processes',
  'system.listeners',
  'system.toolVersions',
  'system.setToolVersion',
  'system.cron.list',
  'system.cron.set',
  'system.diskUsage',
  'system.deletedFiles',
  'system.memory',
  'system.shell.list',
  'system.shell.set',

  // --- firewall ports ------------------------------------------------------
  'ports.list',
  'ports.add',
  'ports.del',

  // --- supervisord ---------------------------------------------------------
  'services.list',
  'services.control',
  'services.reload',
  'services.remove',
  // Everything remove/deleteConfig/reload do, in the order that works, and
  // tolerant of the steps that were already done.
  'services.delete',
  'services.readConfig',
  'services.writeConfig',
  'services.deleteConfig',
  'services.logs',

  // --- web -----------------------------------------------------------------
  'web.domains.list',
  'web.domains.add',
  'web.domains.del',
  'web.records.show',
  'web.backends.list',
  'web.backends.set',
  'web.backends.del',
  'web.log.status',
  'web.log.setEnabled',
  'web.log.tail',
  'web.certs.list',
  'web.certs.watch.get',
  'web.certs.watch.set',
  'web.headers.list',
  'web.headers.set',
  'web.headers.suppress',
  'web.headers.del',
  'web.errorpage.status',
  'web.errorpage.set',
  'web.docroot.fixPermissions',
  'tools.restart',

  // --- mail ----------------------------------------------------------------
  'mail.domains.list',
  'mail.domains.add',
  'mail.domains.del',
  'mail.users.list',
  'mail.users.add',
  'mail.users.password',
  'mail.users.del',
  'mail.forward.list',
  'mail.forward.set',
  'mail.forward.del',
  'mail.catchall.status',
  'mail.catchall.set',
  'mail.catchall.del',
  'mail.spamfolder.status',
  'mail.spamfolder.set',
  'mail.sieve.list',
  'mail.sieve.read',
  'mail.sieve.write',
  'mail.sieve.activate',
  'mail.sieve.del',

  // --- databases -----------------------------------------------------------
  'db.mysql.list',
  'db.mysql.create',
  'db.mysql.drop',
  'db.mysql.tables',
  'db.mysql.dump',
  'db.mysql.import',

  // --- backup / restore ----------------------------------------------------
  'backup.snapshots',
  'backup.list',
  'backup.preview',
  'backup.restore',
  'backup.db.list',
  'backup.db.restore',

  // --- files / deploy ------------------------------------------------------
  'files.list',
  'files.read',
  'files.write',
  'files.mkdir',
  'files.remove',
  'files.move',
] as const;

export type MethodName = (typeof METHODS)[number];

/** Methods that stream chunk messages and finish with done. */
export const STREAMING_METHODS: ReadonlySet<MethodName> = new Set<MethodName>([
  'services.logs',
  'web.log.tail',
  // rsync's own output is the progress report, so these stream it verbatim
  // instead of making the user wait on a summary.
  'backup.preview',
  'backup.restore',
  'backup.db.restore',
  // A dump or import of a real database outlives the client's call timeout.
  'db.mysql.dump',
  'db.mysql.import',
]);

/** Methods that change state; the app confirms these before firing. */
export const MUTATING_METHODS: ReadonlySet<MethodName> = new Set<MethodName>([
  'auth.issueToken',
  'auth.revokeToken',
  'system.setToolVersion',
  'system.cron.set',
  'system.shell.set',
  'ports.add',
  'ports.del',
  'services.control',
  'services.reload',
  'services.remove',
  'services.delete',
  'services.writeConfig',
  'services.deleteConfig',
  'web.domains.add',
  'web.domains.del',
  'web.backends.set',
  'web.backends.del',
  'web.log.setEnabled',
  'web.certs.watch.set',
  'web.headers.set',
  'web.headers.suppress',
  'web.headers.del',
  'web.errorpage.set',
  'web.docroot.fixPermissions',
  'tools.restart',
  'mail.domains.add',
  'mail.domains.del',
  'mail.users.add',
  'mail.users.password',
  'mail.users.del',
  'mail.forward.set',
  'mail.forward.del',
  'mail.catchall.set',
  'mail.catchall.del',
  'mail.spamfolder.set',
  'mail.sieve.write',
  'mail.sieve.activate',
  'mail.sieve.del',
  'backup.restore',
  'backup.db.restore',
  'db.mysql.create',
  'db.mysql.drop',
  'db.mysql.import',
  'files.write',
  'files.mkdir',
  'files.remove',
  'files.move',
]);

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface SystemInfo {
  user: string;
  hostname: string;
  uptime: string;
  loadAverage: [number, number, number];
  agentVersion: string;
  nodeVersion: string;
}

export interface QuotaInfo {
  /** Bytes used in the home directory. */
  used: number;
  /** Soft limit in bytes; null when the quota output has no limit. */
  limit: number | null;
  percent: number | null;
  /** Raw quota output, shown when parsing fails. */
  raw: string;
}

export interface ProcessInfo {
  pid: number;
  cpu: number;
  mem: number;
  rssKb: number;
  command: string;
}

/** A listening socket belonging to this account, as reported by `ss`. */
export interface ListenerInfo {
  protocol: 'tcp' | 'udp';
  /** Bind address exactly as ss printed it: "0.0.0.0", "[::]", "127.0.0.1", "*". */
  address: string;
  port: number;
  /** True for a bind the firewall can actually expose. Loopback binds cannot. */
  wildcard: boolean;
  pid: number | null;
  /** Process name; empty when ss could not attribute the socket. */
  process: string;
}

/** An open firewall port joined with whatever is listening behind it. */
export interface PortInfo {
  port: number;
  listeners: ListenerInfo[];
  /**
   * Whether traffic can reach a process here. null means the socket table was
   * unreadable — "unknown" must not be rendered as "nothing is listening".
   */
  reachable: boolean | null;
}

/** Uberspace assigns ports from this range; shown so the numbers make sense. */
export const FIREWALL_PORT_RANGE = { min: 40_000, max: 61_000 } as const;
/** Documented per-account cap on open ports. */
export const MAX_FIREWALL_PORTS = 20;

export type ServiceState =
  | 'RUNNING'
  | 'STOPPED'
  | 'STARTING'
  | 'STOPPING'
  | 'BACKOFF'
  | 'EXITED'
  | 'FATAL'
  | 'UNKNOWN';

export interface ServiceInfo {
  name: string;
  state: ServiceState;
  /** supervisord's own description column, e.g. "pid 1234, uptime 0:12:33". */
  description: string;
  pid: number | null;
  uptimeSeconds: number | null;
}

export type ServiceAction = 'start' | 'stop' | 'restart';

export interface ToolVersion {
  tool: string;
  current: string | null;
  available: string[];
}

export interface DomainInfo {
  domain: string;
}

export interface BackendInfo {
  domain: string;
  path: string;
  /** 'apache' or 'http'. */
  type: string;
  port: number | null;
  removePrefix: boolean;
  status: string;
  raw: string;
}

export type WebLogKind = 'access' | 'apache_error' | 'php_error';

export interface WebLogStatus {
  kind: WebLogKind;
  enabled: boolean;
  path: string;
}

export interface MailboxInfo {
  name: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  /** Unix epoch milliseconds. */
  mtime: number;
  mode: string;
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}

/** Result for methods that just run a command and report back. */
export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------
// Lives here rather than only on the agent so the app can validate before
// sending and show inline form errors instead of a failed round-trip.

export const RE_SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const RE_DOMAIN =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const RE_MAILBOX = /^[A-Za-z0-9._-]{1,64}$/;
export const RE_TOOL = /^[a-z0-9_+-]{1,32}$/;
export const RE_VERSION = /^[A-Za-z0-9._-]{1,32}$/;

export function isValidServiceName(v: string): boolean {
  return RE_SERVICE_NAME.test(v);
}
export function isValidDomain(v: string): boolean {
  return RE_DOMAIN.test(v);
}
export function isValidMailbox(v: string): boolean {
  return RE_MAILBOX.test(v);
}
export function isValidPort(v: number): boolean {
  return Number.isInteger(v) && v >= 1024 && v <= 65535;
}
/** Web backend paths are absolute, free of traversal and whitespace. */
export function isValidWebPath(v: string): boolean {
  return v.startsWith('/') && !v.includes('..') && !/\s/.test(v);
}

/** Uberspace requires a mailbox password strong enough for zxcvbn score 4. */
export const MIN_MAILBOX_PASSWORD_LENGTH = 12;

// ---------------------------------------------------------------------------
// Pairing tokens
// ---------------------------------------------------------------------------
// A second client — a browser, another device — should not need the token
// install.sh printed. That one never expires and cannot be taken back without
// restarting the agent. Pairing mints a separate token instead: same
// capabilities, because nothing in this protocol behaves differently in a
// browser, but with an expiry and a revoke button behind it.

export interface IssuedTokenInfo {
  id: string;
  label: string | null;
  createdAt: number;
  /** Unix ms. Null means it does not expire. */
  expiresAt: number | null;
  lastUsedAt: number | null;
  expired: boolean;
}

/** Returned once, at creation. The agent keeps only a hash afterwards. */
export interface IssuedToken extends IssuedTokenInfo {
  token: string;
}

/** Long enough to survive a work session, short enough that a photo of the
 * pairing code goes stale. */
export const DEFAULT_TOKEN_TTL_SECONDS = 12 * 60 * 60;
export const MIN_TOKEN_TTL_SECONDS = 5 * 60;
export const MAX_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MAX_ISSUED_TOKENS = 32;

/**
 * What a pairing code carries: where the agent is, and a token for it.
 *
 * Kept to a short JSON object because it has to survive being rendered as a
 * QR code on one screen and read by a camera pointed at it.
 */
export interface PairingPayload {
  /** Format marker, so a scanner can reject anything else out of hand. */
  v: 1;
  url: string;
  token: string;
  /** Unix ms, so a scanner can refuse an already-dead code before connecting. */
  exp: number | null;
}

export function encodePairing(payload: PairingPayload): string {
  return JSON.stringify(payload);
}

/** Returns null for anything that is not a pairing code, rather than throwing. */
export function decodePairing(text: string): PairingPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const value = parsed as Partial<PairingPayload>;
  if (value.v !== 1) return null;
  if (typeof value.url !== 'string' || typeof value.token !== 'string') return null;
  if (!/^wss?:\/\/\S+$/.test(value.url) || value.token.length < 24) return null;

  const exp = typeof value.exp === 'number' ? value.exp : null;
  return { v: 1, url: value.url, token: value.token, exp };
}

// ---------------------------------------------------------------------------
// Service configuration
// ---------------------------------------------------------------------------
// The ini is built here rather than on the agent so the app can show the exact
// file before writing it, and so one implementation covers both sides.

export interface ServiceSpec {
  name: string;
  /**
   * The command supervisord will run, absolute path plus arguments.
   *
   * This is the one place a user-authored command line legitimately reaches
   * the host: supervisord executes it, not the agent, and it is exactly what
   * hand-writing the ini would produce. It still may not contain a newline,
   * which would inject further directives into the file.
   */
  command: string;
  directory?: string;
  autostart: boolean;
  autorestart: boolean;
  /** Seconds the process must survive before supervisord calls it started. */
  startsecs: number;
  environment?: Record<string, string>;
}

/**
 * supervisord's own default is 1 second, which marks anything slower than
 * instant as failed. 30 is what this project's own service uses and what the
 * app offers; the manual's example goes further still, at 60.
 *
 * The floor exists because the failure it prevents reads as the opposite of
 * what it is: a process that takes longer to come up than its startsecs is
 * reported FATAL while running perfectly well, and the obvious-looking fix —
 * lower the number — makes that more likely, not less. Ten seconds is low
 * enough for a genuinely fast service and high enough that nobody arrives
 * there by trying to silence a warning.
 */
export const DEFAULT_STARTSECS = 30;
export const MIN_STARTSECS = 10;
export const MAX_STARTSECS = 3600;

/** A value that cannot break out of its ini line. */
export function isValidIniValue(value: string): boolean {
  return value.length > 0 && !/[\r\n]/.test(value);
}

/** supervisord quotes environment values, so a quote of our own would break it. */
export function isValidEnvValue(value: string): boolean {
  return !/["\r\n]/.test(value);
}

export const RE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export class ServiceSpecError extends Error {}

/**
 * Render a supervisord program section.
 *
 * Throws ServiceSpecError on anything that would produce a file supervisord
 * silently ignores or misreads — the app turns that into an inline form error.
 */
export function buildServiceIni(spec: ServiceSpec): string {
  if (!isValidServiceName(spec.name)) {
    throw new ServiceSpecError('The service name may only contain letters, digits, . - and _');
  }
  if (!isValidIniValue(spec.command)) {
    throw new ServiceSpecError('The command must be a single line and cannot be empty');
  }
  if (spec.directory !== undefined && !isValidIniValue(spec.directory)) {
    throw new ServiceSpecError('The working directory must be a single line');
  }
  if (
    !Number.isInteger(spec.startsecs) ||
    spec.startsecs < MIN_STARTSECS ||
    spec.startsecs > MAX_STARTSECS
  ) {
    throw new ServiceSpecError(
      `startsecs must be between ${MIN_STARTSECS} and ${MAX_STARTSECS} seconds`,
    );
  }

  const lines = [
    '; created with uberapp',
    `[program:${spec.name}]`,
    `command=${spec.command}`,
  ];

  if (spec.directory) lines.push(`directory=${spec.directory}`);
  lines.push(`autostart=${spec.autostart ? 'yes' : 'no'}`);
  lines.push(`autorestart=${spec.autorestart ? 'yes' : 'no'}`);
  lines.push(`startsecs=${spec.startsecs}`);

  const environment = Object.entries(spec.environment ?? {});
  if (environment.length > 0) {
    const rendered = environment.map(([key, value]) => {
      if (!RE_ENV_KEY.test(key)) {
        throw new ServiceSpecError(`"${key}" is not a valid environment variable name`);
      }
      if (!isValidEnvValue(value)) {
        throw new ServiceSpecError(`The value of ${key} cannot contain quotes or line breaks`);
      }
      return `${key}="${value}"`;
    });
    lines.push(`environment=${rendered.join(',')}`);
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Backup and restore
// ---------------------------------------------------------------------------
// Uberspace exposes snapshots as ordinary directories under /backup, so the
// work is mapping a live path onto its counterpart in a snapshot and keeping
// restores inside what the account actually owns.

export type SnapshotKind = 'daily' | 'weekly';

export interface SnapshotInfo {
  /** Directory name under /backup, e.g. "daily.3". */
  id: string;
  kind: SnapshotKind;
  /** 0 is the most recent daily; weeklies start at 1. */
  index: number;
  /** Directory mtime, roughly when the snapshot was taken. Null if unreadable. */
  mtime: number | null;
}

export interface DumpInfo {
  name: string;
  path: string;
  size: number;
  mtime: number;
  /** "current" is the latest dump per database; "old" keeps dated copies. */
  generation: 'current' | 'old';
}

export const RE_SNAPSHOT = /^(daily\.[0-6]|weekly\.[1-7])$/;

export function isValidSnapshot(value: string): boolean {
  return RE_SNAPSHOT.test(value);
}

/**
 * Directory names Uberspace leaves out of snapshots. Worth surfacing in the
 * UI: content placed here looks backed up and is not.
 */
export const BACKUP_EXCLUDED_DIRS = ['no_backup', 'tmp', 'cache', '.cache'] as const;

/** Documented retention, shown so a missing snapshot is not a mystery. */
export const BACKUP_RETENTION = {
  dailyDays: 7,
  weeklyWeeks: 7,
  databaseDays: 21,
} as const;

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

export interface DatabaseInfo {
  name: string;
  /** Data plus indexes in bytes; null when information_schema reports nothing. */
  size: number | null;
  tables: number | null;
  /** The account's primary database is created by Uberspace and stays. */
  removable: boolean;
}

export interface TableInfo {
  name: string;
  /** InnoDB row counts are estimates, which the UI should say out loud. */
  rows: number | null;
  size: number | null;
  engine: string;
}

/**
 * Uberspace only allows databases named after the account, optionally with an
 * underscore suffix. Enforced here so the app can reject a name in the form
 * rather than after a failed round trip — and so the agent has one place to
 * decide what may be created, dropped or written to.
 *
 * The rule doubles as the reason database names can be interpolated into SQL
 * at all: a name that passes this is letters, digits and underscores only.
 */
export function isOwnDatabase(name: string, user: string): boolean {
  if (name === user) return true;
  if (!name.startsWith(`${user}_`)) return false;
  return /^[A-Za-z0-9_]{1,48}$/.test(name.slice(user.length + 1));
}

/** Longest suffix Uberspace accepts after `<user>_`. */
export const MAX_DB_SUFFIX_LENGTH = 48;

// ---------------------------------------------------------------------------
// Mail: forwards, catch-all, spam and filters
// ---------------------------------------------------------------------------

export interface ForwardInfo {
  mailbox: string;
  /** Destination address, or null when no forward is set. */
  target: string | null;
}

export interface CatchallInfo {
  /** Mailbox receiving unmatched addresses, or null when disabled. */
  mailbox: string | null;
  raw: string;
}

export interface SpamfolderInfo {
  enabled: boolean;
  raw: string;
}

export interface SieveScript {
  name: string;
  path: string;
  size: number;
  mtime: number;
  /** Exactly one script per mailbox can be active at a time. */
  active: boolean;
}

/**
 * Deliberately loose: this only has to reject values that are obviously not an
 * address before they reach the CLI, which does the real validation. Being
 * stricter than the mail system would mean refusing addresses that work.
 */
export const RE_EMAIL = /^[^\s@,;<>"]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && RE_EMAIL.test(value);
}

export const RE_SIEVE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.sieve$/;

export function isValidSieveName(value: string): boolean {
  return RE_SIEVE_NAME.test(value) && !value.includes('..');
}

// ---------------------------------------------------------------------------
// Certificates and web configuration
// ---------------------------------------------------------------------------

export interface CertInfo {
  domain: string;
  path: string;
  /** Unix ms; null when the certificate could not be parsed. */
  notAfter: number | null;
  notBefore: number | null;
  /** Whole days from now until expiry; negative once expired. */
  daysLeft: number | null;
  /** File mtime — when the certificate was last written, i.e. last renewed. */
  mtime: number;
}

/**
 * Which services to restart after a renewal.
 *
 * Uberspace renews certificates for you but does not restart anything, so a
 * service that read the files at startup keeps serving the old certificate
 * until someone notices. The manual's advice is to restart monthly by hand;
 * this replaces the reminder with a watcher.
 */
export interface CertWatchConfig {
  services: string[];
  /** Newest certificate mtime the agent has already acted on. */
  lastSeen: number | null;
  /** Set when the agent restarted something, for the UI to report. */
  lastRestart: number | null;
}

/** Let's Encrypt issues for 90 days and Uberspace renews at 60. */
export const CERT_RENEWAL_DAYS = 30;

export interface HeaderInfo {
  /** Path or domain the header applies to, as printed by the CLI. */
  target: string;
  name: string;
  value: string;
  /** True for the five headers Uberspace sets on every domain. */
  isDefault: boolean;
  raw: string;
}

/**
 * Header names are tokens; values may not carry line breaks, which would let
 * one header inject another.
 */
export const RE_HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

export function isValidHeaderName(value: string): boolean {
  return RE_HEADER_NAME.test(value);
}

export function isValidHeaderValue(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && !/[\r\n]/.test(value);
}

/** HTTP status codes Uberspace can replace with its own error page. */
export const ERRORPAGE_CODES = [500] as const;
export type ErrorpageCode = (typeof ERRORPAGE_CODES)[number];

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface DiskUsageEntry {
  path: string;
  bytes: number;
  /** Set when the path could not be measured, e.g. it does not exist here. */
  error: string | null;
}

export interface DeletedFile {
  pid: number;
  process: string;
  /** Bytes still held by the open handle — the space that will not come back. */
  bytes: number;
  path: string;
}

export interface MemoryUsage {
  /** Resident memory across all the account's processes. */
  rssBytes: number;
  limitBytes: number;
  percent: number;
  processCount: number;
}

/** Uberspace terminates processes above this. */
export const MEMORY_LIMIT_BYTES = 1536 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------
// Parsed on both sides: the app needs it to render an editable list, and
// keeping one implementation means the round trip cannot disagree with itself.

export type CronLineKind = 'job' | 'env' | 'comment' | 'blank';

export interface CronLine {
  /** The original text. An unrecognised line round-trips through unchanged. */
  raw: string;
  kind: CronLineKind;
  /** False for a job that is commented out but still recognisable as one. */
  enabled: boolean;
  schedule: string;
  command: string;
}

const CRON_ALIASES = new Set([
  '@reboot',
  '@yearly',
  '@annually',
  '@monthly',
  '@weekly',
  '@daily',
  '@midnight',
  '@hourly',
]);

/** A job line: five schedule fields plus a command, or an @alias plus one. */
function matchJob(text: string): { schedule: string; command: string } | null {
  const alias = /^(@[a-z]+)\s+(.+)$/.exec(text);
  if (alias?.[1] && CRON_ALIASES.has(alias[1])) {
    return { schedule: alias[1], command: alias[2] ?? '' };
  }

  const fields = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/.exec(text);
  if (!fields?.[1]) return null;
  // Guard against an env assignment being read as a schedule.
  if (fields[1].includes('=')) return null;
  return { schedule: fields[1], command: fields[2] ?? '' };
}

export function parseCrontab(content: string): CronLine[] {
  return content.split('\n').map((raw) => {
    const text = raw.trim();

    if (text.length === 0) {
      return { raw, kind: 'blank' as const, enabled: false, schedule: '', command: '' };
    }

    if (text.startsWith('#')) {
      // A commented-out job is still a job, just switched off.
      const job = matchJob(text.replace(/^#+\s*/, ''));
      if (job) {
        return { raw, kind: 'job' as const, enabled: false, ...job };
      }
      return { raw, kind: 'comment' as const, enabled: false, schedule: '', command: '' };
    }

    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(text)) {
      return { raw, kind: 'env' as const, enabled: true, schedule: '', command: text };
    }

    const job = matchJob(text);
    if (job) return { raw, kind: 'job' as const, enabled: true, ...job };

    return { raw, kind: 'comment' as const, enabled: false, schedule: '', command: text };
  });
}

/** Render lines back to a crontab, preserving everything not deliberately changed. */
export function serializeCrontab(lines: CronLine[]): string {
  const text = lines
    .map((line) => {
      if (line.kind !== 'job') return line.raw;
      const body = `${line.schedule} ${line.command}`.trim();
      return line.enabled ? body : `# ${body}`;
    })
    .join('\n');
  // Some crontab implementations drop the last entry without this.
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * A human-readable schedule, or null when the expression is more complex than
 * a short phrase can honestly describe — the UI then shows the expression.
 */
export function describeSchedule(schedule: string): string | null {
  switch (schedule) {
    case '@reboot':
      return 'beim Start des Servers';
    case '@hourly':
      return 'stündlich';
    case '@daily':
    case '@midnight':
      return 'täglich um Mitternacht';
    case '@weekly':
      return 'wöchentlich';
    case '@monthly':
      return 'monatlich';
    case '@yearly':
    case '@annually':
      return 'jährlich';
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = schedule.split(/\s+/);
  if (!minute || !hour) return null;
  const everyDay = dayOfMonth === '*' && month === '*' && dayOfWeek === '*';
  if (!everyDay) return null;

  const stepped = /^\*\/(\d+)$/.exec(minute);
  if (stepped?.[1] && hour === '*') return `alle ${stepped[1]} Minuten`;

  const steppedHours = /^\*\/(\d+)$/.exec(hour);
  if (steppedHours?.[1] && /^\d+$/.test(minute)) {
    return `alle ${steppedHours[1]} Stunden`;
  }

  if (minute === '*' && hour === '*') return 'jede Minute';
  if (/^\d+$/.test(minute) && hour === '*') return `stündlich zur Minute ${Number(minute)}`;
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    return `täglich um ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }
  return null;
}

/** A starting point that compiles, so a new filter is never an empty file. */
export const SIEVE_TEMPLATE = `require ["fileinto", "mailbox"];

# Alles von dieser Adresse in einen eigenen Ordner
if address :is "from" "absender@example.com" {
  fileinto :create "Projekt";
  stop;
}
`;

// The browser/phone handoff, brokered by a server that never sees the payload.
export * from './handoff.js';

// Reading the reason out of a failed command's output.
export * from './failure.js';
