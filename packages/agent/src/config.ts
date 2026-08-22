import { homedir, hostname, userInfo } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reported by /healthz and in the hello message, so it answers one question
 * from outside: which build is actually running on the host.
 *
 * It stayed at 0.1.0 through every deploy, which made "did the update land?"
 * unanswerable without SSH — the agent would happily report the same version
 * before and after.
 *
 * Raise it whenever the agent gains or changes a method, and keep it in step
 * with packages/agent/package.json. system.uninstall was added without doing
 * so, and for twenty minutes 0.2.0 meant two different surfaces — one that
 * could take Uberapp off a host and one that could not. A version that does
 * not move is worth as little as no version at all.
 */
export const AGENT_VERSION = '0.3.0';

export interface AgentConfig {
  /** Shared secret the client must present. */
  token: string;
  port: number;
  /**
   * Uberspace routes web backends to the outside interface, so binding to
   * 127.0.0.1 makes the agent unreachable. This must stay 0.0.0.0 unless you
   * know exactly why you are changing it.
   */
  bind: string;
  user: string;
  host: string;
  home: string;
  /** Root that files.* calls are confined to. */
  fileRoot: string;
  /** Requests per minute per connection. */
  rateLimit: number;
}

function readTokenFile(): string | null {
  const path = join(homedir(), '.config', 'uberapp', 'token');
  try {
    const value = readFileSync(path, 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function loadConfig(): AgentConfig {
  const token = process.env.UBERAPP_TOKEN?.trim() || readTokenFile();

  if (!token) {
    throw new Error(
      'No token configured. Set UBERAPP_TOKEN or write one to ~/.config/uberapp/token.\n' +
        'Generate one with:  head -c 32 /dev/urandom | base64',
    );
  }
  if (token.length < 24) {
    throw new Error('Token is too short; use at least 24 characters of real entropy.');
  }

  const port = Number(process.env.UBERAPP_PORT ?? 8399);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`UBERAPP_PORT must be an integer between 1024 and 65535, got ${port}`);
  }

  const home = homedir();

  return {
    token,
    port,
    bind: process.env.UBERAPP_BIND ?? '0.0.0.0',
    user: userInfo().username,
    host: hostname(),
    home,
    fileRoot: process.env.UBERAPP_FILE_ROOT ?? home,
    rateLimit: Number(process.env.UBERAPP_RATE_LIMIT ?? 120),
  };
}
