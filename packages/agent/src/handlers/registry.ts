/**
 * The method table.
 *
 * Assembling it here rather than in index.ts keeps it importable without
 * starting a server, so a test can check that every method the protocol
 * advertises actually resolves to a handler. That check used to happen only at
 * startup, where a missing entry means a crash on the host instead of a red
 * test on the way there.
 */

import { METHODS } from '@uberapp/protocol';
import type { Handler } from '../rpc.js';
import { authHandlers } from './auth.js';
import { backupHandlers } from './backup.js';
import { certHandlers } from './certs.js';
import { dbHandlers } from './db.js';
import { domainHandlers } from './domains.js';
import { diagnosticsHandlers } from './diagnostics.js';
import { fileHandlers } from './files.js';
import { mailHandlers } from './mail.js';
import { portHandlers } from './ports.js';
import { selfUpdateHandlers } from './selfUpdate.js';
import { serviceHandlers } from './services.js';
import { sieveHandlers } from './sieve.js';
import { systemHandlers } from './system.js';
import { uninstallHandlers } from './uninstall.js';
import { webHandlers } from './web.js';

export const handlers: Record<string, Handler> = {
  ...authHandlers,
  ...systemHandlers,
  ...selfUpdateHandlers,
  ...uninstallHandlers,
  ...serviceHandlers,
  ...webHandlers,
  ...mailHandlers,
  ...fileHandlers,
  ...portHandlers,
  ...backupHandlers,
  ...dbHandlers,
  ...domainHandlers,
  ...sieveHandlers,
  ...certHandlers,
  ...diagnosticsHandlers,
};

/** Methods declared by the protocol with nothing behind them. */
export function missingHandlers(): string[] {
  return METHODS.filter((method) => !handlers[method]);
}

/** Handlers registered under a name the protocol does not declare. */
export function strayHandlers(): string[] {
  const declared = new Set<string>(METHODS);
  return Object.keys(handlers).filter((name) => !declared.has(name));
}
