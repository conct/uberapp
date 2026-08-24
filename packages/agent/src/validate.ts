/**
 * Parameter validation.
 *
 * Every value that ends up in an argv array passes through here first. The
 * patterns are deliberately strict allowlists: a name that does not match is
 * rejected rather than escaped, because the safest handling of a surprising
 * mailbox name is to not run the command at all.
 */

import {
  RE_DOMAIN,
  RE_MAILBOX,
  RE_SERVICE_NAME,
  RE_TOOL,
  RE_VERSION,
  isValidPort,
  isValidWebPath,
} from '@uberctrl/protocol';
import { RpcError } from './rpc.js';

export function asObject(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw RpcError.badRequest('params must be an object');
  }
  return params as Record<string, unknown>;
}

interface StringOptions {
  pattern?: RegExp;
  maxLength?: number;
  /** Human-readable description used in the error message. */
  expected?: string;
}

export function requireString(
  params: Record<string, unknown>,
  key: string,
  opts: StringOptions = {},
): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw RpcError.badRequest(`Missing required string: ${key}`);
  }
  if (opts.maxLength && value.length > opts.maxLength) {
    throw RpcError.badRequest(`${key} is too long (max ${opts.maxLength})`);
  }
  if (opts.pattern && !opts.pattern.test(value)) {
    throw RpcError.badRequest(
      opts.expected ? `${key} must be ${opts.expected}` : `${key} has an invalid format`,
    );
  }
  return value;
}

export function optionalString(
  params: Record<string, unknown>,
  key: string,
  opts: StringOptions = {},
): string | undefined {
  if (params[key] === undefined || params[key] === null) return undefined;
  return requireString(params, key, opts);
}

export function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw RpcError.badRequest(`${key} must be a number`);
  }
  return value;
}

export function optionalBoolean(params: Record<string, unknown>, key: string): boolean {
  const value = params[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw RpcError.badRequest(`${key} must be a boolean`);
  return value;
}

export function requireEnum<T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = params[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw RpcError.badRequest(`${key} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

// --- domain-specific -------------------------------------------------------

export function serviceName(params: Record<string, unknown>, key = 'name'): string {
  return requireString(params, key, {
    pattern: RE_SERVICE_NAME,
    maxLength: 64,
    expected: 'a service name of letters, digits, dot, dash or underscore',
  });
}

export function domainName(params: Record<string, unknown>, key = 'domain'): string {
  return requireString(params, key, {
    pattern: RE_DOMAIN,
    maxLength: 253,
    expected: 'a fully qualified domain name',
  });
}

export function mailboxName(params: Record<string, unknown>, key = 'name'): string {
  return requireString(params, key, {
    pattern: RE_MAILBOX,
    maxLength: 64,
    expected: 'a mailbox name of letters, digits, dot, dash or underscore',
  });
}

export function toolName(params: Record<string, unknown>, key = 'tool'): string {
  return requireString(params, key, { pattern: RE_TOOL, maxLength: 32, expected: 'a tool name' });
}

export function versionString(params: Record<string, unknown>, key = 'version'): string {
  return requireString(params, key, {
    pattern: RE_VERSION,
    maxLength: 32,
    expected: 'a version like 8.2 or 20',
  });
}

export function webPath(params: Record<string, unknown>, key = 'path', fallback = '/'): string {
  const value = optionalString(params, key, { maxLength: 512 });
  if (value === undefined) return fallback;
  if (!isValidWebPath(value)) {
    throw RpcError.badRequest('path must be absolute, without ".." or whitespace');
  }
  return value;
}

/**
 * A firewall port for `uberspace port del`.
 *
 * Deliberately wider than the documented 40000-61000 range: the platform hands
 * these numbers out, and refusing to close one it assigned would leave the
 * account stuck at the 20-port cap with no way down.
 */
export function firewallPort(params: Record<string, unknown>, key = 'port'): number {
  const value = optionalNumber(params, key);
  if (value === undefined) {
    throw RpcError.badRequest(`Missing required number: ${key}`);
  }
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw RpcError.badRequest('port must be an integer between 1 and 65535');
  }
  return value;
}

export function port(params: Record<string, unknown>, key = 'port'): number | undefined {
  const value = optionalNumber(params, key);
  if (value === undefined) return undefined;
  if (!isValidPort(value)) {
    throw RpcError.badRequest('port must be an integer between 1024 and 65535');
  }
  return value;
}
