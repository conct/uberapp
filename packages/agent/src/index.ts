/**
 * Uberapp agent — WebSocket server that runs on the Uberspace host.
 *
 * Runs as a supervisord service and is exposed through a web backend, which
 * gives it the account's Let's Encrypt certificate for free. It must therefore
 * bind to 0.0.0.0 rather than localhost.
 */

import { access } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  PROTOCOL_VERSION,
  STREAMING_METHODS,
  type AuthInfo,
  type Capability,
  type ClientMessage,
  type MethodName,
  type ServerMessage,
} from '@uberapp/protocol';
import { AGENT_VERSION, loadConfig, type AgentConfig } from './config.js';
import { CommandError, hasPtySupport } from './exec.js';
import { RpcError, type CallContext } from './rpc.js';
import { authenticate } from './tokens.js';
import { SNAPSHOT_ROOT } from './handlers/backup.js';
import { runWatchPass, WATCH_POLL_MS } from './handlers/certs.js';
import { hasMysqlCredentials, myCnfPath } from './handlers/db.js';
import { handlers, missingHandlers } from './handlers/registry.js';

// Fail fast on a method that is advertised but not wired up. The test suite
// checks the same thing, so this should never fire on a real host.
const missing = missingHandlers();
if (missing.length > 0) {
  throw new Error(`Protocol declares ${missing.join(', ')} but no handler is registered`);
}

function log(level: 'info' | 'warn' | 'error', message: string, extra?: unknown) {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  if (extra !== undefined) console[level === 'info' ? 'log' : level](line, extra);
  else console[level === 'info' ? 'log' : level](line);
}

class Connection {
  private authed = false;
  private auth: AuthInfo | null = null;
  private readonly inflight = new Map<string, () => void>();
  private timestamps: number[] = [];
  private authTimer: NodeJS.Timeout;
  private heartbeat: NodeJS.Timeout | null = null;
  private pongDeadline: NodeJS.Timeout | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly config: AgentConfig,
    private readonly capabilities: Capability[],
    private readonly remote: string,
  ) {
    this.send({ t: 'hello', protocol: PROTOCOL_VERSION, agent: AGENT_VERSION });

    // An unauthenticated socket is not allowed to linger.
    this.authTimer = setTimeout(() => {
      if (!this.authed) {
        this.send({ t: 'auth.err', message: 'Authentication timed out' });
        this.ws.close(4001, 'auth timeout');
      }
    }, 10_000);

    ws.on('message', (data) => void this.onMessage(data.toString()));
    ws.on('close', () => this.dispose());
    ws.on('error', (err) => log('warn', `socket error from ${remote}`, err.message));
    ws.on('pong', () => {
      if (this.pongDeadline) {
        clearTimeout(this.pongDeadline);
        this.pongDeadline = null;
      }
    });
  }

  private send(message: ServerMessage) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(message));
  }

  private dispose() {
    clearTimeout(this.authTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.pongDeadline) clearTimeout(this.pongDeadline);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    // Kill anything still streaming for this client.
    for (const cancel of this.inflight.values()) {
      try {
        cancel();
      } catch {
        /* best effort */
      }
    }
    this.inflight.clear();
  }

  private startHeartbeat() {
    this.heartbeat = setInterval(() => {
      if (this.ws.readyState !== this.ws.OPEN) return;
      this.ws.ping();
      this.pongDeadline = setTimeout(() => {
        log('warn', `no pong from ${this.remote}, closing`);
        this.ws.terminate();
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private rateLimited(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
    if (this.timestamps.length >= this.config.rateLimit) return true;
    this.timestamps.push(now);
    return false;
  }

  private async onMessage(raw: string) {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send({ t: 'auth.err', message: 'Malformed JSON' });
      this.ws.close(4000, 'bad json');
      return;
    }

    if (message?.t === 'auth') {
      await this.onAuth(message);
      return;
    }

    if (!this.authed) {
      this.send({ t: 'auth.err', message: 'Not authenticated' });
      this.ws.close(4001, 'unauthenticated');
      return;
    }

    switch (message?.t) {
      case 'ping':
        this.send({ t: 'pong' });
        return;
      case 'cancel': {
        const cancel = this.inflight.get(message.id);
        if (cancel) cancel();
        return;
      }
      case 'call':
        await this.onCall(message);
        return;
      default:
        this.send({
          t: 'error',
          id: 'unknown',
          code: 'bad_request',
          message: 'Unrecognized message type',
        });
    }
  }

  private async onAuth(message: Extract<ClientMessage, { t: 'auth' }>) {
    if (this.authed) return;

    // Accepts the master token or any live pairing token; an expired one is
    // indistinguishable from a wrong one from out here, which is the point.
    const auth = await authenticate(this.config, message.token);
    if (!auth) {
      log('warn', `failed auth from ${this.remote}`);
      this.send({ t: 'auth.err', message: 'Invalid token' });
      // Slow down guessing without holding the socket open indefinitely.
      setTimeout(() => this.ws.close(4003, 'invalid token'), 1000);
      return;
    }

    this.authed = true;
    this.auth = auth;
    clearTimeout(this.authTimer);
    this.startHeartbeat();
    log(
      'info',
      `client authenticated from ${this.remote} (${message.client ?? 'unknown'}) ` +
        `using the ${auth.kind} token${auth.label ? ` "${auth.label}"` : ''}`,
    );

    // Close the socket the moment the token stops being valid, rather than
    // letting a paired browser keep working on a credential that has expired.
    if (auth.expiresAt !== null) {
      const remaining = auth.expiresAt - Date.now();
      this.expiryTimer = setTimeout(
        () => {
          this.send({ t: 'auth.err', message: 'This pairing token has expired' });
          this.ws.close(4004, 'token expired');
        },
        Math.max(remaining, 0),
      );
    }

    this.send({
      t: 'auth.ok',
      session: {
        user: this.config.user,
        host: this.config.host,
        protocol: PROTOCOL_VERSION,
        agentVersion: AGENT_VERSION,
        capabilities: this.capabilities,
        auth,
      },
    });
  }

  private async onCall(message: Extract<ClientMessage, { t: 'call' }>) {
    const { id, method } = message;
    if (typeof id !== 'string' || !id) return;

    if (this.rateLimited()) {
      this.send({
        t: 'error',
        id,
        code: 'forbidden',
        message: `Rate limit exceeded (${this.config.rateLimit} calls/minute)`,
      });
      return;
    }

    const handler = handlers[method];
    if (!handler) {
      this.send({ t: 'error', id, code: 'unknown_method', message: `Unknown method: ${method}` });
      return;
    }

    const streaming = STREAMING_METHODS.has(method as MethodName);
    let cancelled = false;
    const cancels: Array<() => void> = [];

    const ctx: CallContext = {
      config: this.config,
      // Set the moment auth succeeds, and a call cannot reach here before
      // that; the fallback exists only to keep the type honest.
      auth: this.auth ?? { kind: 'master', id: null, label: null, expiresAt: null },
      emit: (stream, data) => {
        if (!cancelled) this.send({ t: 'chunk', id, stream, data });
      },
      onCancel: (fn) => cancels.push(fn),
    };

    this.inflight.set(id, () => {
      cancelled = true;
      for (const fn of cancels) fn();
    });

    try {
      const data = await handler(message.params, ctx);
      if (streaming) this.send({ t: 'done', id, exitCode: 0 });
      else this.send({ t: 'result', id, data });
    } catch (err) {
      if (cancelled) {
        this.send({ t: 'done', id, exitCode: null });
      } else if (err instanceof RpcError) {
        this.send({ t: 'error', id, code: err.code, message: err.message, detail: err.detail });
      } else if (err instanceof CommandError) {
        // A missing binary or a non-zero exit is a fact about the host, not a
        // bug in the agent; report it as such rather than as an internal error.
        this.send({ t: 'error', id, code: 'command_failed', message: err.message });
      } else {
        const error = err as Error;
        log('error', `${method} failed`, error.stack ?? error.message);
        this.send({ t: 'error', id, code: 'internal', message: error.message || 'Internal error' });
      }
    } finally {
      this.inflight.delete(id);
    }
  }
}

async function detectCapabilities(): Promise<Capability[]> {
  const capabilities: Capability[] = ['services', 'web', 'mail', 'files', 'monitoring', 'ports'];
  if (await hasPtySupport()) capabilities.push('interactive');
  // Snapshots are a platform feature, not a given: a host without /backup
  // should hide the whole screen rather than fail every call on it.
  try {
    await access(SNAPSHOT_ROOT);
    capabilities.push('backup');
  } catch {
    log('warn', `${SNAPSHOT_ROOT} is not readable — snapshot browsing is disabled.`);
  }

  // Every mysql client here relies on ~/.my.cnf; without it nothing would
  // authenticate and the whole screen would be a list of failures.
  if (await hasMysqlCredentials()) {
    capabilities.push('databases');
  } else {
    log('warn', `${myCnfPath()} is missing — database administration is disabled.`);
  }

  return capabilities;
}

async function main() {
  const config = loadConfig();
  const capabilities = await detectCapabilities();

  if (!capabilities.includes('interactive')) {
    log('warn', 'No pty helper found — creating mailboxes and changing passwords is disabled.');
  }

  // The certificate watcher is the one thing the agent does without a client
  // connected: renewals happen on their own schedule, and a service that needs
  // restarting afterwards should not have to wait for someone to open the app.
  const watchCerts = () => {
    void runWatchPass(config, (message) => log('info', message)).catch((err: Error) =>
      log('warn', `certificate watch failed: ${err.message}`),
    );
  };
  watchCerts();
  setInterval(watchCerts, WATCH_POLL_MS).unref();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agent: AGENT_VERSION, protocol: PROTOCOL_VERSION }));
      return;
    }
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('This endpoint speaks WebSocket only.\n');
  });

  const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 * 1024 });

  wss.on('connection', (ws, req) => {
    // Behind the Uberspace proxy the socket address is the proxy, so prefer
    // the forwarded header for logging.
    const forwarded = req.headers['x-forwarded-for'];
    const remote =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim()) ||
      req.socket.remoteAddress ||
      'unknown';
    new Connection(ws, config, capabilities, remote);
  });

  server.listen(config.port, config.bind, () => {
    log('info', `uberapp agent ${AGENT_VERSION} listening on ${config.bind}:${config.port}`);
    log('info', `user=${config.user} host=${config.host} capabilities=${capabilities.join(',')}`);
  });

  const shutdown = (signal: string) => {
    log('info', `received ${signal}, shutting down`);
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: Error) => {
  log('error', 'agent failed to start', err.message);
  process.exit(1);
});
