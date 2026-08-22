/**
 * Stand-in for ssh2's Poly1305, which is compiled to WebAssembly.
 *
 * Hermes has no WebAssembly, so the real module throws while instantiating —
 * and ssh2 instantiates it unconditionally. lib/protocol/crypto.js builds an
 * `init` promise at module scope that loads Poly1305 no matter which ciphers
 * are later negotiated, so refusing here rejects that promise and the failure
 * surfaces as an unhandled rejection with no obvious cause.
 *
 * The shape therefore matters, and so does *when* it complains:
 *
 *   - createPoly1305() resolves, so init completes and the client loads.
 *   - _malloc returns a plausible pointer; ssh2 only stores it.
 *   - cwrap returns a function that throws. That function is the actual
 *     authenticator, and it only runs if chacha20-poly1305@openssh.com was
 *     negotiated — which the algorithm list in api/sshTransport.ts does not
 *     offer, and which the crypto shim has no chacha20 for anyway.
 *
 * Quiet at load, loud at use. An authenticator that returns something
 * plausible instead of failing would mean accepting forged messages, so the
 * one thing this must never do is succeed.
 */

function unavailable() {
  throw new Error(
    'Poly1305 is not available in this build: it needs WebAssembly, which ' +
      'Hermes does not have. This build negotiates AES-CTR ciphers only, so ' +
      'reaching here means the algorithm list allowed chacha20-poly1305.',
  );
}

function createPoly1305() {
  // ssh2 awaits this, then calls _malloc and cwrap on the result.
  return Promise.resolve({
    _malloc: () => 1,
    _free: () => {},
    cwrap: () => unavailable,
    HEAPU8: new Uint8Array(0),
  });
}

module.exports = createPoly1305;
module.exports.createPoly1305 = createPoly1305;
