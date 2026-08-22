// Metro config for a workspace layout.
//
// The app imports @uberapp/protocol, which lives in this repo rather than in
// the registry. Metro does not follow symlinks out of the project by default,
// so the workspace root has to be watched explicitly and both node_modules
// directories declared.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Without this, a hoisted dependency can be resolved twice and React ends up
// duplicated.
config.resolver.disableHierarchicalLookup = true;

// ---------------------------------------------------------------------------
// Node core modules, for ssh2
// ---------------------------------------------------------------------------
// The simple setup path speaks SSH from the app, and the only maintained way
// to do that is ssh2 — a Node library. It reaches for node:crypto, node:net
// and a handful of stream utilities that React Native does not have, so each
// one is pointed at a replacement here.
//
// This is done with resolveRequest rather than extraNodeModules because Metro
// bundles every platform from one config: web has no native crypto module to
// point at, and must fall through to the stub instead. See
// https://docs.expo.dev/guides/customizing-metro/
const EMPTY = path.resolve(projectRoot, 'src/shims/empty.js');
// ssh2 subclasses http.Agent at module scope, so that one needs a real class.
const HTTP = path.resolve(projectRoot, 'src/shims/http.js');
// ssh2 calls createInflate()._handle.constructor while loading, so this one
// needs shape too, not just presence.
const ZLIB = path.resolve(projectRoot, 'src/shims/zlib.js');

const NODE_SHIMS = {
  crypto: 'react-native-quick-crypto',
  net: 'react-native-tcp-socket',
  tls: 'react-native-tcp-socket',
  stream: 'readable-stream',
  buffer: 'buffer',
  events: 'events',
  util: 'util',
  assert: 'assert',
  string_decoder: 'string_decoder',
  path: 'path-browserify',
  // The rest are reached for by features this app does not use — compression,
  // HTTP proxy support, a CPU probe that would select a native crypto binding,
  // key files on disk. Metro resolves every require it can see, including ones
  // behind a try/catch, so each needs something to resolve to. An empty object
  // is that something; the guarded paths are never taken here.
  zlib: ZLIB,
  http: HTTP,
  https: HTTP,
  dns: EMPTY,
  fs: EMPTY,
  os: EMPTY,
  tty: EMPTY,
  url: EMPTY,
  constants: EMPTY,
  querystring: EMPTY,
  child_process: EMPTY,
  'cpu-features': EMPTY,
  'node-gyp-build': EMPTY,
};

/** Only these have a real browser equivalent worth shipping. */
const SAFE_ON_WEB = new Set(['buffer', 'events', 'stream', 'util', 'assert', 'string_decoder', 'path']);

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // SSH is never offered in a browser — it needs raw TCP, which browsers do
  // not have. Cutting the module here keeps ssh2 and its dependencies out of
  // the web bundle entirely instead of shipping a megabyte of dead code.
  if (platform === 'web' && /(^|\/)ssh\.native$/.test(moduleName)) {
    return context.resolveRequest(context, EMPTY, platform);
  }

  const bare = moduleName.replace(/^node:/, '');
  const shim = NODE_SHIMS[bare];

  if (shim) {
    const target = platform === 'web' && !SAFE_ON_WEB.has(bare) ? EMPTY : shim;
    return context.resolveRequest(context, target, platform);
  }

  return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
