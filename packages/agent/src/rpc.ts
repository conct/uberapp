import type { ErrorCode } from '@uberapp/protocol';
import type { AgentConfig } from './config.js';

export class RpcError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }

  static badRequest(message: string, detail?: string) {
    return new RpcError('bad_request', message, detail);
  }
  static notFound(message: string) {
    return new RpcError('not_found', message);
  }
  static forbidden(message: string) {
    return new RpcError('forbidden', message);
  }
  static commandFailed(message: string, detail?: string) {
    return new RpcError('command_failed', message, detail);
  }
}

export interface CallContext {
  config: AgentConfig;
  /** Streaming handlers push output through this. */
  emit(stream: 'stdout' | 'stderr', data: string): void;
  /** Register cleanup to run if the client cancels or disconnects. */
  onCancel(fn: () => void): void;
}

export type Handler = (params: unknown, ctx: CallContext) => Promise<unknown>;
