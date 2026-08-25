/**
 * Reading `uberspace tools version`.
 *
 * The two shapes below are copied from the Uberspace 7 manual (lang-nodejs,
 * lang-php), not invented here — the point of this file is that the parser is
 * pinned to what the CLI actually prints, which nothing checked until
 * 2026-08-25.
 *
 * The bug it was hiding: the list is a *bulleted* list, and the old filter
 * kept only lines matching /^[\d.]+$/. "- 20" is not such a line, so every
 * tool came back with an empty set of versions — and an empty set is not an
 * error, so it read as "this host cannot switch anything".
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { KNOWN_TOOLS, parseToolVersion } from '@uberctrl/protocol';

describe('parseToolVersion', () => {
  it('reads the manual’s own example for node', () => {
    const show = "Using 'node' version: '20'\n";
    const list = '- 18\n- 20\n- 22\n';

    assert.deepEqual(parseToolVersion('node', show, list), {
      tool: 'node',
      current: '20',
      available: ['18', '20', '22'],
    });
  });

  it('reads a php version with a dot in it', () => {
    const show = "Using 'php' version: '8.2'\n";
    const list = '- 8.2\n- 8.3\n- 8.4\n- 8.5\n';

    const parsed = parseToolVersion('php', show, list);
    assert.equal(parsed.current, '8.2');
    assert.deepEqual(parsed.available, ['8.2', '8.3', '8.4', '8.5']);
  });

  it('survives a list without bullets', () => {
    // Not seen in the wild; the older parser assumed it, so it stays covered.
    assert.deepEqual(parseToolVersion('go', '', '1.21\n1.22\n').available, ['1.21', '1.22']);
  });

  it('keeps the version when the line is worded differently', () => {
    assert.equal(parseToolVersion('ruby', 'ruby version 3.3 is in use', '').current, '3.3');
  });

  it('reports an unknown current version rather than guessing', () => {
    assert.equal(parseToolVersion('deno', '', '').current, null);
  });

  it('drops prose that is not a version', () => {
    const list = 'Available versions:\n- 18\nnothing else\n';
    assert.deepEqual(parseToolVersion('node', '', list).available, ['18']);
  });

  it('keeps versions that are names rather than numbers', () => {
    // rust is the case that proved this: a real host answers `show rust` with
    // "Using 'rust' version: 'stable'". Requiring a digit dropped the only
    // name it has, and the screen then said rust had no selectable versions
    // while showing 'stable' as the current one.
    const parsed = parseToolVersion('rust', "Using 'rust' version: 'stable'\n", '- stable\n- nightly\n');
    assert.equal(parsed.current, 'stable');
    assert.deepEqual(parsed.available, ['stable', 'nightly']);
  });

  it('names every tool the manual documents as switchable', () => {
    // A guard on the shared list: the client walks it to ask tool by tool, so
    // dropping an entry silently removes a tool from the interface.
    for (const tool of ['php', 'node', 'python', 'postgresql', 'mongodb']) {
      assert.ok(KNOWN_TOOLS.includes(tool as (typeof KNOWN_TOOLS)[number]), tool);
    }
  });
});
