/**
 * The handoff broker.
 *
 * A browser wanting to monitor an Uberspace has nothing to start from — no
 * token, not even the address. The phone has both. This server is the place
 * they meet, and it is built so that meeting there gives it nothing:
 *
 *   PUT  /pair/<slot>   the phone deposits one sealed payload
 *   GET  /pair/<slot>   the browser collects it, once
 *
 * The payload is sealed with a key that only ever existed inside a QR code on
 * the browser's own screen (see @uberapp/protocol/handoff). This process
 * cannot read what it is holding, and does not try: nothing here parses,
 * inspects or logs a payload. A slot lives about two minutes, survives exactly
 * one read, and is never overwritten.
 *
 * Run it anywhere — it needs no state on disk, no database and no credentials.
 * PORT picks the port; on an Uberspace, point a web backend at it.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { SLOT_ID, SlotStore } from './slots.js';

const PORT = Number(process.env.PORT ?? 8400);
const MAX_BODY_BYTES = 8 * 1024;

const slots = new SlotStore({ maxBytes: MAX_BODY_BYTES });

/**
 * The browser fetches this from a different origin than the page it sits on,
 * so it needs CORS. Any origin is allowed on purpose: a slot id is already
 * the secret, the payload is sealed, and restricting origins would only mean
 * maintaining a list of everywhere the web app might be hosted.
 */
function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function send(res: ServerResponse, status: number, body: string, type = 'text/plain'): void {
  cors(res);
  res.statusCode = status;
  res.setHeader('Content-Type', `${type}; charset=utf-8`);
  // A payload in a proxy cache would outlive the one-read rule.
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

/**
 * Read the body, giving up on anything oversized before it is all in memory.
 *
 * Resolves as soon as the limit is passed rather than draining the rest: the
 * caller answers immediately and the connection is closed afterwards. An
 * earlier version destroyed the request here instead, which did stop the
 * upload — and also killed the socket before the 413 could be written, so the
 * client saw its connection drop with no explanation at all.
 */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let body = '';
    let settled = false;

    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (settled) return;
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        body = '';
        settle(null);
      }
    });
    req.on('end', () => settle(body));
    req.on('error', () => settle(null));
  });
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? '/';
  const path = url.split('?')[0] ?? '/';

  if (req.method === 'OPTIONS') {
    cors(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (path === '/healthz') {
    send(res, 200, JSON.stringify({ ok: true, slots: slots.size }), 'application/json');
    return;
  }

  const match = /^\/pair\/([^/]+)$/.exec(path);
  if (match === null) {
    send(res, 404, 'not found');
    return;
  }

  const sid = decodeURIComponent(match[1] as string);
  if (!SLOT_ID.test(sid)) {
    send(res, 400, 'bad slot');
    return;
  }

  if (req.method === 'GET') {
    const sealed = slots.collect(sid);
    if (sealed === null) {
      // The browser polls this until the phone has been used, so an empty slot
      // is the ordinary case and not an error worth logging.
      send(res, 404, 'empty');
      return;
    }
    send(res, 200, sealed);
    return;
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    void readBody(req).then((body) => {
      if (body === null) {
        // Answer first, then stop the upload. Closing the connection is what
        // makes the sender give up; doing it the other way round loses the
        // answer.
        res.setHeader('Connection', 'close');
        send(res, 413, 'too large');
        res.on('finish', () => req.destroy());
        return;
      }

      const result = slots.deposit(sid, body.trim());
      if (result.ok) {
        send(res, 204, '');
        return;
      }

      // 409 for an occupied slot specifically: the phone can tell the user
      // that this code has already been used, which is worth distinguishing
      // from the server being full or the payload being malformed.
      const status = result.reason === 'occupied' ? 409 : result.reason === 'full' ? 503 : 400;
      send(res, status, result.reason);
    });
    return;
  }

  send(res, 405, 'method not allowed');
});

server.listen(PORT, () => {
  // The only thing ever logged. Payloads and slot ids are not.
  process.stdout.write(`uberapp-connect listening on ${PORT}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
