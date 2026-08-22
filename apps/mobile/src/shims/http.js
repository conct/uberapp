/**
 * Just enough of node:http and node:https for ssh2 to finish loading.
 *
 * ssh2 ships an HTTP-over-SSH tunnelling agent, and builds it at module scope:
 *
 *   const { Agent: HttpAgent } = require('http');
 *   class SSHAgent extends HttpAgent { ... }
 *
 * An empty stub makes that `extends undefined`, which throws "undefined is not
 * a constructor" while ssh2 is still being evaluated — before any SSH runs.
 * So the class has to exist. It does not have to work: nothing in this app
 * tunnels HTTP over SSH, and the subclass is never instantiated.
 */

class Agent {
  constructor(options) {
    this.options = options ?? {};
  }

  createConnection() {
    throw new Error('HTTP over SSH is not available in this app.');
  }

  destroy() {}
}

module.exports = { Agent, globalAgent: new Agent() };
