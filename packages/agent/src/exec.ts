/**
 * Process execution for the agent.
 *
 * Three modes, deliberately separated:
 *   run()         — collect output, no shell, argv array only.
 *   runStream()   — long-running/tailing, emits chunks, cancellable.
 *   runInteractive() — drives a pty for commands that read from /dev/tty
 *                      (uberspace mail user add asks for a password twice).
 *
 * Nothing here ever interpolates user input into a shell string except in
 * runInteractive(), which has to go through `script -qec` to get a tty. That
 * path quotes every argument and its callers only pass regex-validated values.
 */

import {
  spawn,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
  /** Written to stdin, then stdin is closed. */
  input?: string;
  /** Cap on captured output; protects the agent from a runaway command. */
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export class CommandError extends Error {
  constructor(
    message: string,
    readonly result: RunResult,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

/**
 * Turn a spawn failure into something a user can act on. "spawn quota ENOENT"
 * is a Node implementation detail; "quota is not installed" is a fact about
 * the host.
 */
function describeSpawnError(err: NodeJS.ErrnoException, file: string): Error {
  if (err.code === 'ENOENT') {
    return new CommandError(`Command not available on this host: ${file}`, {
      ok: false,
      stdout: '',
      stderr: '',
      exitCode: null,
    });
  }
  if (err.code === 'EACCES') {
    return new CommandError(`Not allowed to run ${file} on this host`, {
      ok: false,
      stdout: '',
      stderr: '',
      exitCode: null,
    });
  }
  return err;
}

/**
 * Run a command with a fixed argv. Never uses a shell.
 */
export function run(file: string, args: string[] = [], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(describeSpawnError(err as NodeJS.ErrnoException, file));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new CommandError(`Command timed out after ${timeoutMs}ms: ${file}`, {
          ok: false,
          stdout,
          stderr,
          exitCode: null,
        }),
      );
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (stdout.length < maxBytes) stdout += d;
    });
    child.stderr.on('data', (d: string) => {
      if (stderr.length < maxBytes) stderr += d;
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(describeSpawnError(err as NodeJS.ErrnoException, file));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, exitCode: code });
    });

    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** Like run(), but throws when the command exits non-zero. */
export async function runOrThrow(
  file: string,
  args: string[] = [],
  opts: RunOptions = {},
): Promise<RunResult> {
  const result = await run(file, args, opts);
  if (!result.ok) {
    const detail = (result.stderr || result.stdout).trim().split('\n')[0] ?? '';
    throw new CommandError(detail || `${file} exited with code ${result.exitCode}`, result);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export interface StreamHandle {
  /** Terminate the process; safe to call more than once. */
  cancel(): void;
}

export interface StreamCallbacks {
  onChunk(stream: 'stdout' | 'stderr', data: string): void;
  onDone(exitCode: number | null): void;
  onError(err: Error): void;
}

/**
 * Spawn a long-running command (log tails) and stream its output.
 */
export function runStream(
  file: string,
  args: string[],
  cb: StreamCallbacks,
  opts: { cwd?: string } = {},
): StreamHandle {
  // stdin is intentionally closed: a log tail has nothing to read.
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(file, args, {
      cwd: opts.cwd,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    cb.onError(describeSpawnError(err as NodeJS.ErrnoException, file));
    return { cancel() {} };
  }

  let closed = false;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => cb.onChunk('stdout', d));
  child.stderr.on('data', (d: string) => cb.onChunk('stderr', d));
  child.on('error', (err) => {
    if (closed) return;
    closed = true;
    cb.onError(describeSpawnError(err as NodeJS.ErrnoException, file));
  });
  child.on('close', (code) => {
    if (closed) return;
    closed = true;
    cb.onDone(code);
  });

  return {
    cancel() {
      if (closed) return;
      closed = true;
      child.kill('SIGTERM');
      // tail can ignore SIGTERM if it is blocked on a read; make sure it dies.
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      cb.onDone(null);
    },
  };
}

/**
 * Run `a | b` without a shell.
 *
 * Restoring a database dump means feeding a compressed file into a client, and
 * the obvious `xzcat f | mysql db` would need a shell string. Wiring the two
 * child processes together directly keeps both sides as argv arrays.
 *
 * The second command's exit code is the result: it is the one that decides
 * whether the data actually landed.
 */
export function runPipe(
  a: { file: string; args: string[] },
  b: { file: string; args: string[] },
  cb: StreamCallbacks,
): StreamHandle {
  let first: ChildProcessByStdio<null, Readable, Readable>;
  let second: ChildProcessByStdio<Writable, Readable, Readable>;

  try {
    first = spawn(a.file, a.args, { env: process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    cb.onError(describeSpawnError(err as NodeJS.ErrnoException, a.file));
    return { cancel() {} };
  }

  try {
    second = spawn(b.file, b.args, { env: process.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    first.kill('SIGKILL');
    cb.onError(describeSpawnError(err as NodeJS.ErrnoException, b.file));
    return { cancel() {} };
  }

  let closed = false;
  const fail = (err: NodeJS.ErrnoException, file: string) => {
    if (closed) return;
    closed = true;
    first.kill('SIGKILL');
    second.kill('SIGKILL');
    cb.onError(describeSpawnError(err, file));
  };

  first.stdout.pipe(second.stdin);
  // A reader that exits early (bad dump, wrong database) would otherwise crash
  // the agent with EPIPE on the writer side.
  second.stdin.on('error', () => first.kill('SIGTERM'));

  for (const [child, label] of [
    [first, a.file],
    [second, b.file],
  ] as const) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => cb.onChunk('stderr', d));
    child.on('error', (err) => fail(err as NodeJS.ErrnoException, label));
  }

  second.stdout.setEncoding('utf8');
  second.stdout.on('data', (d: string) => cb.onChunk('stdout', d));

  second.on('close', (code) => {
    if (closed) return;
    closed = true;
    first.kill('SIGTERM');
    cb.onDone(code);
  });

  return {
    cancel() {
      if (closed) return;
      closed = true;
      first.kill('SIGTERM');
      second.kill('SIGTERM');
      cb.onDone(null);
    },
  };
}

// ---------------------------------------------------------------------------
// Interactive (pty) execution
// ---------------------------------------------------------------------------

/** POSIX single-quote escaping. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

let ptySupport: boolean | null = null;

/**
 * Whether a pty helper is available. Uberspace runs AlmaLinux, where
 * util-linux provides `script`, but we verify instead of assuming.
 */
export async function hasPtySupport(): Promise<boolean> {
  if (ptySupport !== null) return ptySupport;
  try {
    const probe = await run('script', ['-qec', 'true', '/dev/null'], { timeoutMs: 5000 });
    ptySupport = probe.exitCode === 0;
  } catch {
    ptySupport = false;
  }
  return ptySupport;
}

export interface InteractiveOptions extends RunOptions {
  /**
   * Answers fed to successive prompts, in order. An answer is sent whenever
   * the child's output ends with a prompt (a colon, optionally followed by
   * whitespace) and answers remain.
   */
  answers: string[];
  /** Extra regex a chunk must match to count as a prompt. */
  promptPattern?: RegExp;
}

const DEFAULT_PROMPT = /[:?]\s*$/;

/**
 * Run a command under a pty and answer its prompts.
 *
 * This exists for `uberspace mail user add`, which reads the password with
 * getpass() from /dev/tty. A daemon has no controlling terminal, so without a
 * pty the command fails outright rather than falling back to stdin. Wrapping
 * it in `script` gives it the tty it insists on, and lets the app collect the
 * mailbox name and password in one form and send them in a single call.
 */
export function runInteractive(
  file: string,
  args: string[],
  opts: InteractiveOptions,
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const promptRe = opts.promptPattern ?? DEFAULT_PROMPT;
  const commandLine = [file, ...args].map(shellQuote).join(' ');

  return new Promise((resolve, reject) => {
    const child = spawn('script', ['-qec', commandLine, '/dev/null'], {
      env: { ...process.env, TERM: 'dumb' },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // A pty echoes everything back on stdout, so stderr is usually empty here.
    let output = '';
    let settled = false;
    const pending = [...opts.answers];
    // The pty echoes our own newline, which can re-trigger the prompt match.
    // Only answer once per quiet period.
    let answering = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new CommandError(`Interactive command timed out after ${timeoutMs}ms: ${file}`, {
          ok: false,
          stdout: output,
          stderr: '',
          exitCode: null,
        }),
      );
    }, timeoutMs);

    const maybeAnswer = () => {
      if (settled || answering || pending.length === 0) return;
      if (!promptRe.test(output.trimEnd() + (output.endsWith(' ') ? ' ' : ''))) {
        if (!promptRe.test(output)) return;
      }
      answering = true;
      const answer = pending.shift() as string;
      child.stdin.write(answer + '\n');
      // Give the child a moment to consume the answer and print the next
      // prompt before we consider answering again.
      setTimeout(() => {
        answering = false;
        maybeAnswer();
      }, 250).unref();
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      output += d;
      maybeAnswer();
    });
    child.stderr.on('data', (d: string) => {
      output += d;
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(describeSpawnError(err as NodeJS.ErrnoException, 'script'));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: output, stderr: '', exitCode: code });
    });
  });
}

/**
 * Strip a secret from text before it is logged or returned to the client.
 * A pty echoes input, and while getpass suppresses echo we cannot rely on it.
 */
export function redact(text: string, ...secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out;
}
