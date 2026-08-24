import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateLegacyConfig } from '../src/migrate.js';

/**
 * The rename from uberapp to uberctrl moved the directory holding the master
 * token. Getting this wrong has one very specific consequence: every paired
 * device stops authenticating, and the agent looks like a fresh install to a
 * person who changed nothing. So the interesting cases are the ones where it
 * must keep its hands off.
 */

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'uberctrl-migrate-'));
});

afterEach(() => {});

const legacy = () => join(home, '.config', 'uberapp');
const current = () => join(home, '.config', 'uberctrl');

async function seed(dir: string, token: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'token'), token, 'utf8');
}

describe('migrateLegacyConfig', () => {
  it('carries the old directory over, contents intact', async () => {
    await seed(legacy(), 'geheim');

    const said = await migrateLegacyConfig(home);

    assert.match(String(said), /moved/);
    assert.equal(await readFile(join(current(), 'token'), 'utf8'), 'geheim');
  });

  it('does nothing on a host that never had the old name', async () => {
    await seed(current(), 'neu');

    assert.equal(await migrateLegacyConfig(home), null);
    assert.equal(await readFile(join(current(), 'token'), 'utf8'), 'neu');
  });

  it('leaves both alone when both exist', async () => {
    // The dangerous case. If this overwrote the new directory, a working host
    // would be thrown back to whatever the old one happened to contain.
    await seed(legacy(), 'alt');
    await seed(current(), 'neu');

    assert.equal(await migrateLegacyConfig(home), null);
    assert.equal(await readFile(join(current(), 'token'), 'utf8'), 'neu');
    assert.equal(await readFile(join(legacy(), 'token'), 'utf8'), 'alt');
  });

  it('does nothing at all on a fresh host', async () => {
    assert.equal(await migrateLegacyConfig(home), null);
  });

  it('is safe to run twice', async () => {
    await seed(legacy(), 'geheim');

    await migrateLegacyConfig(home);
    assert.equal(await migrateLegacyConfig(home), null);

    assert.equal(await readFile(join(current(), 'token'), 'utf8'), 'geheim');
  });
});
