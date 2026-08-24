import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { failureReason } from '@uberctrl/protocol';

/**
 * The case this exists for, recorded verbatim: `uberspace tools version use
 * node 22` against a host whose quota was full. Reading the first line gave
 * "Unhandled error:" and nothing else, while the reason sat on the last one.
 */
const QUOTA_TRACEBACK = `Unhandled error:
 Traceback (most recent call last):
  File "/opt/uberspace/python-venv-2.7/lib/python2.7/site-packages/ansible/config/manager.py", line 575, in update_config_data
    value, origin = self.get_config_value_and_origin(config, configfile)
  File "/opt/uberspace/python-venv-2.7/lib/python2.7/site-packages/ansible/config/manager.py", line 519, in get_config_value_and_origin
    value = self.get_config_value(config, configfile)
IOError: [Errno 122] Disk quota exceeded: '/opt/uberspace/userfacts/isabell/used_versions/.node.yml.10956'`;

describe('failureReason', () => {
  it('reads the reason off the end of a traceback, not the front', () => {
    const reason = failureReason(QUOTA_TRACEBACK, 'fallback');
    assert.match(reason, /Disk quota exceeded/);
    assert.doesNotMatch(reason, /Unhandled error/);
  });

  it('keeps taking the first line when there is no traceback', () => {
    const output = 'domain is already in use\nsee "uberspace web domain list"';
    assert.equal(failureReason(output, 'fallback'), 'domain is already in use');
  });

  it('skips blank lines rather than returning one', () => {
    assert.equal(failureReason('\n\n  no such service  \n\n', 'fallback'), 'no such service');
  });

  it('falls back when the command said nothing at all', () => {
    assert.equal(failureReason('', 'fallback'), 'fallback');
    assert.equal(failureReason('   \n\t\n', 'fallback'), 'fallback');
  });
});
