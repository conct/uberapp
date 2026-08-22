/**
 * The line of command output that actually names a failure.
 *
 * Uberspace's tooling is Python, and Python reports a failure as a traceback:
 * one generic opening line, a dozen stack frames, and the real reason on the
 * last line. Reading the first line therefore threw away the only part worth
 * showing. A setup against a host whose quota was full failed with the words
 *
 *   Unhandled error:
 *
 * and nothing after the colon, while the cause — `[Errno 122] Disk quota
 * exceeded` — sat at the bottom of the very same text. The message was not
 * missing; it was two hundred characters further down.
 *
 * So: the last line for anything traceback-shaped, the first line otherwise,
 * and the caller's fallback when the command said nothing at all. The first
 * line is still right for the ordinary case — a shell tool that fails with a
 * single sentence puts it there.
 */

/** Python's own marker, which every uberspace tool inherits. */
const TRACEBACK = /^\s*Traceback \(most recent call last\)/m;

export function failureReason(text: string, fallback: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return fallback;

  const line = TRACEBACK.test(text) ? lines[lines.length - 1] : lines[0];
  return line || fallback;
}
