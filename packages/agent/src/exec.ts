/**
 * Process execution for the agent.
 *
 * Three modes, deliberately separated:
 *   run()         — collect output, no shell, argv array only.
 *   runStream()   — long-running/tailing, emits chunks, cancellable.
 *   runInteractive() — drives a pty for commands that read from /dev/tty
 *                      (uberspace mail user add asks for a password twice).
 *
 * Nothing here ever interpolates user input into a shell string. That was true
 * with one exception until the pty path stopped going through `script -qec`,
 * which needed a command line; it now passes argv straight through to a Python
 * helper, so there is no shell anywhere in this file.
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

/**
 * A pty that actually accepts input, written in Python.
 *
 * The obvious tool is `script -qec <cmd> /dev/null`, and that is what this
 * used to be. It allocates a pty, so the command starts — and then nothing we
 * write to the wrapper's stdin reaches the program inside it. Against the real
 * CLI the result was:
 *
 *   Enter a password for the mailbox: Traceback (most recent call last):
 *     ...
 *     passwd = _raw_input(prompt, stream, input=input)
 *     raise EOFError
 *
 * getpass() reads /dev/tty, got end-of-file on the first read, and gave up.
 * `script` forwards stdin only when its own stdin is a terminal; under a
 * daemon it is a pipe, so the pty's input side was empty from the start.
 *
 * Python is not an extra dependency here — the uberspace CLI is itself Python,
 * as that traceback shows. pty.fork() gives a master descriptor we own, so the
 * answers go where the program is actually reading from.
 *
 * Answers arrive on this helper's stdin, one per line, rather than in argv:
 * argv is world-readable in `ps`, and these are passwords.
 */
const PTY_HELPER = `
import os
import pty
import re
import select
import sys

PROMPT = re.compile(r"[:?][ \\t]*$")


def main():
    argv = sys.argv[1:]
    if not argv:
        sys.stderr.write("usage: <command> [args...]\\n")
        return 2

    raw = sys.stdin.read()
    answers = raw.split("\\n") if raw else []

    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(argv[0], argv)
        except Exception:
            os._exit(127)

    pending = b""
    sent = 0
    while True:
        try:
            ready, _, _ = select.select([fd], [], [], 1.0)
        except OSError:
            break
        if not ready:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            # The master raises EIO once the child is gone.
            break
        if not data:
            break

        os.write(1, data)
        pending += data

        if sent < len(answers):
            text = pending.decode("utf-8", "replace").rstrip("\\r\\n")
            if PROMPT.search(text):
                os.write(fd, answers[sent].encode("utf-8") + b"\\n")
                sent += 1
                pending = b""

    _, status = os.waitpid(pid, 0)
    return os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1


sys.exit(main())
`;

/** Tried in order; the first one that can import pty wins. */
const PYTHON_CANDIDATES = ['python3', 'python'];

let ptyCommand: string | null | undefined;

/**
 * The interpreter that can run the helper, or null when there is none.
 *
 * Cached because it cannot change while the agent is running, and the probe
 * costs a process spawn.
 */
async function findPython(): Promise<string | null> {
  if (ptyCommand !== undefined) return ptyCommand;

  for (const candidate of PYTHON_CANDIDATES) {
    try {
      const probe = await run(candidate, ['-c', 'import pty, select'], { timeoutMs: 5000 });
      if (probe.exitCode === 0) {
        ptyCommand = candidate;
        return ptyCommand;
      }
    } catch {
      // Not installed under this name; try the next.
    }
  }

  ptyCommand = null;
  return ptyCommand;
}

/** Whether prompts can be answered at all on this host. */
export async function hasPtySupport(): Promise<boolean> {
  return (await findPython()) !== null;
}

export interface InteractiveOptions extends RunOptions {
  /**
   * Answers fed to successive prompts, in order. One is sent each time the
   * program's output ends with a colon or question mark, until they run out.
   *
   * There is deliberately no way to override that pattern from here: the
   * matching happens inside the pty helper, which is the only side that can
   * see the output as it arrives, and an option that quietly did nothing
   * would be worse than none.
   */
  answers: string[];
}

/**
 * Run a command under a pty and answer its prompts.
 *
 * This exists for `uberspace mail user add`, which reads the password with
 * getpass() from /dev/tty. A daemon has no controlling terminal, so without a
 * pty the command fails outright rather than falling back to stdin. Wrapping
 * it in `script` gives it the tty it insists on, and lets the app collect the
 * mailbox name and password in one form and send them in a single call.
 */
export async function runInteractive(
  file: string,
  args: string[],
  opts: InteractiveOptions,
): Promise<RunResult> {
  const python = await findPython();
  if (python === null) {
    throw new CommandError('No Python interpreter with a pty module was found', {
      ok: false,
      stdout: '',
      stderr: '',
      exitCode: null,
    });
  }

  // The helper takes the command in argv and the answers on stdin, so nothing
  // secret is visible in the process list. Prompt detection lives in there,
  // next to the descriptor it has to write to.
  return run(python, ['-c', PTY_HELPER, file, ...args], {
    ...opts,
    input: opts.answers.join('\n'),
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
