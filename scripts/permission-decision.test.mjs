#!/usr/bin/env node --test
/**
 * Unit tests for the permission-answer decision table (`src/permissionAnswer.ts`).
 *
 * These cover what the end-to-end smokes cannot force on demand:
 *   - the structured `permission_response` taking precedence over the text;
 *   - the tolerant free-text rules, word by word;
 *   - `permissionKey`, the identity used by the per-task denial record — the
 *     same-key repeat protection in the executor is exactly
 *     "`entry.deniedPrompts.has(permissionKey(tool, input))` -> auto-deny with
 *     `interrupt: true`", and reproducing it live would need Claude to re-ask
 *     for a permission the denial message just told it not to re-ask for.
 *
 * Run with `npm run test:unit` (Node strips the TS types natively).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readPermissionAnswer,
  permissionKey,
  denialMessage,
  words,
} from '../src/permissionAnswer.ts';

const allows = (text, data) => readPermissionAnswer(text, data).decision === 'allow';

test('structured permission_response wins over the text', () => {
  assert.deepEqual(
    readPermissionAnswer('no way', { kind: 'permission_response', decision: 'allow' }),
    { decision: 'allow', source: 'structured' }
  );

  const denied = readPermissionAnswer('yes', {
    kind: 'permission_response', decision: 'deny', reason: 'not on prod',
  });
  assert.deepEqual(denied, { decision: 'deny', reason: 'not on prod', source: 'structured' });
});

test('a structured deny without a reason still carries one', () => {
  const denied = readPermissionAnswer('', { kind: 'permission_response', decision: 'deny' });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.reason, 'no reason given');
});

test('a data part of another kind is ignored, the text decides', () => {
  assert.equal(allows('yes', { kind: 'ask_user_question', decision: 'deny' }), true);
  assert.equal(allows('yes', { answers: { 'Which colour?': 'blue' } }), true);
});

test('short affirmative free text allows', () => {
  for (const text of [
    'yes', 'Yes.', 'y', 'oui', 'OK', 'okay', 'sure', 'allow', 'go',
    'vas-y', "d'accord", 'autorise', 'oui, vas-y', 'ok go ahead', 'Sure, allow it!',
  ]) {
    assert.equal(allows(text), true, `expected "${text}" to allow`);
  }
});

test('short negative free text denies, keeping the text as the reason', () => {
  for (const text of ['no', 'non', 'nope', 'deny', 'refuse', 'stop', 'cancel', 'annule', 'jamais']) {
    const answer = readPermissionAnswer(text);
    assert.equal(answer.decision, 'deny', `expected "${text}" to deny`);
    assert.equal(answer.reason, text);
  }
});

test('a deny word beats an allow word in the same reply', () => {
  assert.equal(allows('ok but no'), false);
  assert.equal(allows('yes, but stop after that'), false);
});

test('ambiguous or long replies deny with an explanatory reason, not an echo', () => {
  const ambiguous = readPermissionAnswer('maybe later');
  assert.equal(ambiguous.decision, 'deny');
  assert.match(ambiguous.reason, /neither a clear yes nor a clear no/);

  // 9 words, so past the short-reply window even though it starts with "yes".
  const long = readPermissionAnswer('yes but only if you also update the other file');
  assert.equal(long.decision, 'deny');
  assert.match(long.reason, /neither a clear yes nor a clear no/);
});

test('an empty reply denies', () => {
  const answer = readPermissionAnswer('   ', undefined);
  assert.equal(answer.decision, 'deny');
  assert.equal(answer.reason, 'the client sent no answer');
});

test('words() keeps hyphens and apostrophes inside a word', () => {
  assert.deepEqual(words("Oui, vas-y ! D’accord."), ['oui', 'vas-y', "d'accord"]);
  assert.deepEqual(words('yes.'), ['yes']);
});

test('the denial message tells Claude not to re-ask', () => {
  const message = denialMessage('not on prod');
  assert.match(message, /^The user denied this action \(not on prod\)\./);
  assert.match(message, /Do not request the same permission again/);
});

test('permissionKey identifies a call, and ignores key order', () => {
  const a = permissionKey('Write', { file_path: '/tmp/x', content: 'hi' });
  const b = permissionKey('Write', { content: 'hi', file_path: '/tmp/x' });
  assert.equal(a, b, 'the same call with keys in another order must reuse the same denial record');

  assert.notEqual(a, permissionKey('Write', { file_path: '/tmp/y', content: 'hi' }));
  assert.notEqual(a, permissionKey('Edit', { file_path: '/tmp/x', content: 'hi' }));
});

test('permissionKey is stable for nested inputs', () => {
  assert.equal(
    permissionKey('Bash', { command: 'ls', opts: { b: [1, 2], a: null } }),
    permissionKey('Bash', { opts: { a: null, b: [1, 2] }, command: 'ls' })
  );
});
