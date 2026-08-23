/**
 * Domains and DNS records, through the account the host holds.
 *
 * Every handler here opens a session, does one thing and closes it — see
 * withInwx() for why.
 *
 * Two of them spend money: registering and transferring. Both are guarded the
 * same way — a purchase must name the price it expects, and the agent refuses
 * if the registrar quotes a different one — and both take a dry run that
 * validates the whole request without buying. See the section further down.
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
  type DomainPrice,
} from '@uberapp/protocol';

import { readAccount, withInwx, InwxError } from '../inwx.js';
import { RpcError, type Handler } from '../rpc.js';
import { asObject, optionalBoolean, requireString } from '../validate.js';

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

// --- the calls that cost money ---------------------------------------------
//
// Registering and transferring are the only things here that spend anything,
// and they are guarded by one rule: a purchase must name the price it expects.
// The agent asks the registrar what the name costs right now and refuses if
// the two disagree. That is not ceremony — a price can move between the screen
// somebody read and the button they pressed, and the difference lands on their
// bill, not on ours. It also makes an accidental call impossible: a caller
// that has not looked up a price cannot construct a request.
//
// The dry run is the second half. INWX takes `testing`, which validates the
// whole request — contacts, rules, availability — and buys nothing. Every
// screen should offer it, and it is the only mode used while developing.

/** What the registrar wants for this name today, per year. */
async function quote(
  session: { call: <T>(m: string, p?: Record<string, unknown>) => Promise<{ resData?: T }> },
  domain: string,
): Promise<DomainPrice | null> {
  const tld = domain.split('.').slice(1).join('.');
  if (!tld) return null;

  const answer = await session.call<{ price?: Record<string, unknown>[] }>('domain.getPrices', {
    tld: [tld],
  });
  const first = answer.resData?.price?.[0];
  if (!first) return null;

  return {
    tld,
    createPrice: count(first.createPrice),
    transferPrice: count(first.transferPrice),
    renewalPrice: count(first.renewalPrice),
    currency: first.currency ? text(first.currency) : null,
  };
}

/**
 * Refuse unless the caller's expectation matches the registrar's answer.
 *
 * Rounded to cents before comparing: the registrar quotes floats, and a
 * mismatch in the sixth decimal is noise, not a changed price.
 */
export function priceMustMatch(expected: number, actual: number | null, currency: string | null): void {
  if (actual === null) {
    throw RpcError.badRequest(
      'Der Registrar nennt für diese Endung keinen Preis — ohne Preis wird hier nichts gekauft.',
    );
  }
  if (Math.round(expected * 100) !== Math.round(actual * 100)) {
    throw RpcError.badRequest(
      `Der Preis hat sich geändert: erwartet ${expected.toFixed(2)}, ` +
        `verlangt ${actual.toFixed(2)}${currency ? ' ' + currency : ''}. Bitte neu bestätigen.`,
    );
  }
}

/** The four handles INWX insists on. All of them, or the call is rejected. */
function contacts(p: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const role of ['registrant', 'admin', 'tech', 'billing']) {
    const value = Number(p[role]);
    if (!Number.isInteger(value) || value <= 0) {
      throw RpcError.badRequest(
        `Für "${role}" fehlt ein Kontakt-Handle. Die Liste liefert domains.contacts.`,
      );
    }
    out[role] = value;
  }
  return out;
}

const prices: Handler = async (params) => {
  const p = asObject(params);
  const domain = requireString(p, 'domain', { maxLength: 253 }).trim().toLowerCase();

  const configured = await account();
  try {
    return await withInwx(configured, async (session) => ({ price: await quote(session, domain) }));
  } catch (err) {
    return asRpcError(err);
  }
};

const contactList: Handler = async () => {
  const configured = await account();
  try {
    return await withInwx(configured, async (session) => {
      const answer = await session.call<{ contact?: Record<string, unknown>[] }>('contact.list', {});
      const found = (answer.resData?.contact ?? []).map((raw) => ({
        id: count(raw.id) ?? 0,
        name: text(raw.name),
        org: raw.org ? text(raw.org) : null,
        email: text(raw.email),
        country: text(raw.cc),
      }));
      return { contacts: found };
    });
  } catch (err) {
    return asRpcError(err);
  }
};

const register: Handler = async (params) => {
  const p = asObject(params);
  const domain = requireString(p, 'domain', { maxLength: 253 }).trim().toLowerCase();
  const expected = Number(p.expectedPrice);
  if (!Number.isFinite(expected)) {
    throw RpcError.badRequest('Ohne erwarteten Preis wird nicht registriert.');
  }
  const handles = contacts(p);
  const dryRun = optionalBoolean(p, 'dryRun') ?? false;
  const period = typeof p.period === 'string' ? p.period : '1Y';

  const configured = await account();
  try {
    return await withInwx(configured, async (session) => {
      const price = await quote(session, domain);
      priceMustMatch(expected, price?.createPrice ?? null, price?.currency ?? null);

      await session.call('domain.create', {
        domain,
        period,
        ...handles,
        ...(dryRun ? { testing: 1 } : {}),
      });
      return { domain, registered: !dryRun, dryRun, price };
    });
  } catch (err) {
    return asRpcError(err);
  }
};

/**
 * A transfer, which needs the code the losing registrar hands out.
 *
 * The optional fields here follow the documentation rather than a typed client
 * — goinwx declares domain.transfer and never implements it — so the dry run
 * matters more than usual: it is how a request gets checked before it counts.
 */
const transfer: Handler = async (params) => {
  const p = asObject(params);
  const domain = requireString(p, 'domain', { maxLength: 253 }).trim().toLowerCase();
  const authCode = requireString(p, 'authCode', { maxLength: 128 }).trim();
  const expected = Number(p.expectedPrice);
  if (!Number.isFinite(expected)) {
    throw RpcError.badRequest('Ohne erwarteten Preis wird nicht übertragen.');
  }
  const handles = contacts(p);
  const dryRun = optionalBoolean(p, 'dryRun') ?? false;

  const configured = await account();
  try {
    return await withInwx(configured, async (session) => {
      const price = await quote(session, domain);
      priceMustMatch(expected, price?.transferPrice ?? null, price?.currency ?? null);

      await session.call('domain.transfer', {
        domain,
        authCode,
        ...handles,
        ...(dryRun ? { testing: 1 } : {}),
      });
      return { domain, started: !dryRun, dryRun, price };
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
  'domains.prices': prices,
  'domains.contacts': contactList,
  'domains.register': register,
  'domains.transfer': transfer,
};
