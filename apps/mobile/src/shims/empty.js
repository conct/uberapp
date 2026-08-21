/**
 * Stand-in for a Node core module that neither React Native nor a browser has.
 *
 * ssh2 reaches for a few modules it only needs for features this app does not
 * use — compression, a CPU-feature probe that would select a native crypto
 * binding, filesystem access for key files. Metro resolves every require it
 * sees, including ones behind a try/catch, so each of those needs something to
 * resolve to. An empty object is that something: the code paths guarded by
 * those requires are never taken here.
 */

module.exports = {};
