/**
 * Domains and DNS records, as the app and the agent agree to talk about them.
 *
 * The registrar behind this is INWX, but nothing here says so: the app asks
 * for a record, not for a `nameserver.createRecord`. Keeping the vocabulary
 * neutral is what lets the same screens serve a second registrar later, and it
 * keeps the app from carrying knowledge it has no business having.
 *
 * The validation lives here rather than in the agent because both sides need
 * it — the app to tell somebody their TTL is out of range before a round trip,
 * the agent because a client is not to be trusted about it.
 */

/** What a zone at INWX can hold. Anything else is refused rather than passed on. */
export const DNS_RECORD_TYPES = [
  'A',
  'AAAA',
  'CNAME',
  'MX',
  'TXT',
  'NS',
  'SRV',
  'CAA',
  'ALIAS',
  'PTR',
  'SOA',
  'NAPTR',
  'SSHFP',
  'TLSA',
  'DS',
  'URL',
  'FRAME',
] as const;

export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

export function isValidDnsRecordType(value: string): value is DnsRecordType {
  return (DNS_RECORD_TYPES as readonly string[]).includes(value);
}

/**
 * INWX accepts nothing outside this range and says so with a bare error code.
 * Checking here turns that into a sentence somebody can act on.
 */
export const MIN_TTL = 300;
export const MAX_TTL = 864_000;

export interface DnsRecord {
  /** The registrar's own id. Needed to change or delete the record. */
  id: string;
  /** Empty for the zone apex; otherwise the label, without the domain. */
  name: string;
  type: DnsRecordType | string;
  content: string;
  ttl: number;
  /** Only meaningful for MX and SRV. */
  priority: number | null;
}

export interface DomainInfo {
  domain: string;
  /** ISO date, or null when the registrar did not say. */
  expiresAt: string | null;
  status: string;
  /** Whether this account can edit the zone, as opposed to only holding it. */
  registrar: string | null;
}

export interface DomainAvailability {
  domain: string;
  available: boolean;
  /** Whatever the registrar said, for the cases the flag cannot carry. */
  status: string;
  /** In the account's currency, null when the registrar quoted none. */
  price: number | null;
  currency: string | null;
}

export interface DnsRecordInput {
  domain: string;
  type: string;
  content: string;
  name?: string;
  ttl?: number;
  priority?: number;
}

/**
 * What is wrong with a record, in a sentence, or null when nothing is.
 *
 * A single function rather than a set of guards because the caller wants one
 * message to show, and because the rules interact: a priority means nothing
 * without an MX or SRV type, and an empty content is only ever a mistake.
 */
export function dnsRecordProblem(input: DnsRecordInput): string | null {
  if (!input.domain.trim()) return 'Ohne Domain lässt sich kein Eintrag anlegen.';
  if (!isValidDnsRecordType(input.type)) {
    return `"${input.type}" ist keine bekannte Eintragsart.`;
  }
  if (!input.content.trim()) return 'Der Eintrag braucht einen Wert.';

  if (input.ttl !== undefined) {
    if (!Number.isInteger(input.ttl) || input.ttl < MIN_TTL || input.ttl > MAX_TTL) {
      return `Die Lebensdauer muss zwischen ${MIN_TTL} und ${MAX_TTL} Sekunden liegen.`;
    }
  }

  if (input.priority !== undefined) {
    if (input.type !== 'MX' && input.type !== 'SRV') {
      return 'Eine Priorität ergibt nur bei MX und SRV einen Sinn.';
    }
    if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 65_535) {
      return 'Die Priorität muss zwischen 0 und 65535 liegen.';
    }
  }

  // A name is a label, not a full host: writing the domain into it again is
  // the most common way to end up with www.example.de.example.de.
  if (input.name && input.name.endsWith(`.${input.domain}`)) {
    return `Der Name ist nur die Beschriftung — "${input.name.slice(0, -input.domain.length - 1)}" genügt.`;
  }

  return null;
}
