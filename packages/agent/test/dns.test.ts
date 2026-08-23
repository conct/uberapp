import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  dnsRecordProblem,
  isValidDnsRecordType,
  MAX_TTL,
  MIN_TTL,
} from '@uberapp/protocol';

const valid = { domain: 'example.de', type: 'A', content: '192.0.2.1' };

describe('isValidDnsRecordType', () => {
  it('knows the types a zone can hold', () => {
    for (const type of ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'CAA', 'SRV']) {
      assert.ok(isValidDnsRecordType(type), type);
    }
  });

  it('rejects anything else rather than passing it to the registrar', () => {
    assert.equal(isValidDnsRecordType('a'), false, 'lower case is a different string');
    assert.equal(isValidDnsRecordType('AAAAA'), false);
    assert.equal(isValidDnsRecordType(''), false);
  });
});

describe('dnsRecordProblem', () => {
  it('passes a plain record', () => {
    assert.equal(dnsRecordProblem(valid), null);
    assert.equal(dnsRecordProblem({ ...valid, name: 'www', ttl: 3600 }), null);
  });

  it('insists on the parts a record cannot do without', () => {
    assert.match(dnsRecordProblem({ ...valid, domain: '  ' }) ?? '', /Domain/);
    assert.match(dnsRecordProblem({ ...valid, content: '' }) ?? '', /Wert/);
    assert.match(dnsRecordProblem({ ...valid, type: 'WHAT' }) ?? '', /Eintragsart/);
  });

  it('keeps the TTL inside what the registrar accepts', () => {
    // Outside this range INWX answers with a bare code, which reads as though
    // something else was wrong.
    assert.equal(dnsRecordProblem({ ...valid, ttl: MIN_TTL }), null);
    assert.equal(dnsRecordProblem({ ...valid, ttl: MAX_TTL }), null);
    assert.match(dnsRecordProblem({ ...valid, ttl: MIN_TTL - 1 }) ?? '', /Lebensdauer/);
    assert.match(dnsRecordProblem({ ...valid, ttl: MAX_TTL + 1 }) ?? '', /Lebensdauer/);
    assert.match(dnsRecordProblem({ ...valid, ttl: 1800.5 }) ?? '', /Lebensdauer/);
  });

  it('allows a priority only where it means something', () => {
    assert.equal(dnsRecordProblem({ ...valid, type: 'MX', content: 'mx.example.de', priority: 10 }), null);
    assert.equal(dnsRecordProblem({ ...valid, type: 'SRV', priority: 0 }), null);
    assert.match(dnsRecordProblem({ ...valid, priority: 10 }) ?? '', /MX und SRV/);
    assert.match(
      dnsRecordProblem({ ...valid, type: 'MX', priority: 70_000 }) ?? '',
      /Priorität/,
    );
  });

  it('catches the domain written into the name twice', () => {
    // www.example.de as a name under example.de produces
    // www.example.de.example.de, which resolves for nobody and looks right.
    const problem = dnsRecordProblem({ ...valid, name: 'www.example.de' });
    assert.match(problem ?? '', /"www" genügt/);
    assert.equal(dnsRecordProblem({ ...valid, name: 'www' }), null);
    assert.equal(dnsRecordProblem({ ...valid, name: 'example.de.other' }), null);
  });
});
