/**
 * Shared plumbing for the smoke scripts that drive multi-turn tasks
 * (`smoke-overlap`, `smoke-permission`).
 *
 * Deliberately not retro-fitted onto `smoke-v1` / `smoke-cancel` /
 * `smoke-input-required`: those already carry their own copies and rewriting
 * them is churn unrelated to the bugs under test.
 */

import { randomUUID } from 'node:crypto';
import { TaskState } from '@a2a-js/sdk';
import { Role } from '@a2a-js/sdk';

export const BASE_URL = process.env.A2A_URL || 'http://localhost:3008';

/** Builds an A2A v1.0 user message, optionally with a structured `data` part. */
export function buildUserMessage(text, { taskId = '', contextId = '', data } = {}) {
  const parts = [
    {
      content: { $case: 'text', value: text },
      metadata: undefined,
      filename: '',
      mediaType: 'text/plain',
    },
  ];

  if (data !== undefined) {
    parts.push({
      content: { $case: 'data', value: data },
      metadata: undefined,
      filename: '',
      mediaType: 'application/json',
    });
  }

  return {
    messageId: randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_USER,
    parts,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

/**
 * Sends one message and drains the whole stream (which the server ends on a
 * terminal state and on `input-required` alike).
 *
 * Returns everything the assertions need: the states seen, the `metadata.kind`
 * of every status message, the `task` events, the artifacts, and the last
 * `input-required` prompt with its data part.
 */
export async function sendTurn(client, label, text, { data, ...ids } = {}) {
  console.log(`\n[${label}] -> ${JSON.stringify(text)}${data ? ` + data ${JSON.stringify(data)}` : ''}`);

  // Every incoming line is prefixed with the turn label: overlapping turns
  // write to the same stdout, and untangling them afterwards is impossible.
  const log = (line) => console.log(`  [${label}] <- ${line}`);

  const result = {
    taskId: ids.taskId,
    contextId: ids.contextId,
    states: [],
    agentText: '',
    kinds: [],
    textByKind: {},
    taskEvents: [],
    artifacts: [],
    prompts: [],
  };

  for await (const event of client.sendMessageStream({
    tenant: '',
    message: buildUserMessage(text, { ...ids, data }),
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
      log(`task ${value.id} [state ${value.status?.state}]`);
      continue;
    }

    if (payload.$case === 'artifactUpdate') {
      result.artifacts.push(value.artifact?.artifactId);
      log(`artifactUpdate ${value.artifact?.artifactId}`);
      continue;
    }

    if (payload.$case !== 'statusUpdate') {
      log(`(unknown payload $case: ${payload.$case})`);
      continue;
    }

    const state = value.status?.state;
    result.states.push(state);

    const parts = value.status?.message?.parts ?? [];
    const texts = parts.filter((p) => p.content?.$case === 'text').map((p) => p.content.value);
    const datas = parts.filter((p) => p.content?.$case === 'data').map((p) => p.content.value);
    const kind = value.status?.message?.metadata?.kind;

    if (kind !== undefined) {
      result.kinds.push(kind);
      result.textByKind[kind] = (result.textByKind[kind] ?? '') + texts.join('\n');
    }

    const kindTag = kind ? ` {kind: ${kind}}` : '';
    log(`statusUpdate [${state}]${kindTag}${texts.length ? ' ' + texts.join(' | ') : ''}`);
    for (const t of texts) result.agentText += t + '\n';

    if (state === TaskState.TASK_STATE_INPUT_REQUIRED) {
      result.prompts.push({ text: texts.join('\n'), data: datas[0], kind });
      log(`input-required data part: ${JSON.stringify(datas[0])}`);
    }
  }

  return result;
}

/** Number of `input-required` prompts of a given `data.kind` seen on a turn. */
export function countPrompts(turn, kind) {
  return turn.prompts.filter((prompt) => prompt.data?.kind === kind).length;
}

/** Runs `main`, forcing exit (the HTTP/SDK plumbing keeps the loop alive). */
export function run(main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('\nFAIL: smoke test threw:', err);
      process.exit(1);
    });
}
