/**
 * react-native-tcp-socket, filled out to what ssh2 expects of a net.Socket.
 *
 * The library is a good TCP socket and a partial net.Socket. ssh2 is written
 * against the real thing, and reaches for four parts that are missing. Each one
 * is added here rather than patched into the library, so nothing else in the
 * app is affected.
 *
 * 1. pause() and resume() before connect
 *
 *    ssh2 installs its protocol handlers and then pauses the socket, in
 *    Client.connect(), long before the connection is established:
 *
 *      sock.pause();                                    // lib/client.js:708
 *      ...
 *      sock.connect({ host, port, ... });               // lib/client.js:1131
 *
 *    A JavaScript id is assigned at construction, but the socket is only
 *    registered natively when it connects — and pause() reaches straight for
 *    the native side without checking:
 *
 *      pause() {
 *        if (this._paused) return this;
 *        this._paused = true;
 *        NativeModules.TcpSockets.pause(this._id);      // no _pending check
 *      }
 *
 *      java.lang.IllegalArgumentException: No socket with id 0
 *
 *    setNoDelay, setKeepAlive and end in the same class all guard on _pending
 *    and defer; pause and resume were left out. This remembers the intent and
 *    applies it on connect, which is what those three do.
 *
 * 2. setMaxListeners()
 *
 *    The socket extends eventemitter3, not Node's events. eventemitter3 has no
 *    listener cap at all, so it has no setMaxListeners — and ssh2 calls it
 *    immediately after connecting:
 *
 *      sock.setMaxListeners(0);                         // lib/client.js:1137
 *
 *    A no-op is not a compromise here: 0 means "no limit" in Node, and no
 *    limit is already what eventemitter3 does.
 *
 * 3. writable / readable / _readableState
 *
 *    This one is quiet and total. Every byte ssh2 sends goes through one guard:
 *
 *      onWrite: (data) => {
 *        if (isWritable(sock))
 *          sock.write(data);                            // lib/client.js:302
 *      }
 *
 *    and isWritable is a workaround for a Node regression, so it tests Node
 *    internals:
 *
 *      isWritable: (stream) => stream
 *                             && stream.writable
 *                             && stream._readableState
 *                             && stream._readableState.ended === false
 *
 *    The socket has none of those, so the test is always false and ssh2 never
 *    writes — not even its identification string. The connection opens, the
 *    server's banner arrives, and the handshake then waits for a client that
 *    has gone quiet, until the ready timeout expires. Nothing reports an error
 *    along the way, which is what makes it worth spelling out.
 *
 * 4. An error event that carries an Error
 *
 *    The library forwards the native side's report verbatim, and for a failed
 *    name lookup that is a string. ssh2 annotates socket errors the way any
 *    Node code does — `err.level = 'client-socket'` — and assigning to a string
 *    primitive throws. A mistyped hostname therefore surfaced as an uncaught
 *    "Cannot create property 'level' on string", with the real reason inside
 *    the message it had just destroyed. See emit() below.
 *
 * The state the properties in 3 describe already exists on the socket, in
 * _destroyed and _readyState; they are just not exposed under the names ssh2
 * reads. So they are derived rather than tracked separately — there is no
 * second copy of the truth to drift.
 */

const TcpSocket = require('react-native-tcp-socket');

const BaseSocket = TcpSocket.Socket;

/** Android's wording for a name that does not resolve. */
const DNS_FAILURE = /unable to resolve host|no address associated with hostname|nodename nor servname/i;

function toError(value) {
  const message =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && typeof value.message === 'string'
        ? value.message
        : 'Socket error';

  const error = new Error(message);
  // Node reports a failed lookup this way, and code that handles sockets tends
  // to branch on the code rather than on the wording.
  if (DNS_FAILURE.test(message)) error.code = 'ENOTFOUND';
  return error;
}

class Socket extends BaseSocket {
  constructor(...args) {
    super(...args);

    /** A pause() asked for while the socket was still pending. */
    this._deferredPaused = false;

    // Registered here, not in connect(), so it runs before the listeners the
    // caller adds later. ssh2 pauses the socket during setup and resumes it
    // from its own 'connect' handler; if the deferred pause landed after that
    // resume, the socket would stay paused and no data would ever be read.
    this.once('connect', () => {
      if (this._deferredPaused) {
        this._deferredPaused = false;
        super.pause();
      }
    });

    // ssh2 reads .ended off this. Live, so it stays true to the socket.
    const socket = this;
    this._readableState = {
      get ended() {
        return !socket.readable;
      },
    };
  }

  /** Open for reading: connected, and not torn down. */
  get readable() {
    return !this._destroyed && this._readyState === 'open';
  }

  /** Open for writing. The socket is not half-closable, so this matches. */
  get writable() {
    return this.readable;
  }

  pause() {
    if (this.pending) {
      this._deferredPaused = true;
      return this;
    }
    return super.pause();
  }

  resume() {
    if (this.pending) {
      this._deferredPaused = false;
      return this;
    }
    return super.resume();
  }

  /**
   * Make an error event carry an Error, which is what a caller may assume.
   *
   * The library forwards whatever the native side reported:
   *
   *   this.emit('error', evt.error);        // src/Socket.js
   *
   * and for a failed name lookup that is a *string*. ssh2 then does what any
   * Node code does with a socket error — annotates it and re-emits:
   *
   *   err.level = 'client-socket';          // ssh2/lib/client.js:804
   *
   * Assigning a property to a string primitive throws, so a mistyped hostname
   * surfaced as an uncaught "Cannot create property 'level' on string" instead
   * of "no such host". The failure was reported correctly and then destroyed
   * on the way out.
   *
   * The DNS case also gets Node's code for it, so callers that recognise
   * ENOTFOUND — including this app's own error messages — keep working.
   */
  emit(event, ...args) {
    if (event === 'error' && !(args[0] instanceof Error)) {
      args[0] = toError(args[0]);
    }
    return super.emit(event, ...args);
  }

  /** eventemitter3 has no listener cap, so there is nothing to set. */
  setMaxListeners() {
    return this;
  }

  /** 0 is Node's way of saying "no limit", which is the truth here. */
  getMaxListeners() {
    return 0;
  }
}

function createConnection(options, callback) {
  return new Socket().connect(options, callback);
}

module.exports = {
  ...TcpSocket,
  Socket,
  connect: createConnection,
  createConnection,
};
