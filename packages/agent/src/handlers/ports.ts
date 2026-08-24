/**
 * Firewall ports.
 *
 * Uberspace opens ports on request: `uberspace port add` picks a free number
 * from 40000-61000 (they cannot be chosen), up to 20 per account. A port that
 * is open but has nothing bound to a wildcard address is a silent dead end —
 * the most common reason "my service is not reachable" — so the listing joins
 * each port with what is actually listening on it.
 */

import {
  failureReason,
  FIREWALL_PORT_RANGE,
  MAX_FIREWALL_PORTS,
  type ListenerInfo,
  type PortInfo,
} from '@uberctrl/protocol';
import { run } from '../exec.js';
import { RpcError, type Handler } from '../rpc.js';
import { asObject, firewallPort } from '../validate.js';

/**
 * Whether a bind address can receive outside traffic. Uberspace requires
 * 0.0.0.0 or ::; a loopback or interface-specific bind is reachable only from
 * the host itself, however open the firewall is.
 */
export function isWildcardAddress(address: string): boolean {
  const normalized = address.replace(/^\[/, '').replace(/\]$/, '');
  return normalized === '0.0.0.0' || normalized === '::' || normalized === '*';
}

/**
 * Parse `uberspace port list`, which prints bare port numbers:
 *
 *   40132
 *   40133
 *
 * Anything that is not a number is prose, not a port.
 */
export function parsePorts(stdout: string): number[] {
  const ports = new Set<number>();

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const port = Number(trimmed);
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }

  return [...ports].sort((a, b) => a - b);
}

/** Pull the assigned number out of the confirmation `uberspace port add` prints. */
export function parseAssignedPort(output: string): number | null {
  const match = /\b(\d{4,5})\b/.exec(output);
  if (!match?.[1]) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) ? port : null;
}

/**
 * Parse `ss -ltunp` output. The Netid column carries the protocol, and udp
 * sockets show as UNCONN rather than LISTEN:
 *
 *   Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
 *   tcp   LISTEN 0      511          0.0.0.0:8080      0.0.0.0:*    users:(("node",pid=1234,fd=20))
 *   udp   UNCONN 0      0                  *:40133            *:*   users:(("dns",pid=42,fd=7))
 */
export function parseListeners(stdout: string): ListenerInfo[] {
  const listeners: ListenerInfo[] = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /^Netid\b/i.test(trimmed)) continue;

    const columns = trimmed.split(/\s+/);
    const netid = columns[0]?.toLowerCase();
    if (netid !== 'tcp' && netid !== 'udp') continue;

    const local = columns[4];
    if (!local) continue;

    // Split on the LAST colon: IPv6 addresses are full of them.
    const separator = local.lastIndexOf(':');
    if (separator === -1) continue;

    const address = local.slice(0, separator);
    const port = Number(local.slice(separator + 1));
    if (!address || !Number.isInteger(port) || port <= 0) continue;

    const processMatch = /users:\(\("([^"]+)",pid=(\d+)/.exec(trimmed);

    listeners.push({
      protocol: netid,
      address,
      port,
      wildcard: isWildcardAddress(address),
      // ss cannot always attribute a socket; an unattributed listener is still
      // a listener and must not be dropped.
      pid: processMatch?.[2] ? Number(processMatch[2]) : null,
      process: processMatch?.[1] ?? '',
    });
  }

  return listeners;
}

/** Read the socket table, or null when ss is unavailable or unreadable. */
async function readListeners(): Promise<ListenerInfo[] | null> {
  const result = await run('ss', ['-ltunp'], { timeoutMs: 15_000 }).catch(() => null);
  if (!result?.ok) return null;
  return parseListeners(result.stdout);
}

const listeners: Handler = async () => {
  const found = await readListeners();
  if (found === null) {
    throw RpcError.commandFailed('Could not read the socket table (ss is unavailable)');
  }
  return found.sort((a, b) => a.port - b.port);
};

const list: Handler = async () => {
  const result = await run('uberspace', ['port', 'list'], { timeoutMs: 30_000 });
  if (!result.ok) {
    throw RpcError.commandFailed(
      failureReason(result.stderr || result.stdout, 'Could not list ports'),
      result.stderr || result.stdout,
    );
  }

  // A failure here must not fail the whole call: the port list is still useful
  // without reachability, and null means "unknown", not "nothing is listening".
  const sockets = await readListeners();

  return parsePorts(result.stdout).map((port): PortInfo => {
    const matching = sockets?.filter((socket) => socket.port === port) ?? [];
    return {
      port,
      listeners: matching,
      reachable: sockets === null ? null : matching.some((socket) => socket.wildcard),
    };
  });
};

const add: Handler = async () => {
  // The number is assigned by the platform; there is nothing to pass.
  const result = await run('uberspace', ['port', 'add'], { timeoutMs: 60_000 });
  const output = (result.stdout + result.stderr).trim();

  if (!result.ok) {
    throw RpcError.commandFailed(failureReason(output, 'Could not open a port'), output);
  }

  return {
    port: parseAssignedPort(output),
    output,
    range: FIREWALL_PORT_RANGE,
    limit: MAX_FIREWALL_PORTS,
  };
};

const del: Handler = async (params) => {
  const p = asObject(params);
  const port = firewallPort(p);

  const result = await run('uberspace', ['port', 'del', String(port)], { timeoutMs: 60_000 });
  const output = (result.stdout + result.stderr).trim();

  if (!result.ok) {
    throw RpcError.commandFailed(failureReason(output, 'Could not close the port'), output);
  }
  return { port, output };
};

export const portHandlers: Record<string, Handler> = {
  'system.listeners': listeners,
  'ports.list': list,
  'ports.add': add,
  'ports.del': del,
};
