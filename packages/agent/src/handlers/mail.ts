/**
 * Mail domains and mailboxes.
 *
 * `uberspace mail user add` and `... user password` read the password with
 * getpass() from /dev/tty and prompt for it twice. The app therefore collects
 * the mailbox name and the password together and sends them in one call; the
 * agent allocates a pty and answers both prompts. See runInteractive().
 */

import { failureReason, isValidEmail, MIN_MAILBOX_PASSWORD_LENGTH } from '@uberctrl/protocol';
import {
  hasPtySupport,
  redact,
  run,
  runInteractive,
  runOrThrow,
  withoutPrompts,
} from '../exec.js';
import { RpcError, type Handler } from '../rpc.js';
import {
  asObject,
  domainName,
  mailboxName,
  optionalBoolean,
  requireString,
} from '../validate.js';

// --- domains ---------------------------------------------------------------

const domainsList: Handler = async () => {
  const result = await runOrThrow('uberspace', ['mail', 'domain', 'list']);
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((domain) => ({ domain }));
};

const domainsAdd: Handler = async (params) => {
  const p = asObject(params);
  const domain = domainName(p);
  const result = await run('uberspace', ['mail', 'domain', 'add', domain], { timeoutMs: 60_000 });
  if (!result.ok) {
    throw RpcError.commandFailed(
      failureReason(result.stderr || result.stdout, 'Could not add mail domain'),
      result.stderr || result.stdout,
    );
  }
  return { domain, output: (result.stdout + result.stderr).trim() };
};

const domainsDel: Handler = async (params) => {
  const p = asObject(params);
  const domain = domainName(p);
  const result = await run('uberspace', ['mail', 'domain', 'del', domain], { timeoutMs: 60_000 });
  if (!result.ok) {
    throw RpcError.commandFailed(
      failureReason(result.stderr || result.stdout, 'Could not delete mail domain'),
      result.stderr || result.stdout,
    );
  }
  return { domain, output: (result.stdout + result.stderr).trim() };
};

// --- mailboxes -------------------------------------------------------------

const usersList: Handler = async () => {
  const result = await runOrThrow('uberspace', ['mail', 'user', 'list']);
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // The listing may render as "name: something"; keep only the name.
    .map((line) => ({ name: line.split(/[:\s]/)[0] ?? line }))
    .filter((entry) => entry.name.length > 0);
};

/**
 * Validate a password before spending a pty on it.
 *
 * Uberspace enforces a zxcvbn score of 4, which we cannot compute here without
 * pulling in the library. We only catch the obviously-too-weak case locally and
 * let the CLI be the authority; its rejection message is passed back verbatim.
 */
function mailboxPassword(p: Record<string, unknown>): string {
  const password = requireString(p, 'password', { maxLength: 256 });
  if (password.length < MIN_MAILBOX_PASSWORD_LENGTH) {
    throw RpcError.badRequest(
      `Password must be at least ${MIN_MAILBOX_PASSWORD_LENGTH} characters; Uberspace additionally requires a zxcvbn score of 4.`,
    );
  }
  if (/[\r\n]/.test(password)) {
    throw RpcError.badRequest('Password must not contain line breaks');
  }
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7E]/.test(password)) {
    throw RpcError.badRequest(
      'Use ASCII characters only; Uberspace warns that other characters depend on encoding.',
    );
  }
  return password;
}

async function requirePty(): Promise<void> {
  if (!(await hasPtySupport())) {
    throw new RpcError(
      'forbidden',
      'This agent cannot set mailbox passwords: no pty helper available.',
      'The uberspace CLI reads passwords from /dev/tty, so answering it needs a pty. ' +
        'That is done with Python, which no interpreter on this host appears to provide ' +
        '(neither python3 nor python could import the pty module). Create the mailbox over SSH instead.',
    );
  }
}

/**
 * Create a mailbox. Name and password arrive in a single call and are fed to
 * the two consecutive prompts.
 */
const usersAdd: Handler = async (params) => {
  const p = asObject(params);
  const name = mailboxName(p);
  const password = mailboxPassword(p);
  await requirePty();

  const result = await runInteractive('uberspace', ['mail', 'user', 'add', name], {
    // Prompted twice: "Enter a password for the mailbox:" then
    // "Please confirm your password:".
    answers: [password, password],
    timeoutMs: 60_000,
  });

  const output = withoutPrompts(redact(result.stdout + result.stderr, password));

  if (!result.ok || /error|failed|too weak|score/i.test(output)) {
    throw RpcError.commandFailed(failureReason(output, 'Could not create mailbox'), output);
  }
  return { name, output };
};

/** Change a mailbox password; same two-prompt shape as add. */
const usersPassword: Handler = async (params) => {
  const p = asObject(params);
  const name = mailboxName(p);
  const password = mailboxPassword(p);
  await requirePty();

  const result = await runInteractive('uberspace', ['mail', 'user', 'password', name], {
    answers: [password, password],
    timeoutMs: 60_000,
  });

  const output = withoutPrompts(redact(result.stdout + result.stderr, password));

  if (!result.ok || /error|failed|too weak|score/i.test(output)) {
    throw RpcError.commandFailed(failureReason(output, 'Could not change password'), output);
  }
  return { name, output };
};

const usersDel: Handler = async (params) => {
  const p = asObject(params);
  const name = mailboxName(p);
  const result = await run('uberspace', ['mail', 'user', 'del', name], { timeoutMs: 60_000 });
  if (!result.ok) {
    throw RpcError.commandFailed(
      failureReason(result.stderr || result.stdout, 'Could not delete mailbox'),
      result.stderr || result.stdout,
    );
  }
  return { name, output: (result.stdout + result.stderr).trim() };
};

// --- forwards --------------------------------------------------------------
// One forward mailuser works across every mail domain on the account, so these
// take a mailuser rather than a full address.

/**
 * Pull the destination out of `uberspace mail user forward list`.
 *
 * Returns null for "no forward", which the command reports in prose rather
 * than by exiting non-zero.
 */
export function parseForward(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const match = /([^\s<>",;]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

const forwardList: Handler = async (params) => {
  const p = asObject(params);
  const mailbox = mailboxName(p, 'mailbox');
  const result = await run('uberspace', ['mail', 'user', 'forward', 'list', mailbox]);

  // An unset forward is a normal answer, not a failure.
  const output = (result.stdout + result.stderr).trim();
  return { mailbox, target: parseForward(result.stdout), raw: output };
};

const forwardSet: Handler = async (params) => {
  const p = asObject(params);
  const mailbox = mailboxName(p, 'mailbox');
  const target = requireString(p, 'target', { maxLength: 254 });
  if (!isValidEmail(target)) {
    throw RpcError.badRequest(`"${target}" does not look like an email address`);
  }

  const result = await run('uberspace', ['mail', 'user', 'forward', 'set', mailbox, target], {
    timeoutMs: 60_000,
  });
  if (!result.ok) {
    throw RpcError.commandFailed(
      failureReason(result.stderr || result.stdout, 'Could not set the forward'),
      result.stderr || result.stdout,
    );
  }
  return { mailbox, target, output: (result.stdout + result.stderr).trim() };
};

const forwardDel: Handler = async (params) => {
  const p = asObject(params);
  const mailbox = mailboxName(p, 'mailbox');
  const result = await run('uberspace', ['mail', 'user', 'forward', 'del', mailbox], {
    timeoutMs: 60_000,
  });
  if (!result.ok) {
    throw RpcError.commandFailed(
      failureReason(result.stderr || result.stdout, 'Could not delete the forward'),
      result.stderr || result.stdout,
    );
  }
  return { mailbox, output: (result.stdout + result.stderr).trim() };
};

// --- catch-all -------------------------------------------------------------

/** `uberspace mail catchall status` names the mailbox, or says there is none. */
export function parseCatchall(stdout: string): string | null {
  const text = stdout.trim();
  if (!text || /no catchall|not set|disabled/i.test(text)) return null;
  const quoted = /'([^']+)'|"([^"]+)"/.exec(text);
  if (quoted) return quoted[1] ?? quoted[2] ?? null;
  const trailing = /([A-Za-z0-9._-]+)\s*$/.exec(text.split('\n')[0] ?? '');
  return trailing?.[1] ?? null;
}

const catchallStatus: Handler = async () => {
  const result = await run('uberspace', ['mail', 'catchall', 'status']);
  const raw = (result.stdout + result.stderr).trim();
  return { mailbox: parseCatchall(result.stdout), raw };
};

const catchallSet: Handler = async (params) => {
  const p = asObject(params);
  const mailbox = mailboxName(p, 'mailbox');
  const result = await run('uberspace', ['mail', 'catchall', 'set', mailbox], { timeoutMs: 60_000 });
  if (!result.ok) {
    throw RpcError.commandFailed(
      failureReason(result.stderr || result.stdout, 'Could not set the catch-all'),
      result.stderr || result.stdout,
    );
  }
  return { mailbox, output: (result.stdout + result.stderr).trim() };
};

const catchallDel: Handler = async () => {
  const result = await run('uberspace', ['mail', 'catchall', 'del'], { timeoutMs: 60_000 });
  if (!result.ok) {
    throw RpcError.commandFailed(
      failureReason(result.stderr || result.stdout, 'Could not remove the catch-all'),
      result.stderr || result.stdout,
    );
  }
  return { output: (result.stdout + result.stderr).trim() };
};

// --- spam folder -----------------------------------------------------------

export function parseSpamfolder(stdout: string): boolean {
  return /\benabled\b/i.test(stdout) && !/\bdisabled\b/i.test(stdout);
}

const spamfolderStatus: Handler = async () => {
  const result = await run('uberspace', ['mail', 'spamfolder', 'status']);
  const raw = (result.stdout + result.stderr).trim();
  return { enabled: parseSpamfolder(raw), raw };
};

const spamfolderSet: Handler = async (params) => {
  const p = asObject(params);
  const enabled = optionalBoolean(p, 'enabled');
  const result = await run('uberspace', ['mail', 'spamfolder', enabled ? 'enable' : 'disable'], {
    timeoutMs: 60_000,
  });
  if (!result.ok) {
    throw RpcError.commandFailed(
      failureReason(result.stderr || result.stdout, 'Could not change the spam folder'),
      result.stderr || result.stdout,
    );
  }
  return { enabled, output: (result.stdout + result.stderr).trim() };
};

export const mailHandlers: Record<string, Handler> = {
  'mail.domains.list': domainsList,
  'mail.domains.add': domainsAdd,
  'mail.domains.del': domainsDel,
  'mail.users.list': usersList,
  'mail.users.add': usersAdd,
  'mail.users.password': usersPassword,
  'mail.users.del': usersDel,
  'mail.forward.list': forwardList,
  'mail.forward.set': forwardSet,
  'mail.forward.del': forwardDel,
  'mail.catchall.status': catchallStatus,
  'mail.catchall.set': catchallSet,
  'mail.catchall.del': catchallDel,
  'mail.spamfolder.status': spamfolderStatus,
  'mail.spamfolder.set': spamfolderSet,
};
