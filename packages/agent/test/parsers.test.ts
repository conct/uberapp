import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseStatus } from '../src/handlers/services.js';
import { parseCatchall, parseForward, parseSpamfolder } from '../src/handlers/mail.js';
import { parseBackends, parseHeaders, toPunycode } from '../src/handlers/web.js';
import { shouldRestart } from '../src/handlers/certs.js';
import { parseQuota } from '../src/handlers/system.js';
import {
  buildServiceIni,
  decodePairing,
  describeSchedule,
  encodePairing,
  isOwnDatabase,
  isValidEmail,
  isValidHeaderValue,
  isValidSieveName,
  parseCrontab,
  serializeCrontab,
  ServiceSpecError,
} from '@uberapp/protocol';
import {
  isWildcardAddress,
  parseAssignedPort,
  parseListeners,
  parsePorts,
} from '../src/handlers/ports.js';
import {
  backupPath,
  isOwnDump,
  isRestorable,
  parseSnapshotName,
  rsyncPair,
  snapshotPath,
  sortSnapshots,
} from '../src/handlers/backup.js';
import { mergeDatabases, parseNumber, parseRows } from '../src/handlers/db.js';
import {
  parseDeletedFiles,
  parseDiskUsage,
  parseMemory,
  parseShells,
} from '../src/handlers/diagnostics.js';
import { missingHandlers, strayHandlers } from '../src/handlers/registry.js';
import { digestsMatch, hashToken, isExpired, prune } from '../src/tokens.js';
import { shellQuote } from '../src/exec.js';

describe('parseStatus', () => {
  it('reads a running service with pid and uptime', () => {
    const [service] = parseStatus('my-daemon    RUNNING   pid 1234, uptime 0:12:33');
    assert.equal(service?.name, 'my-daemon');
    assert.equal(service?.state, 'RUNNING');
    assert.equal(service?.pid, 1234);
    assert.equal(service?.uptimeSeconds, 12 * 60 + 33);
  });

  it('handles multi-day uptime', () => {
    const [service] = parseStatus('long    RUNNING   pid 9, uptime 3 days, 2:03:04');
    assert.equal(service?.uptimeSeconds, 3 * 86400 + 2 * 3600 + 3 * 60 + 4);
  });

  it('reads a stopped service with a date instead of a pid', () => {
    const [service] = parseStatus('other    STOPPED   Sep 12 01:23 PM');
    assert.equal(service?.state, 'STOPPED');
    assert.equal(service?.pid, null);
    assert.equal(service?.uptimeSeconds, null);
  });

  it('keeps FATAL services with their explanation', () => {
    const [service] = parseStatus(
      'broken    FATAL     Exited too quickly (process log may have details)',
    );
    assert.equal(service?.state, 'FATAL');
    assert.match(service?.description ?? '', /Exited too quickly/);
  });

  it('marks an unrecognized state as UNKNOWN rather than dropping the row', () => {
    const [service] = parseStatus('weird    SOMETHINGNEW   whatever');
    assert.equal(service?.state, 'UNKNOWN');
    assert.equal(service?.name, 'weird');
  });

  it('parses a full listing and skips blank lines', () => {
    const services = parseStatus(
      ['a    RUNNING   pid 1, uptime 0:00:01', '', 'b    STOPPED   Not started'].join('\n'),
    );
    assert.equal(services.length, 2);
  });
});

describe('parseBackends', () => {
  it('reads an apache backend', () => {
    const [backend] = parseBackends('isabell.uber.space/ apache => OK');
    assert.equal(backend?.domain, 'isabell.uber.space');
    assert.equal(backend?.path, '/');
    assert.equal(backend?.type, 'apache');
    assert.equal(backend?.port, null);
  });

  it('reads an http backend with a port and a sub path', () => {
    const [backend] = parseBackends('isabell.example/api http:9000 => OK, listening');
    assert.equal(backend?.domain, 'isabell.example');
    assert.equal(backend?.path, '/api');
    assert.equal(backend?.type, 'http');
    assert.equal(backend?.port, 9000);
    assert.equal(backend?.status, 'OK, listening');
  });

  it('always keeps the raw line', () => {
    const raw = 'isabell.example/ http:8080 => OK, listening (remove prefix)';
    const [backend] = parseBackends(raw);
    assert.equal(backend?.raw, raw);
    assert.equal(backend?.removePrefix, true);
  });
});

describe('parseQuota', () => {
  it('parses the data row and computes a percentage', () => {
    const output = [
      'Disk quotas for group isabell (gid 1234):',
      '     Filesystem   space   quota   limit   grace   files   quota   limit   grace',
      '      /dev/sdb1   4096M  10240M  10240M            12k      0k      0k',
    ].join('\n');

    const quota = parseQuota(output);
    assert.equal(quota.used, 4096 * 1024 ** 2);
    assert.equal(quota.limit, 10240 * 1024 ** 2);
    assert.equal(quota.percent, 40);
  });

  it('handles an over-quota marker', () => {
    const output = ['Disk quotas for group isabell:', '  /dev/sdb1  11G*  10G  10G'].join('\n');
    const quota = parseQuota(output);
    assert.equal(quota.used, 11 * 1024 ** 3);
  });

  it('degrades to raw output when nothing parses', () => {
    const quota = parseQuota('some unexpected message');
    assert.equal(quota.used, 0);
    assert.equal(quota.limit, null);
    assert.equal(quota.raw, 'some unexpected message');
  });
});

describe('shellQuote', () => {
  it('wraps a plain value', () => {
    assert.equal(shellQuote('post'), "'post'");
  });

  it('neutralizes an embedded single quote', () => {
    // The classic break-out attempt must stay inside one quoted word.
    assert.equal(shellQuote("a'; rm -rf ~; echo '"), `'a'\\''; rm -rf ~; echo '\\'''`);
  });
});

describe('parsePorts', () => {
  it('reads the bare port numbers', () => {
    assert.deepEqual(parsePorts('40132\n40133\n40134\n'), [40132, 40133, 40134]);
  });

  it('sorts and de-duplicates', () => {
    assert.deepEqual(parsePorts('40134\n40132\n40132\n'), [40132, 40134]);
  });

  it('ignores prose and blank lines instead of turning them into ports', () => {
    assert.deepEqual(parsePorts('\nNo ports are open.\n  40132  \n'), [40132]);
  });

  it('returns nothing for empty output', () => {
    assert.deepEqual(parsePorts(''), []);
  });
});

describe('parseAssignedPort', () => {
  it('reads the number out of the confirmation', () => {
    assert.equal(
      parseAssignedPort('Port 40132 will be open for TCP and UDP traffic in a few minutes.'),
      40132,
    );
  });

  it('returns null when the wording does not contain a port', () => {
    assert.equal(parseAssignedPort('Something unexpected happened.'), null);
  });
});

describe('isWildcardAddress', () => {
  it('accepts the binds the firewall can expose', () => {
    for (const address of ['0.0.0.0', '::', '[::]', '*']) {
      assert.equal(isWildcardAddress(address), true, address);
    }
  });

  it('rejects loopback and specific addresses', () => {
    for (const address of ['127.0.0.1', '::1', '[::1]', '10.0.0.5', '%lo']) {
      assert.equal(isWildcardAddress(address), false, address);
    }
  });
});

describe('parseListeners', () => {
  const sample = [
    'tcp   LISTEN 0      511    0.0.0.0:8080  0.0.0.0:*    users:(("node",pid=1234,fd=20))',
    'tcp   LISTEN 0      128    [::]:40132    [::]:*       users:(("agent",pid=99,fd=3))',
    'tcp   LISTEN 0      128    127.0.0.1:3000 0.0.0.0:*   users:(("python3",pid=77,fd=5))',
    'udp   UNCONN 0      0      *:40133       *:*          users:(("dns",pid=42,fd=7))',
  ].join('\n');

  it('reads protocol, address, port, pid and process name', () => {
    const [first] = parseListeners(sample);
    assert.equal(first?.protocol, 'tcp');
    assert.equal(first?.address, '0.0.0.0');
    assert.equal(first?.port, 8080);
    assert.equal(first?.pid, 1234);
    assert.equal(first?.process, 'node');
    assert.equal(first?.wildcard, true);
  });

  it('splits IPv6 addresses on the last colon', () => {
    const listener = parseListeners(sample)[1];
    assert.equal(listener?.address, '[::]');
    assert.equal(listener?.port, 40132);
    assert.equal(listener?.wildcard, true);
  });

  it('marks a loopback bind as unreachable', () => {
    const listener = parseListeners(sample)[2];
    assert.equal(listener?.address, '127.0.0.1');
    assert.equal(listener?.wildcard, false);
  });

  it('keeps udp sockets, which are UNCONN rather than LISTEN', () => {
    const listener = parseListeners(sample)[3];
    assert.equal(listener?.protocol, 'udp');
    assert.equal(listener?.port, 40133);
  });

  it('keeps a socket ss could not attribute to a process', () => {
    const [listener] = parseListeners('tcp LISTEN 0 128 0.0.0.0:9000 0.0.0.0:*');
    assert.equal(listener?.port, 9000);
    assert.equal(listener?.pid, null);
    assert.equal(listener?.process, '');
  });

  it('skips rows that are not tcp or udp', () => {
    assert.deepEqual(parseListeners('nl UNCONN 0 0 rtnl:kernel *'), []);
  });
});

describe('buildServiceIni', () => {
  const base = {
    name: 'my-daemon',
    command: '/home/isabell/bin/my-daemon --port 40132',
    autostart: true,
    autorestart: true,
    startsecs: 10,
  };

  it('renders a section supervisord will pick up', () => {
    const ini = buildServiceIni(base);
    assert.match(ini, /^\[program:my-daemon\]$/m);
    assert.match(ini, /^command=\/home\/isabell\/bin\/my-daemon --port 40132$/m);
    assert.match(ini, /^autostart=yes$/m);
    assert.match(ini, /^autorestart=yes$/m);
    assert.match(ini, /^startsecs=10$/m);
    assert.ok(ini.endsWith('\n'));
  });

  it('omits the directory when there is none', () => {
    assert.ok(!buildServiceIni(base).includes('directory='));
  });

  it('renders environment in supervisord quoting', () => {
    const ini = buildServiceIni({
      ...base,
      environment: { NODE_ENV: 'production', PORT: '40132' },
    });
    assert.match(ini, /^environment=NODE_ENV="production",PORT="40132"$/m);
  });

  it('writes no over yes for a service that should not start on boot', () => {
    const ini = buildServiceIni({ ...base, autostart: false, autorestart: false });
    assert.match(ini, /^autostart=no$/m);
    assert.match(ini, /^autorestart=no$/m);
  });

  it('refuses a command that would inject another directive', () => {
    assert.throws(
      () => buildServiceIni({ ...base, command: '/bin/true\nautostart=no' }),
      ServiceSpecError,
    );
  });

  it('refuses an empty command', () => {
    assert.throws(() => buildServiceIni({ ...base, command: '' }), ServiceSpecError);
  });

  it('refuses a name supervisord could not address', () => {
    assert.throws(() => buildServiceIni({ ...base, name: 'my daemon' }), ServiceSpecError);
  });

  it('refuses an environment value containing a quote', () => {
    assert.throws(
      () => buildServiceIni({ ...base, environment: { TOKEN: 'a"b' } }),
      ServiceSpecError,
    );
  });

  it('refuses an environment name that is not a shell identifier', () => {
    assert.throws(
      () => buildServiceIni({ ...base, environment: { 'not-valid': 'x' } }),
      ServiceSpecError,
    );
  });

  it('refuses startsecs outside the accepted range', () => {
    assert.throws(() => buildServiceIni({ ...base, startsecs: -1 }), ServiceSpecError);
    assert.throws(() => buildServiceIni({ ...base, startsecs: 99_999 }), ServiceSpecError);
  });
});

describe('backupPath', () => {
  it('accepts an absolute path and drops a trailing slash', () => {
    assert.equal(backupPath('/home/isabell/app/'), '/home/isabell/app');
  });

  it('keeps spaces, which are legal in filenames', () => {
    assert.equal(backupPath('/home/isabell/my notes'), '/home/isabell/my notes');
  });

  it('rejects a relative path', () => {
    assert.throws(() => backupPath('home/isabell'), /absolute/);
  });

  it('rejects traversal rather than normalising it away', () => {
    assert.throws(() => backupPath('/home/isabell/../../etc'), /\.\./);
  });

  it('rejects null bytes', () => {
    assert.throws(() => backupPath('/home/isabell/\0evil'), /null/);
  });

  it('collapses redundant separators', () => {
    assert.equal(backupPath('/home//isabell///app'), '/home/isabell/app');
  });
});

describe('isRestorable', () => {
  const roots = ['/home/isabell', '/var/www/virtual/isabell'];

  it('allows the roots themselves and anything below them', () => {
    assert.equal(isRestorable('/home/isabell', roots), true);
    assert.equal(isRestorable('/home/isabell/app/public', roots), true);
    assert.equal(isRestorable('/var/www/virtual/isabell/html', roots), true);
  });

  it('refuses paths outside the account', () => {
    assert.equal(isRestorable('/etc', roots), false);
    assert.equal(isRestorable('/home/someoneelse', roots), false);
    assert.equal(isRestorable('/var/www/virtual/other', roots), false);
  });

  it('does not treat a longer sibling name as being inside the root', () => {
    assert.equal(isRestorable('/home/isabellx/app', roots), false);
  });
});

describe('snapshotPath', () => {
  it('mirrors the live path under the snapshot', () => {
    assert.equal(
      snapshotPath('daily.3', '/var/www/virtual/isabell/html'),
      '/backup/daily.3/var/www/virtual/isabell/html',
    );
  });
});

describe('parseSnapshotName', () => {
  it('reads the kind and index', () => {
    assert.deepEqual(parseSnapshotName('daily.0'), { kind: 'daily', index: 0 });
    assert.deepEqual(parseSnapshotName('weekly.7'), { kind: 'weekly', index: 7 });
  });

  it('rejects names outside the documented rotation', () => {
    for (const name of ['daily.7', 'weekly.0', 'weekly.8', 'hourly.1', 'daily', 'lost+found']) {
      assert.equal(parseSnapshotName(name), null, name);
    }
  });
});

describe('sortSnapshots', () => {
  it('puts the newest daily first and the weeklies last', () => {
    const sorted = sortSnapshots([
      { id: 'weekly.1', kind: 'weekly', index: 1, mtime: null },
      { id: 'daily.6', kind: 'daily', index: 6, mtime: null },
      { id: 'daily.0', kind: 'daily', index: 0, mtime: null },
    ]);
    assert.deepEqual(
      sorted.map((entry) => entry.id),
      ['daily.0', 'daily.6', 'weekly.1'],
    );
  });
});

describe('rsyncPair', () => {
  it('copies contents when the source is a directory', () => {
    assert.deepEqual(rsyncPair('/backup/daily.3/home/x/app', '/home/x/app', true), {
      source: '/backup/daily.3/home/x/app/',
      target: '/home/x/app/',
    });
  });

  it('leaves a file without trailing slashes', () => {
    assert.deepEqual(rsyncPair('/backup/daily.3/home/x/a.txt', '/home/x/a.txt', false), {
      source: '/backup/daily.3/home/x/a.txt',
      target: '/home/x/a.txt',
    });
  });
});

describe('isOwnDump', () => {
  it('accepts dumps in the account own directories', () => {
    assert.equal(isOwnDump('/mysql_backup/current/isabell/isabell.sql.xz', 'isabell'), true);
    assert.equal(isOwnDump('/mysql_backup/old/isabell/2026-08-01.sql.xz', 'isabell'), true);
  });

  it('refuses another account and anything outside the backup root', () => {
    assert.equal(isOwnDump('/mysql_backup/current/other/dump.sql.xz', 'isabell'), false);
    assert.equal(isOwnDump('/home/isabell/dump.sql.xz', 'isabell'), false);
    assert.equal(isOwnDump('/mysql_backup/current/isabell', 'isabell'), false);
  });
});

describe('isOwnDatabase', () => {
  it('accepts the account database and its prefixed ones', () => {
    assert.equal(isOwnDatabase('isabell', 'isabell'), true);
    assert.equal(isOwnDatabase('isabell_blog', 'isabell'), true);
    assert.equal(isOwnDatabase('isabell_a_b_c', 'isabell'), true);
  });

  it('refuses names that only look related', () => {
    assert.equal(isOwnDatabase('isabellx', 'isabell'), false);
    assert.equal(isOwnDatabase('other_isabell', 'isabell'), false);
    assert.equal(isOwnDatabase('mysql', 'isabell'), false);
    assert.equal(isOwnDatabase('isabell_', 'isabell'), false);
  });

  it('refuses anything that could carry SQL, since the name is interpolated', () => {
    for (const name of [
      'isabell_a`b',
      'isabell_a b',
      'isabell_a;DROP DATABASE isabell',
      'isabell_a-b',
      "isabell_a'b",
    ]) {
      assert.equal(isOwnDatabase(name, 'isabell'), false, name);
    }
  });
});

describe('parseRows', () => {
  it('splits tab separated output and drops blank lines', () => {
    assert.deepEqual(parseRows('a\t1\nb\t2\n\n'), [
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('tolerates carriage returns', () => {
    assert.deepEqual(parseRows('a\t1\r\n'), [['a', '1']]);
  });
});

describe('parseNumber', () => {
  it('reads a number', () => {
    assert.equal(parseNumber('4096'), 4096);
  });

  it('treats the batch-mode NULL and empty as absent', () => {
    assert.equal(parseNumber('NULL'), null);
    assert.equal(parseNumber(''), null);
    assert.equal(parseNumber(undefined), null);
  });

  it('refuses text rather than returning NaN', () => {
    assert.equal(parseNumber('lots'), null);
  });
});

describe('mergeDatabases', () => {
  const sizes = new Map([['isabell_blog', { size: 4096, tables: 3 }]]);

  it('keeps an empty database that information_schema does not report', () => {
    const merged = mergeDatabases(['isabell', 'isabell_blog'], sizes, 'isabell');
    const empty = merged.find((entry) => entry.name === 'isabell');
    assert.equal(empty?.size, null);
    assert.equal(empty?.tables, null);
  });

  it('carries size and table count across', () => {
    const [, blog] = mergeDatabases(['isabell', 'isabell_blog'], sizes, 'isabell');
    assert.equal(blog?.size, 4096);
    assert.equal(blog?.tables, 3);
  });

  it('marks the account database as not removable', () => {
    const merged = mergeDatabases(['isabell', 'isabell_blog'], sizes, 'isabell');
    assert.equal(merged.find((entry) => entry.name === 'isabell')?.removable, false);
    assert.equal(merged.find((entry) => entry.name === 'isabell_blog')?.removable, true);
  });

  it('hides the server databases the account cannot touch', () => {
    const merged = mergeDatabases(
      ['information_schema', 'mysql', 'performance_schema', 'isabell'],
      sizes,
      'isabell',
    );
    assert.deepEqual(
      merged.map((entry) => entry.name),
      ['isabell'],
    );
  });
});

describe('parseForward', () => {
  it('reads the destination address', () => {
    assert.equal(parseForward('forwardme -> mail@example.com'), 'mail@example.com');
  });

  it('reads it out of a sentence without swallowing the full stop', () => {
    assert.equal(
      parseForward('Mail for forwardme is forwarded to post@example.org.'),
      'post@example.org',
    );
  });

  it('returns null when no forward is set', () => {
    assert.equal(parseForward('No forward is configured for forwardme.'), null);
    assert.equal(parseForward(''), null);
  });
});

describe('parseCatchall', () => {
  it('reads a quoted mailbox name', () => {
    assert.equal(parseCatchall("The catchall is set to 'post'"), 'post');
  });

  it('reads a trailing mailbox name', () => {
    assert.equal(parseCatchall('Catchall: post'), 'post');
  });

  it('returns null when there is none', () => {
    assert.equal(parseCatchall('No catchall is set.'), null);
    assert.equal(parseCatchall('   '), null);
  });
});

describe('parseSpamfolder', () => {
  it('reads the enabled state', () => {
    assert.equal(parseSpamfolder('The spamfolder is enabled.'), true);
  });

  it('does not read "disabled" as "enabled"', () => {
    assert.equal(parseSpamfolder('The spamfolder is disabled.'), false);
  });
});

describe('isValidSieveName', () => {
  it('accepts ordinary script names', () => {
    assert.equal(isValidSieveName('privat.sieve'), true);
    assert.equal(isValidSieveName('work-2026.sieve'), true);
  });

  it('refuses anything that is not a plain .sieve file', () => {
    for (const name of [
      'privat',
      'privat.txt',
      '../escape.sieve',
      'a/b.sieve',
      '.hidden.sieve',
      'a..b.sieve',
    ]) {
      assert.equal(isValidSieveName(name), false, name);
    }
  });
});

describe('isValidEmail', () => {
  it('accepts ordinary addresses', () => {
    assert.equal(isValidEmail('post@example.com'), true);
    assert.equal(isValidEmail('a.b+c@sub.example.co.uk'), true);
  });

  it('refuses values that would confuse the CLI', () => {
    for (const value of ['post', 'post@', '@example.com', 'a b@example.com', 'a@b', 'a,b@c.de']) {
      assert.equal(isValidEmail(value), false, value);
    }
  });
});

describe('parseHeaders', () => {
  const sample = [
    '/blog',
    '  X-Clacks-Overhead: GNU Terry Pratchett',
    '  X-Custom: value with spaces',
    '',
    'Default Headers',
    '  X-Frame-Options: SAMEORIGIN',
    '  Strict-Transport-Security: max-age=31536000',
  ].join('\n');

  it('attributes headers to the group above them', () => {
    const [first] = parseHeaders(sample);
    assert.equal(first?.target, '/blog');
    assert.equal(first?.name, 'X-Clacks-Overhead');
    assert.equal(first?.value, 'GNU Terry Pratchett');
  });

  it('keeps values containing spaces intact', () => {
    assert.equal(parseHeaders(sample)[1]?.value, 'value with spaces');
  });

  it('marks the platform defaults', () => {
    const defaults = parseHeaders(sample).filter((header) => header.isDefault);
    assert.deepEqual(
      defaults.map((header) => header.name),
      ['X-Frame-Options', 'Strict-Transport-Security'],
    );
  });

  it('recognises a default header even outside the defaults section', () => {
    const [header] = parseHeaders('/blog\n  X-Frame-Options: DENY');
    assert.equal(header?.isDefault, true);
  });
});

describe('toPunycode', () => {
  it('leaves an ASCII domain alone', () => {
    assert.equal(toPunycode('example.com'), 'example.com');
  });

  it('converts an umlaut domain the way idn would', () => {
    assert.equal(toPunycode('überspace.de'), 'xn--berspace-55a.de');
  });

  it('returns null when IDNA rejects the name outright', () => {
    assert.equal(toPunycode(' ü'), null);
  });

  it('passes ASCII through untouched, leaving validation to the caller', () => {
    // Not this function's job to decide what is a valid domain; domainName()
    // does that next, and would reject this.
    assert.equal(toPunycode('  '), '  ');
  });
});

describe('shouldRestart', () => {
  it('fires when a certificate is newer than the last one handled', () => {
    assert.equal(shouldRestart(2000, 1000), true);
  });

  it('stays quiet when nothing changed', () => {
    assert.equal(shouldRestart(1000, 1000), false);
  });

  it('does not fire on the very first pass, which only records a baseline', () => {
    assert.equal(shouldRestart(1000, null), false);
  });

  it('does nothing when there are no certificates', () => {
    assert.equal(shouldRestart(null, 1000), false);
  });
});

describe('isValidHeaderValue', () => {
  it('accepts an ordinary value', () => {
    assert.equal(isValidHeaderValue('max-age=31536000'), true);
  });

  it('refuses a value that would inject a second header', () => {
    assert.equal(isValidHeaderValue('a\r\nX-Evil: 1'), false);
    assert.equal(isValidHeaderValue(''), false);
  });
});

describe('handler registry', () => {
  it('has a handler for every method the protocol declares', () => {
    // The agent throws at startup on a mismatch; catching it here means a
    // missing registration fails on the way to the host, not on it.
    assert.deepEqual(missingHandlers(), []);
  });

  it('registers nothing the protocol does not declare', () => {
    assert.deepEqual(strayHandlers(), []);
  });
});

describe('parseCrontab', () => {
  const sample = [
    'MAILTO=""',
    '# eine Notiz',
    '*/5 * * * * /home/isabell/bin/check',
    '# 0 3 * * * /home/isabell/bin/nightly',
    '@daily /home/isabell/bin/rotate',
    '',
  ].join('\n');

  it('recognises an environment assignment', () => {
    const [line] = parseCrontab(sample);
    assert.equal(line?.kind, 'env');
  });

  it('keeps a plain comment as a comment', () => {
    assert.equal(parseCrontab(sample)[1]?.kind, 'comment');
  });

  it('reads schedule and command apart', () => {
    const line = parseCrontab(sample)[2];
    assert.equal(line?.kind, 'job');
    assert.equal(line?.enabled, true);
    assert.equal(line?.schedule, '*/5 * * * *');
    assert.equal(line?.command, '/home/isabell/bin/check');
  });

  it('sees a commented-out job as a disabled job, not a comment', () => {
    const line = parseCrontab(sample)[3];
    assert.equal(line?.kind, 'job');
    assert.equal(line?.enabled, false);
    assert.equal(line?.command, '/home/isabell/bin/nightly');
  });

  it('handles the @aliases', () => {
    const line = parseCrontab(sample)[4];
    assert.equal(line?.schedule, '@daily');
    assert.equal(line?.command, '/home/isabell/bin/rotate');
  });
});

describe('serializeCrontab', () => {
  it('round-trips a crontab unchanged', () => {
    const original = 'MAILTO=""\n# note\n*/5 * * * * /bin/check\n';
    assert.equal(serializeCrontab(parseCrontab(original)), original);
  });

  it('comments out a job that was switched off', () => {
    const lines = parseCrontab('*/5 * * * * /bin/check\n');
    const [job] = lines;
    if (job) job.enabled = false;
    assert.match(serializeCrontab(lines), /^# \*\/5 \* \* \* \* \/bin\/check$/m);
  });

  it('always ends with a newline, which some crontabs require', () => {
    assert.ok(serializeCrontab(parseCrontab('*/5 * * * * /bin/check')).endsWith('\n'));
  });
});

describe('describeSchedule', () => {
  it('describes the aliases', () => {
    assert.equal(describeSchedule('@reboot'), 'beim Start des Servers');
    assert.equal(describeSchedule('@hourly'), 'stündlich');
  });

  it('describes simple intervals', () => {
    assert.equal(describeSchedule('*/5 * * * *'), 'alle 5 Minuten');
    assert.equal(describeSchedule('0 */6 * * *'), 'alle 6 Stunden');
    assert.equal(describeSchedule('30 3 * * *'), 'täglich um 03:30');
    assert.equal(describeSchedule('15 * * * *'), 'stündlich zur Minute 15');
  });

  it('declines to describe an expression a phrase would misrepresent', () => {
    assert.equal(describeSchedule('0 3 * * 1-5'), null);
    assert.equal(describeSchedule('0 0 1 1 *'), null);
    assert.equal(describeSchedule('nonsense'), null);
  });
});

describe('parseDiskUsage', () => {
  it('maps each path to its byte count', () => {
    const sizes = parseDiskUsage('4096\t/home/isabell\n8192\t/tmp\n');
    assert.equal(sizes.get('/home/isabell'), 4096);
    assert.equal(sizes.get('/tmp'), 8192);
  });

  it('keeps paths containing spaces intact', () => {
    assert.equal(parseDiskUsage('42\t/home/isabell/my files').get('/home/isabell/my files'), 42);
  });
});

describe('parseDeletedFiles', () => {
  const sample = [
    'COMMAND   PID    USER  FD  TYPE DEVICE SIZE/OFF NLINK NODE NAME',
    'node    1234 isabell  12u  REG  253,1 104857600     0  999 /home/isabell/logs/app.log (deleted)',
    'php     5678 isabell   3u  REG  253,1   1048576     0  888 /tmp/session',
  ].join('\n');

  it('skips the header and reads the columns', () => {
    const [first] = parseDeletedFiles(sample);
    assert.equal(first?.pid, 1234);
    assert.equal(first?.process, 'node');
    assert.equal(first?.bytes, 104857600);
    assert.match(first?.path ?? '', /app\.log/);
  });

  it('puts the biggest waste first', () => {
    assert.equal(parseDeletedFiles(sample)[0]?.pid, 1234);
    assert.equal(parseDeletedFiles(sample)[1]?.pid, 5678);
  });
});

describe('parseMemory', () => {
  it('sums kilobyte values into bytes', () => {
    const { rssBytes, processCount } = parseMemory('1024\n2048\n');
    assert.equal(rssBytes, 3072 * 1024);
    assert.equal(processCount, 2);
  });

  it('ignores blank lines', () => {
    assert.equal(parseMemory('\n1024\n\n').processCount, 1);
  });
});

describe('parseShells', () => {
  it('keeps only absolute paths', () => {
    assert.deepEqual(parseShells('/bin/bash\n/bin/zsh\nnot a shell\n'), ['/bin/bash', '/bin/zsh']);
  });
});

describe('parseQuota on a host without the group', () => {
  it('reports nothing parsed rather than zero used', () => {
    // supervisord strips supplementary groups, so `quota -g` prints nothing at
    // all. The handler turns this into an error; the parser must at least not
    // claim a confident 0 with a real limit.
    const quota = parseQuota('');
    assert.equal(quota.used, 0);
    assert.equal(quota.limit, null);
    assert.equal(quota.raw, '');
  });

  it('parses the real output from an Uberspace host', () => {
    const output = [
      'Disk quotas for group isabell (gid 1234): ',
      '     Filesystem   space   quota   limit   grace   files   quota   limit   grace',
      '      /dev/sda2   6343M  10240M  11264M            281k       0       0        ',
    ].join('\n');

    const quota = parseQuota(output);
    assert.equal(quota.used, 6343 * 1024 ** 2);
    assert.equal(quota.limit, 10240 * 1024 ** 2);
    assert.equal(quota.percent, 61.9);
  });
});

describe('decodePairing', () => {
  const valid = {
    v: 1 as const,
    url: 'wss://isabell.uber.space/uberapp',
    token: 'a'.repeat(43),
    exp: 1_800_000_000_000,
  };

  it('round-trips a pairing payload', () => {
    assert.deepEqual(decodePairing(encodePairing(valid)), valid);
  });

  it('accepts a payload without an expiry', () => {
    const decoded = decodePairing(encodePairing({ ...valid, exp: null }));
    assert.equal(decoded?.exp, null);
  });

  it('returns null for anything that is not a pairing code', () => {
    // A camera pointed at the world reads all sorts of things; none of them
    // should reach the connection logic.
    for (const text of [
      'https://example.com',
      'not json at all',
      '{}',
      JSON.stringify({ ...valid, v: 2 }),
      JSON.stringify({ ...valid, url: 'http://example.com' }),
      JSON.stringify({ ...valid, token: 'too-short' }),
      JSON.stringify({ ...valid, url: 42 }),
    ]) {
      assert.equal(decodePairing(text), null, text.slice(0, 40));
    }
  });
});

describe('token store helpers', () => {
  it('treats a passed expiry as expired and a future one as live', () => {
    const now = 1_000_000;
    assert.equal(isExpired({ expiresAt: now - 1 }, now), true);
    assert.equal(isExpired({ expiresAt: now + 1 }, now), false);
    assert.equal(isExpired({ expiresAt: now }, now), true);
  });

  it('never expires a token without an expiry', () => {
    assert.equal(isExpired({ expiresAt: null }), false);
  });

  it('prunes exactly the dead entries', () => {
    const now = 1_000_000;
    const entries = [
      { id: 'a', hash: '', label: null, createdAt: 0, expiresAt: now - 1, lastUsedAt: null },
      { id: 'b', hash: '', label: null, createdAt: 0, expiresAt: now + 1, lastUsedAt: null },
      { id: 'c', hash: '', label: null, createdAt: 0, expiresAt: null, lastUsedAt: null },
    ];
    assert.deepEqual(
      prune(entries, now).map((entry) => entry.id),
      ['b', 'c'],
    );
  });

  it('hashes deterministically and differently per token', () => {
    assert.equal(hashToken('abc'), hashToken('abc'));
    assert.notEqual(hashToken('abc'), hashToken('abd'));
    assert.match(hashToken('abc'), /^[0-9a-f]{64}$/);
  });

  it('compares digests without throwing on a length mismatch', () => {
    assert.equal(digestsMatch(hashToken('abc'), hashToken('abc')), true);
    assert.equal(digestsMatch(hashToken('abc'), hashToken('abd')), false);
    assert.equal(digestsMatch(hashToken('abc'), 'ff'), false);
  });
});
