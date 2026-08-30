#!/usr/bin/env node
/**
 * A2A v1.0 input-required smoke test.
 *
 * Turn 1 forces Claude to call `AskUserQuestion`; the server must bridge it to
 * an `input-required` (6) status carrying ONLY the question as text (the
 * options live in the `data` part alone). Turn 2 answers on the SAME
 * taskId/contextId and the task must resume and complete (3) with an answer
 * mentioning the chosen colour.
 *
 * It also asserts the `metadata.kind` contract on the status messages:
 * `tool_use` for tool activity, `result` for Claude's final answer, and the
 * resume snapshot republished as a `task` event still in INPUT_REQUIRED.
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
    promptKind: undefined,
    /** `metadata.kind` seen on each status message, in order. */
    kinds: [],
    /** Texts indexed by the `metadata.kind` of their status message. */
    textByKind: {},
    /** The `task` events seen on this turn: `{ id, state }`. */
    taskEvents: [],
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
      result.taskEvents.push({ id: value.id, state: value.status?.state });
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
    const kind = value.status?.message?.metadata?.kind;

    if (kind !== undefined) result.kinds.push(kind);
    if (kind !== undefined) {
      result.textByKind[kind] = (result.textByKind[kind] ?? '') + texts.join('\n');
    }

    const kindTag = kind ? ` {kind: ${kind}}` : '';
    console.log(`  <- statusUpdate [${state}]${kindTag}${texts.length ? ' ' + texts.join(' | ') : ''}`);
    for (const t of texts) result.agentText += t + '\n';

    if (state === TaskState.TASK_STATE_INPUT_REQUIRED) {
      result.promptText = texts.join('\n');
      result.promptData = datas[0];
      result.promptKind = kind;
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

  const problems1 = [];

  // --- the input-required contract ---------------------------------------
  if (first.promptData?.kind !== 'ask_user_question') {
    problems1.push(`input-required data part is not an ask_user_question: ${JSON.stringify(first.promptData)}`);
  }
  if (first.promptKind !== 'ask_user_question') {
    problems1.push(`input-required status message metadata.kind is ${JSON.stringify(first.promptKind)}, expected "ask_user_question"`);
  }

  const options = (first.promptData?.questions ?? []).flatMap((q) => q?.options ?? []);
  if (options.length !== 2) {
    problems1.push(`the data part carries ${options.length} option(s), expected 2`);
  }

  // The text part must be the bare question: no option label, no hint.
  const promptText = (first.promptText ?? '').toLowerCase();
  for (const option of options) {
    const label = String(option?.label ?? '');
    if (label && promptText.includes(label.toLowerCase())) {
      problems1.push(`the input-required text part repeats the option label "${label}"`);
    }
  }
  if (/reply on this task/i.test(first.promptText ?? '')) {
    problems1.push('the input-required text part still carries the "Reply on this task" hint');
  }

  // --- the metadata.kind contract on turn 1 -------------------------------
  if (!first.kinds.includes('tool_use')) {
    problems1.push(`no status message tagged metadata.kind === "tool_use". Kinds seen: [${first.kinds.join(', ')}]`);
  } else if (!/^Calling tool /.test(first.textByKind.tool_use ?? '')) {
    problems1.push(`the tool_use text is ${JSON.stringify(first.textByKind.tool_use)}, expected "Calling tool <name>"`);
  }

  if (problems1.length > 0) {
    console.error('\nFAIL (turn 1):');
    for (const problem of problems1) console.error(`  - ${problem}`);
    console.error(`Prompt text was: ${JSON.stringify(first.promptText)}`);
    return 1;
  }

  const second = await sendTurn(client, '2/2', TURN_2, {
    taskId: first.taskId,
    contextId: first.contextId,
  });

  const problems = [];

  // --- the resume snapshot ------------------------------------------------
  const snapshot = second.taskEvents[0];
  if (!snapshot) {
    problems.push('turn 2 published no `task` event');
  } else {
    if (snapshot.id !== first.taskId) {
      problems.push(`the resume snapshot has id ${snapshot.id}, expected ${first.taskId}`);
    }
    if (snapshot.state !== TaskState.TASK_STATE_INPUT_REQUIRED) {
      problems.push(`the resume snapshot is in state ${snapshot.state}, expected INPUT_REQUIRED (${TaskState.TASK_STATE_INPUT_REQUIRED})`);
    }
  }
  if (!second.kinds.includes('resumed')) {
    problems.push(`no status update tagged metadata.kind === "resumed". Kinds seen: [${second.kinds.join(', ')}]`);
  }

  // --- the turn outcome ---------------------------------------------------
  if (!second.states.includes(TaskState.TASK_STATE_COMPLETED)) {
    problems.push(`no COMPLETED (3) status on turn 2. States: [${second.states.join(', ')}]`);
  }
  if (second.states.includes(TaskState.TASK_STATE_FAILED)) {
    problems.push('a FAILED (4) status was received');
  }
  if (!second.agentText.toLowerCase().includes(TURN_2)) {
    problems.push(`the final agent text does not mention "${TURN_2}"`);
  }

  // --- the final answer is tagged `result` --------------------------------
  const finalText = second.textByKind.result;
  if (finalText === undefined) {
    problems.push(`no status message tagged metadata.kind === "result". Kinds seen: [${second.kinds.join(', ')}]`);
  } else if (!finalText.toLowerCase().includes(TURN_2)) {
    problems.push(`the "result" text does not mention "${TURN_2}": ${JSON.stringify(finalText)}`);
  }

  if (problems.length === 0) {
    console.log(`\nPASS: bare question + options in the data part, tool_use/result/resumed metadata, resume snapshot, completed.`);
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
