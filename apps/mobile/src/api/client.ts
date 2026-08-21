/**
 * WebSocket RPC client for the Uberapp agent.
 *
 * Owns one socket and the reconnect policy. Everything the UI does goes
 * through call() or stream(); neither resolves until the socket is authorised,
 * so screens never have to check connection state before firing a request.
 */

import {
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  type ClientMessage,
  type MethodName,
  type ServerMessage,
  type SessionInfo,
} from '@uberapp/protocol';

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'ready'
  | 'reconnecting'
  | 'error';

export interface ConnectionStatus {
  state: ConnectionState;
  session: SessionInfo | null;
  /** Human-readable reason, shown in the UI when state is 'error'. */
  error: string | null;
  /** Number of consecutive failed attempts; resets on success. */
  attempt: number;
}

export class RpcCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'RpcCallError';
  }
}

export interface StreamHandle {
  cancel(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set for streaming calls. */
  onChunk?: (stream: 'stdout' | 'stderr', data: string) => void;
}

const CALL_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

export class UberClient {
  private ws: WebSocket | null = null;
  private url = '';
  private token = '';
  private pending = new Map<string, Pending>();
  private counter = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set while the user deliberately disconnected, to suppress reconnects. */
  private stopped = true;

  private status: ConnectionStatus = {
    state: 'idle',
    session: null,
    error: null,
    attempt: 0,
  };
  private listeners = new Set<(status: ConnectionStatus) => void>();
  /** Resolvers waiting for the socket to become ready. */
  private readyWaiters: Array<{ resolve(): void; reject(err: Error): void }> = [];

  // --- status ------------------------------------------------------------

  getStatus(): ConnectionStatus {
    return this.status;
  }

  subscribe(listener: (status: ConnectionStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(patch: Partial<ConnectionStatus>) {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
  }

  // --- lifecycle ---------------------------------------------------------

  connect(url: string, token: string) {
    this.url = normalizeUrl(url);
    this.token = token;
    this.stopped = false;
    this.setStatus({ attempt: 0, error: null });
    this.open();
  }

  disconnect() {
    this.stopped = true;
    this.clearTimers();
    this.rejectAll(new Error('Disconnected'));
    this.detach();
    this.setStatus({ state: 'idle', session: null, error: null, attempt: 0 });
  }

  private open() {
    if (this.stopped) return;

    // Drop any previous socket first. Without this, calling connect() twice
    // (StrictMode, Fast Refresh, or the user re-entering credentials) leaves an
    // orphan open; the agent times its authentication out and the resulting
    // auth.err would tear down the connection that actually works.
    this.detach();

    this.setStatus({ state: this.status.attempt > 0 ? 'reconnecting' : 'connecting' });

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      this.onFailure((err as Error).message);
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.setStatus({ state: 'authenticating' });
      this.send({ t: 'auth', token: this.token, client: 'uberapp-mobile' });
    };

    socket.onmessage = (event) => {
      // A superseded socket must not be able to change our state.
      if (this.ws !== socket) return;

      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.onMessage(message);
    };

    socket.onerror = () => {
      // The browser/RN WebSocket error event carries no useful detail; the
      // close handler that follows decides what to do.
    };

    socket.onclose = (event) => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.clearTimers();

      // 4003 is an invalid token: retrying cannot help, so stop and say so.
      if (event.code === 4003) {
        this.stopped = true;
        this.rejectAll(new Error('Invalid token'));
        this.setStatus({ state: 'error', error: 'Invalid token', session: null });
        return;
      }
      this.rejectAll(new Error('Connection lost'));
      this.onFailure(event.reason || 'Connection closed');
    };
  }

  private onFailure(reason: string) {
    this.setStatus({
      state: this.stopped ? 'error' : 'reconnecting',
      session: null,
      error: reason,
      attempt: this.status.attempt + 1,
    });
    if (this.stopped) return;

    // Exponential backoff with jitter, so a restarting agent does not get
    // hammered by every client at the same moment.
    const base = Math.min(1000 * 2 ** Math.min(this.status.attempt, 5), MAX_BACKOFF_MS);
    const delay = base / 2 + Math.random() * (base / 2);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private onMessage(message: ServerMessage) {
    switch (message.t) {
      case 'hello':
        if (message.protocol !== PROTOCOL_VERSION) {
          this.stopped = true;
          this.ws?.close();
          this.setStatus({
            state: 'error',
            error: `Agent speaks protocol v${message.protocol}, this app speaks v${PROTOCOL_VERSION}. Update one of them.`,
          });
        }
        return;

      case 'auth.ok':
        this.setStatus({ state: 'ready', session: message.session, error: null, attempt: 0 });
        this.startHeartbeat();
        for (const waiter of this.readyWaiters.splice(0)) waiter.resolve();
        return;

      case 'auth.err':
        this.stopped = true;
        this.setStatus({ state: 'error', error: message.message, session: null });
        for (const waiter of this.readyWaiters.splice(0)) {
          waiter.reject(new Error(message.message));
        }
        return;

      case 'result': {
        const pending = this.take(message.id);
        pending?.resolve(message.data);
        return;
      }

      case 'error': {
        const pending = this.take(message.id);
        pending?.reject(new RpcCallError(message.code, message.message, message.detail));
        return;
      }

      case 'chunk': {
        this.pending.get(message.id)?.onChunk?.(message.stream, message.data);
        return;
      }

      case 'done': {
        const pending = this.take(message.id);
        pending?.resolve({ exitCode: message.exitCode });
        return;
      }

      case 'pong':
        return;
    }
  }

  private take(id: string): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(id);
    return pending;
  }

  private rejectAll(err: Error) {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(err);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    // Uberspace drops idle connections after three minutes; this keeps the
    // proxy from closing a socket the user has simply left open.
    this.heartbeat = setInterval(() => this.send({ t: 'ping' }), HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /**
   * Silence and close the current socket without triggering the reconnect
   * path: its handlers are removed first, so its close event is a no-op.
   */
  private detach() {
    const socket = this.ws;
    if (!socket) return;
    this.ws = null;

    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close(1000, 'superseded');
    } catch {
      /* already closing */
    }
  }

  private clearTimers() {
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private send(message: ClientMessage) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(message));
  }

  /** Resolves once authenticated, so screens can fire calls immediately. */
  private waitUntilReady(timeoutMs = 15_000): Promise<void> {
    if (this.status.state === 'ready') return Promise.resolve();
    if (this.stopped) {
      return Promise.reject(new Error(this.status.error ?? 'Not connected'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Not connected')), timeoutMs);
      this.readyWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  // --- calls -------------------------------------------------------------

  async call<T = unknown>(method: MethodName, params?: unknown): Promise<T> {
    await this.waitUntilReady();
    const id = `c${++this.counter}`;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcCallError('timeout', `${method} timed out`));
      }, CALL_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.send({ t: 'call', id, method, params });
    });
  }

  /**
   * Start a streaming call (log tails). Chunks arrive through onChunk; the
   * returned handle cancels the stream on the agent side.
   */
  stream(
    method: MethodName,
    params: unknown,
    onChunk: (stream: 'stdout' | 'stderr', data: string) => void,
    onEnd?: (err?: Error) => void,
  ): StreamHandle {
    const id = `s${++this.counter}`;
    let cancelled = false;

    void this.waitUntilReady()
      .then(() => {
        if (cancelled) return;
        this.pending.set(id, {
          resolve: () => onEnd?.(),
          reject: (err) => onEnd?.(err),
          // A tail has no deadline; it runs until cancelled.
          timer: null,
          onChunk,
        });
        this.send({ t: 'call', id, method, params });
      })
      .catch((err: Error) => onEnd?.(err));

    return {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        const pending = this.take(id);
        this.send({ t: 'cancel', id });
        pending?.resolve(undefined);
      },
    };
  }
}

/**
 * Accept what a user is likely to type and turn it into a socket URL.
 * A bare host, an https:// URL or a wss:// URL all end up as wss://.
 */
export function normalizeUrl(input: string): string {
  let value = input.trim().replace(/\/+$/, '');
  if (!value) return value;

  if (value.startsWith('https://')) value = `wss://${value.slice('https://'.length)}`;
  else if (value.startsWith('http://')) value = `ws://${value.slice('http://'.length)}`;
  else if (!/^wss?:\/\//.test(value)) value = `wss://${value}`;

  return value;
}

/** The matching https:// URL, used for the /healthz probe. */
export function httpUrl(socketUrl: string): string {
  return normalizeUrl(socketUrl)
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://');
}

export const client = new UberClient();
