#!/usr/bin/env node
/**
 * A2A v1.0 input-required smoke test.
 *
 * Turn 1 forces Claude to call `AskUserQuestion`; the server must bridge it to
 * an `input-required` (6) status carrying the question as text and as a
 * `data` part. Turn 2 answers on the SAME taskId/contextId and the task must
 * resume and complete (3) with an answer mentioning the chosen colour.
 *
 * Usage: npm run smoke:input   (server must already be running on port 3008)
 */

import { randomUUID } from 'node:crypto';
import { ClientFactory } from '@a2a-js/sdk/client';
import { Role, TaskState } from '@a2a-js/sdk';

const BASE_URL = process.env.A2A_URL || 'http://localhost:3008';

const TURN_1 =
  'Before answering, you MUST call the AskUserQuestion tool once to ask me which colour I prefer, '
  + 'with exactly two options: red and blue. After I answer, reply with exactly: You chose <colour>.';
const TURN_2 = 'blue';

function buildUserMessage(text, { taskId = '', contextId = '' } = {}) {
  return {
    messageId: randomUUID(),
    contextId,
    taskId,
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

/**
 * Sends one message and drains the stream until it ends (the server stream
 * terminates on a terminal state and on input-required alike).
 */
async function sendTurn(client, label, text, ids = {}) {
  console.log(`\n[${label}] -> ${JSON.stringify(text)}`);

  const result = {
    taskId: ids.taskId,
    contextId: ids.contextId,
    states: [],
    agentText: '',
    promptText: undefined,
    promptData: undefined,
  };

  for await (const event of client.sendMessageStream({
    tenant: '',
    message: buildUserMessage(text, ids),
    configuration: undefined,
    metadata: undefined,
  })) {
    const payload = event.payload;
    if (!payload) continue;
    const value = payload.value;

    if (payload.$case === 'task') {
      result.taskId = value.id;
      result.contextId = value.contextId;
      if (value.status?.state !== undefined) result.states.push(value.status.state);
      console.log(`  <- task ${value.id} [state ${value.status?.state}]`);
      continue;
    }

    if (payload.$case === 'artifactUpdate') {
      console.log(`  <- artifactUpdate ${value.artifact?.artifactId}`);
      continue;
    }

    if (payload.$case !== 'statusUpdate') {
      console.log(`  <- (unknown payload $case: ${payload.$case})`);
      continue;
    }

    const state = value.status?.state;
    result.states.push(state);

    const parts = value.status?.message?.parts ?? [];
    const texts = parts.filter((p) => p.content?.$case === 'text').map((p) => p.content.value);
    const datas = parts.filter((p) => p.content?.$case === 'data').map((p) => p.content.value);

    console.log(`  <- statusUpdate [${state}]${texts.length ? ' ' + texts.join(' | ') : ''}`);
    for (const t of texts) result.agentText += t + '\n';

    if (state === TaskState.TASK_STATE_INPUT_REQUIRED) {
      result.promptText = texts.join('\n');
      result.promptData = datas[0];
      console.log('  <- input-required data part:');
      console.log(JSON.stringify(datas[0], null, 2));
    }
  }

  return result;
}

async function main() {
  console.log(`A2A v1.0 input-required smoke test against ${BASE_URL}`);

  const client = await new ClientFactory().createFromUrl(BASE_URL);

  const first = await sendTurn(client, '1/2', TURN_1);

  if (!first.states.includes(TaskState.TASK_STATE_INPUT_REQUIRED)) {
    console.error(`\nFAIL: no INPUT_REQUIRED (6) status. States seen: [${first.states.join(', ')}]`);
    console.error('Agent text was:');
    console.error(first.agentText.trim() || '(empty)');
    return 1;
  }
  if (first.promptData?.kind !== 'ask_user_question') {
    console.error(`\nFAIL: input-required data part is not an ask_user_question: ${JSON.stringify(first.promptData)}`);
    return 1;
  }

  const second = await sendTurn(client, '2/2', TURN_2, {
    taskId: first.taskId,
    contextId: first.contextId,
  });

  const problems = [];
  if (!second.states.includes(TaskState.TASK_STATE_COMPLETED)) {
    problems.push(`no COMPLETED (3) status on turn 2. States: [${second.states.join(', ')}]`);
  }
  if (second.states.includes(TaskState.TASK_STATE_FAILED)) {
    problems.push('a FAILED (4) status was received');
  }
  if (!second.agentText.toLowerCase().includes(TURN_2)) {
    problems.push(`the final agent text does not mention "${TURN_2}"`);
  }

  if (problems.length === 0) {
    console.log(`\nPASS: the task parked on AskUserQuestion, resumed on the answer, and completed.`);
    return 0;
  }

  console.error('\nFAIL:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('Turn 2 agent text was:');
  console.error(second.agentText.trim() || '(empty)');
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
