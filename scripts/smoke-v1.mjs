#!/usr/bin/env node
/**
 * A2A v1.0 smoke test.
 *
 * Same scenario as `smoke-v03.mjs` (two-turn session continuity), but driven
 * through the official v1.0 client (`ClientFactory` + `sendMessageStream`)
 * instead of hand-rolled JSON-RPC.
 *
 * Usage: npm run smoke:v1   (server must already be running on port 3008)
 */

import { randomUUID } from 'node:crypto';
import { ClientFactory } from '@a2a-js/sdk/client';
import { Role } from '@a2a-js/sdk';

const BASE_URL = process.env.A2A_URL || 'http://localhost:3008';

/**
 * Send one message and drain the v1.0 stream.
 *
 * @param {import('@a2a-js/sdk/client').Client} client
 * @param {string} text        the user text to send
 * @param {string} [contextId] optional A2A contextId to continue a conversation
 * @returns {Promise<{contextId: string|undefined, agentText: string}>}
 */
async function sendMessageStream(client, text, contextId) {
  const message = {
    messageId: randomUUID(),
    contextId: contextId ?? '',
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

  let agentText = '';
  let seenContextId = contextId;

  for await (const event of client.sendMessageStream({
    tenant: '',
    message,
    configuration: undefined,
    metadata: undefined,
  })) {
    const payload = event.payload;
    if (!payload) continue;

    const value = payload.value;
    if (!seenContextId && value?.contextId) {
      seenContextId = value.contextId;
    }

    switch (payload.$case) {
      case 'task':
        console.log(`  <- task ${value.id} (contextId: ${value.contextId})`);
        break;

      case 'statusUpdate': {
        const parts = value.status?.message?.parts ?? [];
        for (const part of parts) {
          if (part.content?.$case === 'text') {
            console.log(`  <- statusUpdate [${value.status?.state}] ${part.content.value}`);
            agentText += part.content.value + '\n';
          }
        }
        if (parts.length === 0) {
          console.log(`  <- statusUpdate [${value.status?.state}]`);
        }
        break;
      }

      case 'artifactUpdate':
        console.log(`  <- artifactUpdate ${value.artifact?.artifactId}`);
        break;

      case 'message': {
        for (const part of value.parts ?? []) {
          if (part.content?.$case === 'text') {
            console.log(`  <- message ${part.content.value}`);
            agentText += part.content.value + '\n';
          }
        }
        break;
      }

      default:
        console.log(`  <- (unknown payload $case: ${payload.$case})`);
    }
  }

  return { contextId: seenContextId, agentText };
}

async function main() {
  const CODE_WORD = 'ZEBRA-42';

  console.log(`A2A v1.0 smoke test against ${BASE_URL}`);

  const client = await new ClientFactory().createFromUrl(BASE_URL);

  console.log('\n[1/2] Sending the code word...');
  const first = await sendMessageStream(
    client,
    `Remember the code word ${CODE_WORD}. Reply with exactly: ok`
  );

  if (!first.contextId) {
    console.error('FAIL: no contextId found in the first response events.');
    return 1;
  }
  console.log(`  contextId = ${first.contextId}`);

  console.log('\n[2/2] Asking the code word back on the same contextId...');
  const second = await sendMessageStream(
    client,
    'What is the code word I gave you? Reply with just the word.',
    first.contextId
  );

  if (second.agentText.includes(CODE_WORD)) {
    console.log(`\nPASS: the second answer contains "${CODE_WORD}" — session continuity works.`);
    return 0;
  }

  console.error(`\nFAIL: the second answer does not contain "${CODE_WORD}".`);
  console.error('Collected agent text was:');
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
