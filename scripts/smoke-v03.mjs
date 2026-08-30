#!/usr/bin/env node
/**
 * A2A v0.3 smoke test.
 *
 * Sends two `message/stream` JSON-RPC calls to the local claude-a2a server and
 * checks that the Claude session is really reused across the two calls (the
 * second answer must contain the code word given in the first one).
 *
 * Usage: npm run smoke:v03   (server must already be running on port 3008)
 */

import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.A2A_URL || 'http://localhost:3008/';

/**
 * POST an A2A v0.3 `message/stream` request and parse the SSE response.
 *
 * @param {string} text      the user text to send
 * @param {string} [contextId] optional A2A contextId to continue a conversation
 * @returns {Promise<{contextId: string|undefined, agentText: string, events: any[]}>}
 */
async function sendMessageStream(text, contextId) {
  const message = {
    kind: 'message',
    role: 'user',
    messageId: randomUUID(),
    parts: [{ kind: 'text', text }],
  };
  if (contextId) {
    message.contextId = contextId;
  }

  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'message/stream',
    params: { message },
  };

  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${await res.text()}`);
  }

  const events = [];
  let agentText = '';
  let seenContextId = contextId;

  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);

      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (!payload) continue;

      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch (err) {
        console.error(`  [warn] could not parse SSE data line: ${payload}`);
        continue;
      }

      const result = parsed.result ?? parsed;
      events.push(result);

      if (!seenContextId && result.contextId) {
        seenContextId = result.contextId;
      }

      if (result.kind === 'task') {
        console.log(`  <- task ${result.id} (contextId: ${result.contextId})`);
      }

      if (result.kind === 'status-update') {
        const parts = result.status?.message?.parts ?? [];
        for (const part of parts) {
          if (part.kind === 'text' && typeof part.text === 'string') {
            console.log(`  <- status-update [${result.status?.state}] ${part.text}`);
            agentText += part.text + '\n';
          }
        }
        if (parts.length === 0) {
          console.log(`  <- status-update [${result.status?.state}]${result.final ? ' (final)' : ''}`);
        }
      }

      if (result.kind === 'artifact-update') {
        console.log(`  <- artifact-update ${result.artifact?.artifactId}`);
      }
    }
  }

  return { contextId: seenContextId, agentText, events };
}

async function main() {
  const CODE_WORD = 'ZEBRA-42';

  console.log(`A2A v0.3 smoke test against ${BASE_URL}`);

  console.log('\n[1/2] Sending the code word...');
  const first = await sendMessageStream(
    `Remember the code word ${CODE_WORD}. Reply with exactly: ok`
  );

  if (!first.contextId) {
    console.error('FAIL: no contextId found in the first response events.');
    return 1;
  }
  console.log(`  contextId = ${first.contextId}`);

  console.log('\n[2/2] Asking the code word back on the same contextId...');
  const second = await sendMessageStream(
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
