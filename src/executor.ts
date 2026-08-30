import {
    query,
    type Options,
    type Query,
    type SDKMessage,
    type SDKUserMessage,
    type PostToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { AgentExecutor, RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import { TaskNotCancelableError } from "@a2a-js/sdk/errors";
import path from 'path';
import A2AResponse from './A2AResponse';
import SessionStore from './sessionStore';
import { TaskRegistry, type TaskEntry } from './taskRegistry';
import { a2aLog, claudeLog } from './logger';
import type { ClaudeConfig } from './types';

/** How long `cancelTask` waits for `query.interrupt()` before aborting anyway. */
const INTERRUPT_TIMEOUT_MS = 1500;


class ClaudeCodeExecutor implements AgentExecutor {

    /** Claude Agent SDK settings, from `.claude/claude-a2a.config.json`. */
    private readonly claudeConfig: ClaudeConfig;
    /** Working directory handed to Claude (and holding the sessions file). */
    private readonly cwd: string;

    /** Maps an A2A contextId to a Claude session id, persisted across restarts. */
    private readonly sessions: SessionStore;

    /** A2A tasks currently running a Claude query, keyed by taskId. */
    private readonly running = new TaskRegistry();

    constructor(claudeConfig: ClaudeConfig = {}) {
        this.claudeConfig = claudeConfig;
        this.cwd = claudeConfig.cwd ?? process.cwd();
        this.sessions = new SessionStore(this.cwd);
    }

    async execute(
        requestContext: RequestContext,
        eventBus: ExecutionEventBus
    ): Promise<void> {
        const { taskId, contextId, userMessage } = requestContext;
        // A2A v1.0: parts carry a `content` oneof discriminated by `$case`.
        const firstTextPart = userMessage.parts?.find((part) => part.content?.$case === 'text');
        const userText = firstTextPart?.content?.$case === 'text' ? firstTextPart.content.value : "";

        a2aLog('in', `Request received (taskId: ${taskId}, contextId: ${contextId})`, {userText});

        const a2aResponse = new A2AResponse(requestContext, eventBus);

        // Publish initial 'submitted' state
        a2aResponse.publishTaskSubmitted();

        // Publish 'working' state
        a2aResponse.publishStatusUpdateWorking();

        // Use the existing Claude Session Id if already known
        // (passing undefined the first message will create a new claude code session)
        const claudeSessionId = this.sessions.get(contextId);

        const entry = this.running.add({
            taskId,
            contextId,
            abortController: new AbortController(),
            a2aResponse,
            canceled: false,
        });

        try {
            const newClaudeSessionId = await this.startClaudeExecution(userText, entry, claudeSessionId);

            // Save claudeSessionId (mapped by A2A contextId) to re-use in future query calls
            if (newClaudeSessionId) {
                this.sessions.set(contextId, newClaudeSessionId);
            }
        } finally {
            this.running.remove(taskId);
        }
    }

    /**
     * Builds the `query()` options from the config file, with the defaults that
     * make the SDK behave like the `claude` CLI.
     */
    private buildQueryOptions(entry: TaskEntry, claudeSessionId: string | undefined): Options {
        return {
            resume: claudeSessionId,
            abortController: entry.abortController,
            cwd: this.cwd,
            permissionMode: this.claudeConfig.permissionMode ?? 'acceptEdits',
            // The Agent SDK loads NO settings source by default: no CLAUDE.md, no
            // settings.json, no project slash commands. Defaulting to the three
            // CLI layers restores the behaviour users expect from `claude`.
            settingSources: this.claudeConfig.settingSources ?? ['user', 'project', 'local'],
            model: this.claudeConfig.model,
            allowedTools: this.claudeConfig.allowedTools,
            maxTurns: this.claudeConfig.maxTurns,
            hooks: {
                PostToolUse: [{
                    hooks: [async (input, _toolUseID, _options) => {
                        const typedInput = input as PostToolUseHookInput;

                        claudeLog('debug', `PostToolUse hook: ${typedInput.tool_name}`);

                        // publish Write as a2a artifacts
                        if (typedInput.tool_name === 'Write' && !entry.canceled) {
                            const writeToolResponse = typedInput.tool_response as {filePath: string, content: string};
                            const filePath = writeToolResponse.filePath;
                            const filename = path.basename(filePath);
                            const content = writeToolResponse.content;
                            entry.a2aResponse.publishTextArtifactUpdate(filename, content);
                        }

                        return { continue: true };
                    }]
                }]
            }
        };
    }

    private async startClaudeExecution(userText: string, entry: TaskEntry, claudeSessionId: string | undefined): Promise<string | null> {

        claudeLog('debug', `Starting claude execution`, {
          claudeSessionId,
        });

        // Deferred resolved once the Claude `result` message has been received.
        let resolveDone: () => void;
        const done = new Promise<void>((resolve) => { resolveDone = resolve; });

        // IMPORTANT: an AsyncIterable prompt (streaming input mode) is required for
        // the hooks / interrupt features to be available. The generator must stay
        // open until Claude is done: closing it early prevents hooks from running.
        // It is released by `done` as soon as the result message arrives, so the
        // generator terminates cleanly and nothing leaks per task.
        const promptIteratorInstance = (async function* (): AsyncIterable<SDKUserMessage> {
            yield {
                type: 'user',
                message: {
                    role: 'user',
                    content: userText
                },
                parent_tool_use_id: null,
                session_id: claudeSessionId,
            };

            await done;
        })();


        const messages: Query = query({
            prompt: promptIteratorInstance,
            options: this.buildQueryOptions(entry, claudeSessionId),
        });
        // Registered immediately so `cancelTask` can interrupt from the very
        // first message onwards.
        entry.query = messages;

        const a2aResponse = entry.a2aResponse;
        let newClaudeSessionId: string | null = null;
        let failure: string | undefined;

        try {
            for await (const message of messages) {
                if (entry.canceled) {
                    break;
                }

                // Save claudeSessionId (mapped by A2A contextId) to re-use in future query calls
                if ('session_id' in message && message.session_id) {
                    newClaudeSessionId = message.session_id;
                }

                this.logClaudeMessage(message);

                if (message.type === 'assistant') {
                  // message.content is an array of content blocks
                  for (const block of message.message.content) {
                    if (block.type === 'tool_use') {
                        const toolName = block.name;

                        a2aResponse.publishStatusUpdateWorking(
                          a2aResponse.buildTextMessage(`Calling tool ${toolName}`)
                        );
                    }
                  }
                }

                if (message.type === 'result') {
                    if (message.subtype !== 'success' || message.is_error) {
                        failure = `Claude ended with subtype "${message.subtype}"`
                            + (('result' in message && message.result) ? `: ${message.result}` : '');
                    } else {
                      const claudeTextResponse = message.result;

                      // Sends claude response as working text message
                      a2aResponse.publishStatusUpdateWorking(
                        a2aResponse.buildTextMessage(claudeTextResponse)
                      );
                    }

                    // Release the prompt generator, then break the event loop
                    // (since it is the last claude message)
                    resolveDone!();
                    break;
                }
            }
        } catch (error) {
            // An abort raised by `cancelTask` is expected: CANCELED has already
            // been published, so it must not be reported as a failure.
            if (!entry.canceled) {
                failure = `Claude query failed: ${error instanceof Error ? error.message : String(error)}`;
                claudeLog('error', failure);
            }
        } finally {
            // Make sure the generator is always released (errors, early exits…)
            resolveDone!();
        }

        // A canceled task already got its final CANCELED status from cancelTask;
        // publishing anything else here would violate the task lifecycle.
        if (entry.canceled) {
            a2aLog('out', `Task ${entry.taskId} was canceled: no final status published here`);
            return newClaudeSessionId;
        }

        if (failure) {
            a2aResponse.publishStatusUpdateFailed(failure);
        } else {
            a2aResponse.publishStatusUpdateCompleted();
        }

        // The request handler's `_settleBus` closes the bus once `execute()`
        // resolves on a terminal state, but the pre-existing behaviour of this
        // executor was to close it itself; `finished()` is idempotent.
        a2aResponse.finished();

        return newClaudeSessionId;
  }


  private logClaudeMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'user':
        claudeLog('in', '👤 User Message', message.message);
        break;

      case 'assistant':
        claudeLog('in', `🤖 Assistant Message (Model: ${message.message.model})`, message.message.content);
        break;

      case 'result':
        claudeLog('in', `📊 Result Message (subtype ${message.subtype}, turns ${message.num_turns}, cost $${message.total_cost_usd.toFixed(6)})`, {
          result: ('result' in message) ? message.result : undefined
        });
        break;

      case 'system':
        claudeLog('in', `⚙️ System Message (subtype ${message.subtype})`, {
          model: (message.subtype === 'init') ? message.model : undefined,
          cwd: (message.subtype === 'init') ? message.cwd : undefined,
          tools: (message.subtype === 'init') ? message.tools.join(', ') : undefined,
        });
        break;

      case 'stream_event':
        // Stream events can be verbose, so we'll just count them
        process.stdout.write('.');
        break;

      default:
        console.log('\n📨 Other Message Type:', (message as any).type);
    }
  }

  /**
   * Interrupts the Claude query behind an A2A task.
   *
   * Contract, read from `DefaultRequestHandler.cancelTask`
   * (node_modules/@a2a-js/sdk/dist/server/index.js):
   *   1. it loads the task, rejects terminal ones with TaskNotCancelableError;
   *   2. if an event bus exists for the task it opens a queue on it, awaits
   *      `agentExecutor.cancelTask(taskId, eventBus)`, then drains that queue
   *      until a terminal (or INPUT_REQUIRED) event — so the executor is the
   *      one that must publish the CANCELED status update;
   *   3. it then reloads the task and throws TaskNotCancelableError unless the
   *      stored state is CANCELED.
   * Nobody calls `eventBus.finished()` on this path: the bus is settled by
   * `_settleBus` in the `.finally()` of the original `execute()` call, which
   * sees CANCELED (terminal) as the last published state and closes the bus.
   */
  cancelTask = async (taskId: string, _eventBus: ExecutionEventBus): Promise<void> => {
    const entry = this.running.get(taskId);
    if (!entry) {
      throw new TaskNotCancelableError({
        message: `Task not cancelable: ${taskId} is not running on this server.`,
      });
    }

    a2aLog('in', `Cancel requested (taskId: ${taskId})`);

    // Set first: the query loop checks this flag before publishing anything.
    entry.canceled = true;

    // Best effort — a wedged CLI must not make the cancel RPC hang. The abort
    // below is the one that always stops the query.
    if (entry.query) {
      try {
        await Promise.race([
          entry.query.interrupt(),
          new Promise((resolve) => setTimeout(resolve, INTERRUPT_TIMEOUT_MS)),
        ]);
      } catch (error) {
        claudeLog('error', 'query.interrupt() failed (ignored)', error);
      }
    }

    entry.abortController.abort();

    // `_eventBus` is the very bus this A2AResponse writes to (the handler got
    // it from `eventBusManager.getByTaskId(taskId)`), so publishing here is
    // what the handler's drain loop is waiting for.
    entry.a2aResponse.publishStatusUpdateCanceled();

    this.running.remove(taskId);
  };
}

export default ClaudeCodeExecutor;
