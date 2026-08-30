#!/usr/bin/env node
/**
 * A2A v1.0 overlapping-follow-up smoke test.
 *
 * Regression test for "Stream ordering violation: received task in task
 * lifecycle stream", seen in production when two follow-up turns for the same
 * task arrived ~3 s apart.
 *
 * All turns of a task share one event bus, so a follow-up sent while the
 * previous turn is still WORKING would publish its head `task` snapshot into
 * the previous turn's still-open queue, and `_advanceStreamPattern` throws.
 * The server must instead refuse the *new* request outright, without touching
 * the shared bus.
 *
 * Scenario:
 *   1. turn 1 makes Claude call `AskUserQuestion` -> input-required;
 *   2. turn 2 answers it and is left RUNNING (not awaited);
 *   3. turn 3 fires on the same taskId while turn 2 is still working;
 *   4. turn 3 must fail with a clean error mentioning "still working";
 *   5. turn 2 must complete normally, and `getTask` must report COMPLETED.
 *
 * Usage: A2A_URL=http://localhost:3018 npm run smoke:overlap
 */

import { ClientFactory } from '@a2a-js/sdk/client';
import { TaskState } from '@a2a-js/sdk';
import { BASE_URL, sendTurn, run } from './lib/turns.mjs';

// The answer turn has to stay WORKING long enough for turn 3 to land on it,
// so the resumed work is deliberately verbose. A one-line answer comes back in
// under a second and the overlap never happens.
const TURN_1 =
  'Before answering, you MUST call the AskUserQuestion tool once to ask me which colour I prefer, '
  + 'with exactly two options: red and blue. After I answer, write a 400-word essay about that '
  + 'colour, and only then end your reply with exactly: You chose <colour>.';
const TURN_2 = 'blue';
const TURN_3 = 'actually, make it green';

/** Time given to the answer turn to be genuinely running before turn 3 fires. */
const OVERLAP_DELAY_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log(`A2A v1.0 overlapping-follow-up smoke test against ${BASE_URL}`);

  const client = await new ClientFactory().createFromUrl(BASE_URL);

  const first = await sendTurn(client, '1/3', TURN_1);
  if (!first.states.includes(TaskState.TASK_STATE_INPUT_REQUIRED)) {
    console.error(`\nFAIL: turn 1 never reached INPUT_REQUIRED (6). States: [${first.states.join(', ')}]`);
    return 1;
  }

  const ids = { taskId: first.taskId, contextId: first.contextId };

  // Turn 2 is started and NOT awaited: it must still be running when turn 3
  // arrives, which is the whole point of the test.
  let answerTurnDone = false;
  const answerTurn = sendTurn(client, '2/3 (answer, running)', TURN_2, ids);
  // Swallow a late rejection here so an early failure cannot become an
  // unhandled rejection while we are busy with turn 3.
  answerTurn.then(() => { answerTurnDone = true; }, () => { answerTurnDone = true; });

  await sleep(OVERLAP_DELAY_MS);

  if (answerTurnDone) {
    console.error(`\nFAIL: the answer turn already finished after ${OVERLAP_DELAY_MS} ms, so nothing overlapped.`);
    console.error('       Give TURN_1 more work to do after the answer, or lower OVERLAP_DELAY_MS.');
    return 1;
  }

  console.log(`\n[3/3] -> ${JSON.stringify(TURN_3)} (overlapping, must be refused)`);
  let overlapError;
  try {
    await sendTurn(client, '3/3 (overlapping)', TURN_3, ids);
  } catch (error) {
    overlapError = error;
  }

  const second = await answerTurn;

  const problems = [];

  // --- the overlapping turn was refused, cleanly ---------------------------
  if (!overlapError) {
    problems.push('the overlapping follow-up was accepted; it must be refused while the task is working');
  } else {
    const message = overlapError instanceof Error ? overlapError.message : String(overlapError);
    console.log(`\n  overlapping turn rejected with: ${message}`);
    if (!/still working/i.test(message)) {
      problems.push(`the rejection message does not mention "still working": ${JSON.stringify(message)}`);
    }
    if (!message.includes(first.taskId)) {
      problems.push(`the rejection message does not name the task ${first.taskId}: ${JSON.stringify(message)}`);
    }
  }

  // --- the running turn was not disturbed ----------------------------------
  if (!second.states.includes(TaskState.TASK_STATE_COMPLETED)) {
    problems.push(`the answer turn did not COMPLETE (3). States: [${second.states.join(', ')}]`);
  }
  if (second.states.includes(TaskState.TASK_STATE_FAILED)) {
    problems.push('the answer turn saw a FAILED (4) status');
  }
  if (!second.agentText.toLowerCase().includes(TURN_2)) {
    problems.push(`the answer turn's text does not mention "${TURN_2}"`);
  }

  // --- and the stored task agrees ------------------------------------------
  const stored = await client.getTask({ tenant: '', id: first.taskId, historyLength: 0 });
  const storedState = stored?.status?.state;
  console.log(`\n  getTask(${first.taskId}) -> state ${storedState}`);
  if (storedState !== TaskState.TASK_STATE_COMPLETED) {
    problems.push(`getTask reports state ${storedState}, expected COMPLETED (${TaskState.TASK_STATE_COMPLETED})`);
  }

  if (problems.length === 0) {
    console.log('\nPASS: the overlapping follow-up was refused on its own request, the running turn completed untouched.');
    return 0;
  }

  console.error('\nFAIL:');
  for (const problem of problems) console.error(`  - ${problem}`);
  return 1;
}

run(main);
