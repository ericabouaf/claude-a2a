#!/usr/bin/env node
/**
 * A2A v1.0 cancellation smoke test.
 *
 * Starts a deliberately long task, cancels it as soon as the server reports
 * WORKING, and checks that:
 *   - a CANCELED (5) status update arrives,
 *   - no COMPLETED (3) status update arrives,
 *   - the `cancelTask` round-trip takes less than 5 s.
 *
 * Usage: npm run smoke:cancel   (server must already be running on port 3008)
 */

import { randomUUID } from 'node:crypto';
import { ClientFactory } from '@a2a-js/sdk/client';
import { Role, TaskState } from '@a2a-js/sdk';

const BASE_URL = process.env.A2A_URL || 'http://localhost:3008';

const LONG_PROMPT =
  'Write a very long, detailed 3000-word essay about the history of the A2A protocol. Do not stop early.';

/** Max acceptable duration of the cancelTask round-trip. */
const CANCEL_BUDGET_MS = 5000;

function buildUserMessage(text) {
  return {
    messageId: randomUUID(),
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: 'text', value: text },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

async function main() {
  console.log(`A2A v1.0 cancel smoke test against ${BASE_URL}`);

  const client = await new ClientFactory().createFromUrl(BASE_URL);

  const startedAt = Date.now();
  const states = [];
  let taskId;
  let cancelSent = false;
  let cancelStartedAt;
  let cancelRoundTripMs;
  let cancelError;

  console.log('\n[1/1] Starting a long task, then cancelling it as soon as it is WORKING...');

  const stream = client.sendMessageStream({
    tenant: '',
    message: buildUserMessage(LONG_PROMPT),
    configuration: undefined,
    metadata: undefined,
  });

  // Fires the cancel RPC without blocking the stream consumption.
  let cancelPromise = Promise.resolve();

  for await (const event of stream) {
    const payload = event.payload;
    if (!payload) continue;
    const value = payload.value;

    if (payload.$case === 'task') {
      taskId = value.id;
      console.log(`  <- task ${value.id} (contextId: ${value.contextId}) [+${Date.now() - startedAt}ms]`);
      if (value.status?.state !== undefined) states.push(value.status.state);
    }

    if (payload.$case === 'statusUpdate') {
      const state = value.status?.state;
      states.push(state);
      console.log(`  <- statusUpdate [${state}] [+${Date.now() - startedAt}ms]`);

      if (!cancelSent && state === TaskState.TASK_STATE_WORKING && taskId) {
        cancelSent = true;
        cancelStartedAt = Date.now();
        console.log(`  -> cancelTask(${taskId}) [+${cancelStartedAt - startedAt}ms]`);
        cancelPromise = client
          .cancelTask({ tenant: '', id: taskId, metadata: undefined })
          .then((task) => {
            cancelRoundTripMs = Date.now() - cancelStartedAt;
            console.log(
              `  <- cancelTask returned state ${task?.status?.state} in ${cancelRoundTripMs}ms`
            );
          })
          .catch((err) => {
            cancelRoundTripMs = Date.now() - cancelStartedAt;
            cancelError = err;
            console.error(`  <- cancelTask threw after ${cancelRoundTripMs}ms:`, err?.message ?? err);
          });
      }
    }

    if (payload.$case === 'artifactUpdate') {
      console.log(`  <- artifactUpdate ${value.artifact?.artifactId}`);
    }
  }

  await cancelPromise;

  const totalMs = Date.now() - startedAt;
  console.log(`\nStates seen: [${states.join(', ')}]`);
  console.log(`Total stream duration: ${totalMs}ms`);
  console.log(`Cancel round-trip: ${cancelRoundTripMs ?? 'n/a'}ms (budget ${CANCEL_BUDGET_MS}ms)`);

  const problems = [];
  if (!cancelSent) problems.push('never reached WORKING, so cancelTask was never sent');
  if (cancelError) problems.push(`cancelTask failed: ${cancelError?.message ?? cancelError}`);
  if (!states.includes(TaskState.TASK_STATE_CANCELED)) problems.push('no CANCELED (5) status received');
  if (states.includes(TaskState.TASK_STATE_COMPLETED)) problems.push('a COMPLETED (3) status was received');
  if (cancelRoundTripMs === undefined || cancelRoundTripMs >= CANCEL_BUDGET_MS) {
    problems.push(`cancel round-trip ${cancelRoundTripMs}ms >= ${CANCEL_BUDGET_MS}ms`);
  }

  if (problems.length === 0) {
    console.log('\nPASS: the running task was canceled promptly and never completed.');
    return 0;
  }

  console.error('\nFAIL:');
  for (const problem of problems) console.error(`  - ${problem}`);
  return 1;
}

main()
  .then((code) => {
    // Force exit: the HTTP/SDK plumbing may keep the event loop alive.
    process.exit(code);
  })
  .catch((err) => {
    console.error('\nFAIL: smoke test threw:', err);
    process.exit(1);
  });
