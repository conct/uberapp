/**
 * Cleaning up what a pty echoes back.
 *
 * The agent answers the password prompts itself. Leaving them in the output
 * makes it look as though something is still waiting for input, which is the
 * one thing the user should not have to wonder about after the mailbox has
 * already been created.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { withoutPrompts } from '../src/exec.js';
import { rejectedByCli } from '../src/handlers/mail.js';

describe('withoutPrompts', () => {
  it('removes the prompts the agent answered', () => {
    const output = [
      'Enter a password for the mailbox: ',
      'Please confirm your password: ',
      'The mailbox post@example.org has been created.',
    ].join('\n');

    assert.equal(withoutPrompts(output), 'The mailbox post@example.org has been created.');
  });

  it('survives the carriage returns a pty leaves behind', () => {
    const output = 'Enter a password for the mailbox: \r\nDone.\r\n';
    assert.equal(withoutPrompts(output), 'Done.');
  });

  it('keeps a result line even when it ends with a colon', () => {
    const output = ['Enter a password for the mailbox:', 'Created mailbox:', 'post'].join('\n');
    assert.equal(withoutPrompts(output), 'Created mailbox:\npost');
  });

  it('keeps anything that mentions a password without being a prompt', () => {
    for (const line of [
      'Your password was too weak.',
      'The password must have a zxcvbn score of 4.',
      'password rejected',
    ]) {
      assert.equal(withoutPrompts(line), line, line);
    }
  });

  it('collapses the blank space the removed lines leave', () => {
    const output = 'Enter a password for the mailbox:\n\n\n\nDone.';
    assert.equal(withoutPrompts(output), 'Done.');
  });

  it('returns nothing when there was nothing but prompts', () => {
    assert.equal(withoutPrompts('Enter a password for the mailbox: \nConfirm your password: '), '');
  });
});

describe('rejectedByCli', () => {
  it('does not read the stated rule as a verdict', () => {
    // Exactly the sentence the previous check tripped over: the CLI naming
    // its own requirement, next to the line that says the mailbox exists.
    const output = [
      'The password must have a zxcvbn score of 4.',
      'The mailbox post@example.org has been created.',
    ].join('\n');
    assert.equal(rejectedByCli(output), false);
  });

  it('still catches a password the CLI turned down', () => {
    for (const output of [
      'Your password was too weak.',
      'Error: could not create mailbox',
      'creating the mailbox failed',
    ]) {
      assert.equal(rejectedByCli(output), true, output);
    }
  });

  it('says nothing about ordinary success', () => {
    assert.equal(rejectedByCli('The mailbox post@example.org has been created.'), false);
  });
});
