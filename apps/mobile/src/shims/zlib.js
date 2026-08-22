/**
 * Just enough of node:zlib for ssh2 to finish loading.
 *
 * ssh2 supports zlib compression of the SSH stream, and its wrapper reads a
 * handful of constants and, more awkwardly, does this at module scope:
 *
 *   const ZlibHandle = createInflate()._handle.constructor;
 *
 * So an empty stub is not enough — the call has to return something with a
 * `_handle`, or the module throws while loading and takes the whole SSH
 * client with it.
 *
 * Nothing here compresses anything. The session negotiates `compress: none`
 * (see ssh.native.ts), so these objects are constructed and never used. The
 * write methods throw rather than return wrong data, so that if compression
 * were ever enabled by accident the failure would be loud and obvious instead
 * of a corrupted stream.
 *
 * Constants carry their real values from Node, so that anything reading them
 * for arithmetic gets a sensible answer.
 */

class ZlibHandle {
  init() {}
  params() {}
  reset() {}
  close() {}

  write() {
    throw new Error('SSH stream compression is not available in this app.');
  }

  writeSync() {
    throw new Error('SSH stream compression is not available in this app.');
  }
}

function createInflate() {
  return { _handle: new ZlibHandle() };
}

function createDeflate() {
  return { _handle: new ZlibHandle() };
}

const constants = {
  DEFLATE: 1,
  INFLATE: 2,
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_DEFAULT_CHUNK: 16384,
  Z_DEFAULT_COMPRESSION: -1,
  Z_DEFAULT_MEMLEVEL: 8,
  Z_DEFAULT_STRATEGY: 0,
  Z_DEFAULT_WINDOWBITS: 15,
};

module.exports = { createInflate, createDeflate, constants, ...constants };
