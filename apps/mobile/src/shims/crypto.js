/**
 * react-native-quick-crypto, with its cipher and hash listings in Node's case.
 *
 * quick-crypto builds getCiphers() from OpenSSL's EVP_CIPHER_get0_name(),
 * which under OpenSSL 3 returns canonical names in upper case — "AES-256-CTR".
 * Node returns them lower case. Nothing notices until something looks a name
 * up, and then it fails in a way that points at the wrong place entirely:
 *
 *   ssh2/lib/protocol/constants.js
 *     const ciphers = crypto.getCiphers();
 *     canUseCipher = (name) => ciphers.includes(CIPHER_INFO[name].sslName);
 *     DEFAULT_CIPHER = DEFAULT_CIPHER.filter(canUseCipher);
 *
 * sslName is lower case, so every cipher is filtered out, SUPPORTED_CIPHER
 * ends up empty, and asking for aes256-ctr reports "Unsupported algorithm" —
 * for a cipher the library implements perfectly well.
 *
 * Lower-casing is safe in both directions: OpenSSL cipher and digest lookups
 * are case-insensitive, so anything that takes a name from these lists and
 * hands it back still resolves.
 */

const quickCrypto = require('react-native-quick-crypto');

const base = quickCrypto.default ?? quickCrypto;

const lowerCased = (fn) =>
  function listNames(...args) {
    const names = fn.apply(base, args);
    return Array.isArray(names) ? names.map((name) => String(name).toLowerCase()) : names;
  };

/**
 * Add the spellings Node uses for the same digest.
 *
 * Case was only half the problem. OpenSSL 3 also *renames* the SHA-2 family:
 * its canonical name is "SHA2-256", where Node says "sha256". So ssh2 looks
 * for 'sha256' in the list, finds 'sha2-256', and concludes that HMAC-SHA-256
 * is unavailable — reporting "Unsupported algorithm: hmac-sha2-256" for a
 * digest every party involved implements.
 *
 * Both spellings are kept rather than replaced: OpenSSL accepts either when
 * looking a digest up, and something else may well expect the canonical form.
 */
const withNodeAliases = (names) => {
  const all = new Set(names);
  for (const name of names) {
    const sha2 = /^sha2-(\d+)$/.exec(name);
    if (sha2) all.add(`sha${sha2[1]}`);
    const dashed = /^sha-(\d+)$/.exec(name);
    if (dashed) all.add(`sha${dashed[1]}`);
  }
  return [...all].sort();
};

// A plain copy rather than a Proxy: Hermes supports Proxy, but a copy is one
// less thing that has to behave identically on an engine this library is
// already being stretched to fit.
const shim = {};
for (const key of Object.getOwnPropertyNames(base)) {
  if (key === 'default') continue;
  try {
    shim[key] = base[key];
  } catch {
    // A getter that throws on this platform is not ours to fix.
  }
}

if (typeof base.getCiphers === 'function') shim.getCiphers = lowerCased(base.getCiphers);
if (typeof base.getCurves === 'function') shim.getCurves = lowerCased(base.getCurves);

if (typeof base.getHashes === 'function') {
  const lower = lowerCased(base.getHashes);
  shim.getHashes = function getHashes(...args) {
    const names = lower.apply(base, args);
    return Array.isArray(names) ? withNodeAliases(names) : names;
  };
}

shim.default = shim;

module.exports = shim;
