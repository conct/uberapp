/**
 * End-to-end check of the agent's socket lifecycle: boot, hello, auth, a real
 * call, and rejection paths. Uses files.* because it is the one handler group
 * that does not need the Uberspace CLI, so this runs on any machine.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import WebSocket from 'ws';
import type { ServerMessage } from '@uberctrl/protocol';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'src', 'index.ts');

const TOKEN = 'test-token-with-enough-entropy-1234';
const PORT = 18399;
const URL = `ws://127.0.0.1:${PORT}`;

let agent: ChildProcess;
let sandbox: string;

/** Collects server messages and lets a test await the next matching one. */
class Client {
  private readonly queue: ServerMessage[] = [];
  private waiters: Array<(m: ServerMessage) => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }

  static connect(): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(URL);
      ws.once('open', () => resolve(new Client(ws)));
      ws.once('error', reject);
    });
  }

  next(timeoutMs = 10_000): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
      this.waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  }

  send(message: unknown) {
    this.ws.send(JSON.stringify(message));
  }

  close() {
    this.ws.close();
  }
}

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'uberctrl-test-'));
  await mkdir(join(sandbox, 'subdir'));
  await writeFile(join(sandbox, 'hello.txt'), 'moin\n', 'utf8');

  agent = spawn(process.execPath, ['--import', 'tsx', entry], {
    env: {
      ...process.env,
      UBERCTRL_TOKEN: TOKEN,
      UBERCTRL_PORT: String(PORT),
      UBERCTRL_BIND: '127.0.0.1',
      UBERCTRL_FILE_ROOT: sandbox,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for the listening line before any test connects.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('agent did not start in time')), 30_000);
    let buffered = '';
    agent.stdout?.on('data', (d: Buffer) => {
      buffered += d.toString();
      if (buffered.includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    agent.stderr?.on('data', (d: Buffer) => {
      buffered += d.toString();
    });
    agent.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`agent exited early with code ${code}: ${buffered}`));
    });
  });
});

after(() => {
  agent?.kill('SIGKILL');
});

describe('handshake', () => {
  it('greets with hello before authentication', async () => {
    const client = await Client.connect();
    const hello = await client.next();
    assert.equal(hello.t, 'hello');
    assert.equal((hello as { protocol: number }).protocol, 1);
    client.close();
  });

  it('rejects a wrong token', async () => {
    const client = await Client.connect();
    await client.next(); // hello
    client.send({ t: 'auth', token: 'wrong-token-wrong-token-wrong' });

    const reply = await client.next();
    assert.equal(reply.t, 'auth.err');
    client.close();
  });

  it('refuses calls before authentication', async () => {
    const client = await Client.connect();
    await client.next(); // hello
    client.send({ t: 'call', id: '1', method: 'system.info' });

    const reply = await client.next();
    assert.equal(reply.t, 'auth.err');
    client.close();
  });

  it('accepts the right token and reports capabilities', async () => {
    const client = await Client.connect();
    await client.next(); // hello
    client.send({ t: 'auth', token: TOKEN, client: 'test' });

    const reply = await client.next();
    assert.equal(reply.t, 'auth.ok');
    const session = (reply as { session: { capabilities: string[] } }).session;
    assert.ok(session.capabilities.includes('files'));
    client.close();
  });
});

describe('calls', () => {
  let client: Client;

  before(async () => {
    client = await Client.connect();
    await client.next(); // hello
    client.send({ t: 'auth', token: TOKEN });
    await client.next(); // auth.ok
  });

  after(() => client?.close());

  it('lists a directory', async () => {
    client.send({ t: 'call', id: 'a', method: 'files.list', params: { path: '.' } });
    const reply = await client.next();

    assert.equal(reply.t, 'result');
    const data = (reply as { data: { entries: Array<{ name: string; type: string }> } }).data;
    const names = data.entries.map((e) => e.name);
    assert.ok(names.includes('hello.txt'));
    // Directories sort first.
    assert.equal(data.entries[0]?.type, 'dir');
  });

  it('reads a file', async () => {
    client.send({ t: 'call', id: 'b', method: 'files.read', params: { path: 'hello.txt' } });
    const reply = await client.next();

    assert.equal(reply.t, 'result');
    assert.equal((reply as { data: { content: string } }).data.content, 'moin\n');
  });

  it('refuses to escape the configured root', async () => {
    client.send({
      t: 'call',
      id: 'c',
      method: 'files.read',
      params: { path: '../../../etc/passwd' },
    });
    const reply = await client.next();

    assert.equal(reply.t, 'error');
    assert.equal((reply as { code: string }).code, 'forbidden');
  });

  it('rejects an unknown method', async () => {
    client.send({ t: 'call', id: 'd', method: 'does.not.exist' });
    const reply = await client.next();

    assert.equal(reply.t, 'error');
    assert.equal((reply as { code: string }).code, 'unknown_method');
  });

  it('validates params instead of passing them through', async () => {
    client.send({
      t: 'call',
      id: 'e',
      method: 'services.control',
      params: { name: 'evil; rm -rf ~', action: 'restart' },
    });
    const reply = await client.next();

    assert.equal(reply.t, 'error');
    assert.equal((reply as { code: string }).code, 'bad_request');
  });

  it('answers a ping', async () => {
    client.send({ t: 'ping' });
    const reply = await client.next();
    assert.equal(reply.t, 'pong');
  });
});
