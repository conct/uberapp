/**
 * Domains and DNS records, through the account the host holds.
 *
 * Every handler here opens a session, does one thing and closes it — see
 * withInwx() for why. What none of them do is register or transfer anything:
 * those spend money, and the first step deliberately stops at reading the
 * account and editing zones that already belong to it.
 *
 * The shapes the app receives are this project's own (DnsRecord, DomainInfo),
 * not the registrar's. INWX answers with `TTL` in capitals on the way out and
 * expects `ttl` on the way in, among other asymmetries; translating once here
 * keeps that out of every screen.
 */

import {
  dnsRecordProblem,
  type DnsRecord,
  type DomainAvailability,
  type DomainInfo,
} from '@uberapp/protocol';

import { readAccount, withInwx, InwxError } from '../inwx.js';
import { RpcError, type Handler } from '../rpc.js';
import { asObject, requireString } from '../validate.js';

/** Shared by every handler: without an account there is nothing to talk to. */
async function account() {
  const found = await readAccount();
  if (!found) {
    throw RpcError.badRequest(
      'No registrar account is configured on this host.',
      'Put user and pass into ~/.config/uberapp/inwx.json (mode 600).',
    );
  }
  return found;
}

/** INWX errors carry a code worth passing on; anything else is a surprise. */
function asRpcError(err: unknown): never {
  if (err instanceof InwxError) {
    throw RpcError.commandFailed(`Der Registrar lehnte ab (${err.code}): ${err.message}`);
  }
  throw err;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function count(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One record, in our shape.
 *
 * Note `TTL`: the field comes back capitalised even though it goes out in
 * lower case. Reading only one of the two spellings silently yields a ttl of
 * zero, which then fails validation on the way back in with a message about a
 * value nobody typed.
 */
function toRecord(raw: Record<string, unknown>): DnsRecord {
  const ttl = count(raw.TTL ?? raw.ttl);
  const priority = count(raw.prio);
  return {
    id: text(raw.id),
    name: text(raw.name),
    type: text(raw.type),
    content: text(raw.content),
    ttl: ttl ?? 0,
    priority: priority === null || priority === 0 ? null : priority,
  };
}

const list: Handler = async () => {
  const configured = await account();
  try {
    return await withInwx(configured, async (session) => {
      const answer = await session.call<{ domain?: Record<string, unknown>[] }>('domain.list', {
        pagelimit: 1000,
      });
      const domains: DomainInfo[] = (answer.resData?.domain ?? []).map((raw) => ({
        domain: text(raw.domain),
        expiresAt: raw.exDate ? text(raw.exDate) : null,
        status: text(raw.status),
        registrar: raw.registrar ? text(raw.registrar) : null,
      }));
      return { domains };
    });
  } catch (err) {
    return asRpcError(err);
  }
};

const check: Handler = async (params) => {
  const p = asObject(params);
  // One name per call: the batch form exists, but a person checking a domain
  // is watching one answer, and a partial batch failure has no good rendering.
  const domain = requireString(p, 'domain', { maxLength: 253 }).trim().toLowerCase();

  const configured = await account();
  try {
    return await withInwx(configured, async (session) => {
      const answer = await session.call<{ domain?: Record<string, unknown>[] }>('domain.check', {
        domain: [domain],
      });
      const first = answer.resData?.domain?.[0] ?? {};
      const status = text(first.avail === 1 ? 'available' : first.status);
      const result: DomainAvailability = {
        domain: text(first.domain) || domain,
        available: first.avail === 1 || status === 'available',
        status,
        price: count(first.price),
        currency: first.currency ? text(first.currency) : null,
      };
      return result;
    });
  } catch (err) {
    return asRpcError(err);
  }
};

const records: Handler = async (params) => {
  const p = asObject(params);
  const domain = requireString(p, 'domain', { maxLength: 253 }).trim().toLowerCase();

  const configured = await account();
  try {
    return await withInwx(configured, async (session) => {
      const answer = await session.call<{ record?: Record<string, unknown>[] }>('nameserver.info', {
        domain,
      });
      return { domain, records: (answer.resData?.record ?? []).map(toRecord) };
    });
  } catch (err) {
    return asRpcError(err);
  }
};

/** The fields a create and an update share, validated once for both. */
function recordFields(p: Record<string, unknown>): Record<string, unknown> {
  const domain = requireString(p, 'domain', { maxLength: 253 }).trim().toLowerCase();
  const type = requireString(p, 'type', { maxLength: 16 }).trim().toUpperCase();
  const content = requireString(p, 'content', { maxLength: 2048 }).trim();

  const name = typeof p.name === 'string' ? p.name.trim() : undefined;
  const ttl = p.ttl === undefined ? undefined : Number(p.ttl);
  const priority = p.priority === undefined ? undefined : Number(p.priority);

  const problem = dnsRecordProblem({
    domain,
    type,
    content,
    ...(name !== undefined ? { name } : {}),
    ...(ttl !== undefined ? { ttl } : {}),
    ...(priority !== undefined ? { priority } : {}),
  });
  if (problem) throw RpcError.badRequest(problem);

  return {
    domain,
    type,
    content,
    ...(name ? { name } : {}),
    ...(ttl !== undefined ? { ttl } : {}),
    ...(priority !== undefined ? { prio: priority } : {}),
  };
}

const createRecord: Handler = async (params) => {
  const p = asObject(params);
  const fields = recordFields(p);

  const configured = await account();
  try {
    return await withInwx(configured, async (session) => {
      const answer = await session.call<{ id?: number | string }>(
        'nameserver.createRecord',
        fields,
      );
      return { id: text(answer.resData?.id), domain: fields.domain };
    });
  } catch (err) {
    return asRpcError(err);
  }
};

const updateRecord: Handler = async (params) => {
  const p = asObject(params);
  const id = requireString(p, 'id', { maxLength: 32 });
  // The domain is not part of an update at INWX — the id already names the
  // zone — but it is required for validation, and sending it does no harm.
  const { domain: _domain, ...fields } = recordFields(p);

  const configured = await account();
  try {
    return await withInwx(configured, async (session) => {
      await session.call('nameserver.updateRecord', { id, ...fields });
      return { id, updated: true };
    });
  } catch (err) {
    return asRpcError(err);
  }
};

const deleteRecord: Handler = async (params) => {
  const p = asObject(params);
  const id = requireString(p, 'id', { maxLength: 32 });

  const configured = await account();
  try {
    return await withInwx(configured, async (session) => {
      await session.call('nameserver.deleteRecord', { id });
      return { id, deleted: true };
    });
  } catch (err) {
    return asRpcError(err);
  }
};

export const domainHandlers: Record<string, Handler> = {
  'domains.list': list,
  'domains.check': check,
  'dns.records': records,
  'dns.createRecord': createRecord,
  'dns.updateRecord': updateRecord,
  'dns.deleteRecord': deleteRecord,
};
