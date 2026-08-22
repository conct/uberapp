/**
 * Stand-in for ssh2's Poly1305, which is compiled to WebAssembly.
 *
 * Hermes has no WebAssembly, so the real module throws
 * "Property 'WebAssembly' doesn't exist" while it is being instantiated — and
 * it instantiates on load, not on use.
 *
 * Poly1305 is only needed for the chacha20-poly1305@openssh.com cipher, and
 * the algorithm list in api/sshTransport.ts does not offer it: the crypto shim
 * has no chacha20 either, so it was already out of the running. Every cipher
 * this app negotiates is AES-CTR with a separate HMAC.
 *
 * Calling this is therefore a bug, not a fallback — hence the throw rather
 * than a quiet wrong answer, which in an authenticator would mean accepting
 * forged messages.
 */

function createPoly1305() {
  throw new Error(
    'Poly1305 is not available: this build negotiates AES-CTR ciphers only. ' +
      'Reaching here means the algorithm list allowed chacha20-poly1305.',
  );
}

module.exports = createPoly1305;
module.exports.createPoly1305 = createPoly1305;
