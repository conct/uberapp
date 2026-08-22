/**
 * The globals Node code takes for granted.
 *
 * ssh2 is written for Node, where `Buffer`, `process` and `setImmediate` are
 * global. Hermes has none of them, and pointing Metro at a `buffer` module does
 * not help: ssh2 never imports it, it just uses the global — so the module
 * fails while it is still being evaluated, with "Property 'Buffer' doesn't
 * exist", before a single line of SSH runs.
 *
 * Imported first by ssh.native.ts. Import order decides evaluation order, so
 * putting it above the ssh2 import is what makes this work; moving it below
 * would restore the crash.
 *
 * Deliberately additive: anything the runtime already provides is left alone,
 * so this cannot shadow a real implementation on a platform that has one.
 */

import { Buffer } from 'buffer';

// Typed loosely on purpose. @types/node describes these as they are in Node,
// which is precisely what this file exists to work around; matching those
// shapes would mean implementing sixty-odd properties nothing here uses.
const globals = globalThis as unknown as Record<string, unknown>;

if (!globals['Buffer']) {
  globals['Buffer'] = Buffer;
}

if (!globals['process']) {
  globals['process'] = {};
}

const process = globals['process'] as Record<string, unknown>;

if (!process['env']) {
  process['env'] = {};
}
if (!process['nextTick']) {
  // Node runs these before the next timer; a microtask is the closest thing
  // available and preserves the ordering ssh2's stream handling relies on.
  process['nextTick'] = (fn: () => void) => {
    void Promise.resolve().then(fn);
  };
}

// Node gives every module a __dirname and __filename. ssh2 reads them while
// looking for its optional native crypto binding — a path that is stubbed out
// here, but the lookup still runs and still crashes if the names are absent.
// Any value works; nothing resolves a real file from them.
if (!globals['__dirname']) {
  globals['__dirname'] = '/';
}
if (!globals['__filename']) {
  globals['__filename'] = '/index.js';
}

if (!globals['setImmediate']) {
  globals['setImmediate'] = (fn: (...args: unknown[]) => void, ...args: unknown[]) =>
    setTimeout(() => fn(...args), 0);
  globals['clearImmediate'] = (handle: unknown) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>);
}

export {};
