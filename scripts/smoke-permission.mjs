#!/usr/bin/env node
/**
 * A2A v1.0 permission-answer smoke test.
 *
 * Regression test for the permission prompt loop: a follow-up answering a
 * `permission_request` used to be read as "allow" only if the WHOLE text
 * matched /^(yes|y|oui|ok|allow)$/i, so anything else became a deny carrying
 * the user's words as the reason — which Claude read as feedback and answered
 * by asking for the very same permission again, forever.
 *
 * Three cases:
 *   (a) a structured `{ kind: 'permission_response', decision: 'deny' }` data
 *       part wins over a contradicting "yes" text, and Claude does NOT re-ask:
 *       at most ONE permission round-trip on the whole task;
 *   (b) the tolerant free text "oui, vas-y" allows, and the write goes through
 *       as an artifact;
 *   (c) the same-key repeat protection is covered by
 *       `scripts/permission-decision.test.mjs` (see the note at the end): it
 *       needs Claude to re-ask for a permission it was just told not to
 *       re-ask for, which is not reproducible on demand.
 *
 * The prompts write OUTSIDE the server's cwd on purpose: that is what
 * `permissionMode: "acceptEdits"` does not auto-allow, so it reaches
 * `canUseTool` and becomes an A2A `input-required`.
 *
 * Usage: A2A_URL=http://localhost:3018 SMOKE_DIR=/tmp/... npm run smoke:permission
 */

import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClientFactory } from '@a2a-js/sdk/client';
import { TaskState } from '@a2a-js/sdk';
import { BASE_URL, sendTurn, countPrompts, run } from './lib/turns.mjs';

/** Directory the prompts write into. Outside the server cwd, hence the prompt. */
const SMOKE_DIR = process.env.SMOKE_DIR || mkdtempSync(path.join(tmpdir(), 'claude-a2a-smoke-'));

const TERMINAL = [TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED];

function writePrompt(file, content) {
  return `Use the Write tool to create the file ${file} with exactly this content: ${content}. `
    + `Do not use Bash, do not read anything first, just call Write once. `
    + `Then reply in one short sentence saying whether the file was written.`;
}

/** (a) structured deny beats a contradicting "yes", and Claude must not re-ask. */
async function caseStructuredDeny(client) {
  const file = path.join(SMOKE_DIR, 'denied.txt');
  const problems = [];

  const first = await sendTurn(client, 'a 1/2', writePrompt(file, 'DENIED'));
  if (!first.states.includes(TaskState.TASK_STATE_INPUT_REQUIRED)) {
    return [`(a) turn 1 never reached INPUT_REQUIRED (6). States: [${first.states.join(', ')}]`];
  }
  if (countPrompts(first, 'permission_request') !== 1) {
    problems.push(`(a) turn 1 published ${countPrompts(first, 'permission_request')} permission_request prompt(s), expected 1`);
  }

  // Text says "yes", the data part says deny: the STRUCTURED answer must win.
  const second = await sendTurn(client, 'a 2/2', 'yes', {
    taskId: first.taskId,
    contextId: first.contextId,
    data: { kind: 'permission_response', decision: 'deny', reason: 'writing outside the repo is not allowed' },
  });

  const repeats = countPrompts(second, 'permission_request');
  if (repeats > 0) {
    problems.push(`(a) Claude asked for a permission ${repeats} more time(s) after the denial: the loop is back`);
  }
  if (!second.states.some((state) => TERMINAL.includes(state))) {
    problems.push(`(a) the task did not end (COMPLETED or FAILED). States: [${second.states.join(', ')}]`);
  }
  if (existsSync(file)) {
    problems.push(`(a) ${file} was written: the structured deny lost to the "yes" text`);
  }
  if (second.artifacts.includes('denied.txt')) {
    problems.push('(a) an artifact was published for a denied write');
  }

  console.log(`\n  (a) states: [${second.states.join(', ')}] | permission round-trips after the deny: ${repeats}`);
  return problems;
}

/** (b) tolerant free text: "oui, vas-y" allows, and the artifact shows up. */
async function caseFreeTextAllow(client) {
  const file = path.join(SMOKE_DIR, 'allowed.txt');
  const problems = [];

  const first = await sendTurn(client, 'b 1/2', writePrompt(file, 'ALLOWED'));
  if (!first.states.includes(TaskState.TASK_STATE_INPUT_REQUIRED)) {
    return [`(b) turn 1 never reached INPUT_REQUIRED (6). States: [${first.states.join(', ')}]`];
  }

  const second = await sendTurn(client, 'b 2/2', 'oui, vas-y', {
    taskId: first.taskId,
    contextId: first.contextId,
  });

  if (!second.states.includes(TaskState.TASK_STATE_COMPLETED)) {
    problems.push(`(b) the task did not COMPLETE (3). States: [${second.states.join(', ')}]`);
  }
  if (!second.artifacts.includes('allowed.txt')) {
    problems.push(`(b) no "allowed.txt" artifact was published. Artifacts: [${second.artifacts.join(', ')}]`);
  }
  if (!existsSync(file)) {
    problems.push(`(b) ${file} was not written: "oui, vas-y" was not read as an allow`);
  }

  console.log(`\n  (b) states: [${second.states.join(', ')}] | artifacts: [${second.artifacts.join(', ')}]`);
  return problems;
}

async function main() {
  console.log(`A2A v1.0 permission-answer smoke test against ${BASE_URL}`);
  console.log(`Writing into ${SMOKE_DIR} (outside the server cwd, so Write needs a permission).`);

  const client = await new ClientFactory().createFromUrl(BASE_URL);

  const problems = [
    ...await caseStructuredDeny(client),
    ...await caseFreeTextAllow(client),
  ];

  if (!process.env.SMOKE_DIR) rmSync(SMOKE_DIR, { recursive: true, force: true });

  if (problems.length === 0) {
    console.log('\nPASS: structured deny wins and stops the loop, "oui, vas-y" allows and produces the artifact.');
    console.log('NOTE: the same-key repeat protection is unit-tested in scripts/permission-decision.test.mjs');
    console.log('      (forcing Claude to re-ask for a permission it was just refused is not reproducible on demand).');
    return 0;
  }

  console.error('\nFAIL:');
  for (const problem of problems) console.error(`  - ${problem}`);
  return 1;
}

run(main);
