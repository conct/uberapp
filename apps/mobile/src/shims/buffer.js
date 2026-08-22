/**
 * The buffer polyfill, plus the internal Buffer methods ssh2 uses.
 *
 * Node's Buffer carries a second, undocumented set of methods that come from
 * its C++ binding — utf8Write, latin1Slice, hexSlice and friends. They are not
 * part of the documented API, so the buffer package (5.7.1) does not implement
 * them. ssh2 uses them throughout anyway, because in Node they are there and
 * they skip an argument-parsing layer:
 *
 *   buf.latin1Write('SSH-2.0-', 0, 8)        // lib/protocol/Protocol.js
 *   const full = data.latin1Slice(op, end + 1);
 *
 * utf8Write alone appears 136 times across the library, in every packet it
 * builds. Without these, ssh2 connects, receives the server's identification
 * banner, and dies reading it:
 *
 *   TypeError: undefined is not a function
 *       at parseHeader
 *
 * Each one maps onto the documented API exactly — same arguments, same return
 * value, same encoding names — so these are the standard methods under their
 * internal names, not reimplementations:
 *
 *   buf.<enc>Write(string, offset, length)  ->  buf.write(string, offset, length, enc)
 *   buf.<enc>Slice(start, end)              ->  buf.toString(enc, start, end)
 *
 * The prototype is patched in place rather than subclassed. Buffers arrive
 * here from everywhere — the socket, quick-crypto, ssh2's own allocations —
 * and a subclass would only cover the ones this module happened to create.
 *
 * The require below is 'buffer/' with a trailing slash on purpose: that is the
 * package, where a bare 'buffer' would come back through the alias table in
 * metro.config.js to this file.
 */

const buffer = require('buffer/');

/** The encodings ssh2 reaches for, under the names Node's binding uses. */
const ENCODINGS = ['utf8', 'latin1', 'ascii', 'hex', 'base64', 'ucs2'];

/**
 * Give Buffer a Symbol.species, which Hermes does not.
 *
 * ssh2 takes its fast Buffer constructor from there, at module scope, in three
 * separate files:
 *
 *   const FastBuffer = Buffer[Symbol.species];   // protocol/crypto.js:15
 *                                                // protocol/utils.js:7
 *                                                // protocol/SFTP.js:12
 *
 * In Node that resolves to Buffer itself: Buffer extends Uint8Array, and
 * %TypedArray%[Symbol.species] is a getter that returns the constructor it was
 * read from. Hermes does not implement Symbol.species on the built-ins, so the
 * whole expression is undefined and FastBuffer is undefined with it.
 *
 * Nothing complains at load. The failure waits for the first packet that has
 * to be unwrapped — every decrypt path builds its payload with
 * `new FastBuffer(...)` — so the handshake gets all the way through the
 * banner and the key exchange before it dies:
 *
 *   TypeError: undefined cannot be used as a constructor.
 *       at decrypt
 *       at parsePacket
 *
 * Returning the constructor itself is exactly what Node's getter does, and
 * `new Buffer(arrayBuffer, byteOffset, length)` makes a view without copying
 * here too — which is the whole reason ssh2 reaches for it.
 */
function addSpecies(Buffer) {
  if (!Buffer || Buffer[Symbol.species] !== undefined) return;
  Object.defineProperty(Buffer, Symbol.species, {
    get() {
      return Buffer;
    },
    configurable: true,
  });
}

function addInternalMethods(Buffer) {
  if (!Buffer || !Buffer.prototype) return;

  /** Non-enumerable, like the methods it sits beside. Never replaces one. */
  const define = (name, value) => {
    if (Object.prototype.hasOwnProperty.call(Buffer.prototype, name)) return;
    Object.defineProperty(Buffer.prototype, name, {
      value,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  };

  for (const encoding of ENCODINGS) {
    define(`${encoding}Write`, function write(string, offset, length) {
      return this.write(string, offset, length, encoding);
    });

    define(`${encoding}Slice`, function slice(start, end) {
      return this.toString(encoding, start, end);
    });
  }
}

addInternalMethods(buffer.Buffer);
addSpecies(buffer.Buffer);

// react-native-quick-crypto carries its own Buffer — @craftzdog's fork, which
// has the same gap — and its return values go straight into ssh2. A key or a
// signature that came back from crypto is read with the same internal methods
// as one ssh2 allocated itself, so both prototypes need them or the failure
// just moves to whichever buffer happened to cross the boundary.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Buffer: QuickCryptoBuffer } = require('@craftzdog/react-native-buffer');
  addInternalMethods(QuickCryptoBuffer);
  addSpecies(QuickCryptoBuffer);
} catch {
  // Only present because quick-crypto depends on it. No crypto, nothing to fix.
}

module.exports = buffer;
