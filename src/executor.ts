import {
    query,
    type Options,
    type PermissionResult,
    type Query,
    type SDKMessage,
    type SDKUserMessage,
    type PostToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { Message, TaskState } from "@a2a-js/sdk";
import { AgentExecutor, RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import { TaskNotCancelableError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
import path from 'path';
import A2AResponse from './A2AResponse';
import SessionStore from './sessionStore';
import { TaskRegistry, createDeferred, type PendingPrompt, type TaskEntry } from './taskRegistry';
import { a2aLog, claudeLog } from './logger';
import { readCaller } from './caller';
import {
    denialMessage,
    permissionKey,
    readPermissionAnswer,
    stoppingDenialMessage,
} from './permissionAnswer';
import type { ClaudeConfig } from './types';

/** How long `cancelTask` waits for `query.interrupt()` before aborting anyway. */
const INTERRUPT_TIMEOUT_MS = 1500;

/** Denials a single task may collect before it is stopped. @see ClaudeConfig.maxPermissionDenials */
const DEFAULT_MAX_PERMISSION_DENIALS = 3;

/** Shape of the `AskUserQuestion` tool input we render and answer. */
interface AskUserQuestion {
    question: string;
    header?: string;
    options?: { label: string; description?: string }[];
    multiSelect?: boolean;
}

/**
 * Executes A2A tasks by running a Claude Agent SDK query per task.
 *
 * ## Interactive tasks
 *
 * A `canUseTool` callback turns anything Claude needs a human for —
 * `AskUserQuestion`, or a tool permission the `permissionMode` did not
 * auto-allow — into an A2A `input-required` status, and parks the query on the
 * unresolved `canUseTool` promise. `execute()` then RETURNS while the query
 * stays alive in the background.
 *
 * That works because of two things in
 * `node_modules/@a2a-js/sdk/dist/server/index.js`:
 *
 * - `_runStreamExecutor` settles the bus in a `.finally()` on the `execute()`
 *   promise, via `_settleBus(taskId, bus, lastPublishedState)`. `_settleBus`
 *   returns *without* calling `eventBus.finished()` (and without
 *   `cleanupByTaskId`) when the last published state is in
 *   `keepBusAliveStates` — which defaults to `[INPUT_REQUIRED, AUTH_REQUIRED]`.
 *   So the bus survives `execute()` resolving on an INPUT_REQUIRED status.
 *   Hence: publish INPUT_REQUIRED *before* releasing the turn.
 * - The follow-up turn carries the same `taskId`, so
 *   `DefaultExecutionEventBusManager.createOrGetByTaskId(taskId)` hands the
 *   handler that very same bus instance, and the still-running query loop keeps
 *   publishing onto the stream the new turn is reading.
 *
 * The per-turn SSE stream still ends at INPUT_REQUIRED: `ExecutionEventQueue`
 * stops on terminal states *and* on INPUT_REQUIRED. The bus outliving the queue
 * is exactly what makes the next turn possible.
 */
class ClaudeCodeExecutor implements AgentExecutor {

    /** Claude Agent SDK settings, from `.claude/claude-a2a.config.json`. */
    private readonly claudeConfig: ClaudeConfig;
    /** Working directory handed to Claude (and holding the sessions file). */
    private readonly cwd: string;

    /** Maps an A2A contextId to a Claude session id, persisted across restarts. */
    private readonly sessions: SessionStore;

    /** A2A tasks currently backed by a live Claude query, keyed by taskId. */
    private readonly running = new TaskRegistry();

    constructor(claudeConfig: ClaudeConfig = {}) {
        this.claudeConfig = claudeConfig;
        this.cwd = claudeConfig.cwd ?? process.cwd();
        this.sessions = new SessionStore(this.cwd);
    }

    /**
     * Rejects a follow-up turn aimed at a task that is still WORKING.
     *
     * Called by `GuardedRequestHandler` BEFORE the SDK opens an event bus or
     * runs the executor, because there is no safe way to refuse from inside
     * `execute()` — see the long comment on that class.
     *
     * @throws UnsupportedOperationError when the task is busy.
     */
    public assertAcceptsFollowUp(taskId: string | undefined): void {
        if (!taskId || !this.running.isBusy(taskId)) return;

        a2aLog('error', `Rejected a follow-up on task ${taskId}: still working`);
        throw new UnsupportedOperationError({
            message: `Task ${taskId} is still working; wait for input-required or send a new message without taskId.`,
        });
    }

    async execute(
        requestContext: RequestContext,
        eventBus: ExecutionEventBus
    ): Promise<void> {
        const { taskId, contextId, userMessage, task: storedTask } = requestContext;
        const { text: userText, data: userData } = readMessageParts(userMessage);

        const caller = readCaller(requestContext.context);
        a2aLog('in', `Request received (taskId: ${taskId}, contextId: ${contextId})`, {
            caller: caller.login ?? 'anonymous',
            userText,
        });

        // A follow-up turn answering a parked question / permission prompt.
        if (storedTask?.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED) {
            return this.answerParkedTask(requestContext, eventBus, userText, userData);
        }

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
            deniedPrompts: new Map(),
            turn: createDeferred(),
        });

        // Detached on purpose: the query outlives this turn whenever it parks on
        // a question. `runClaudeQuery` never rejects and always releases the turn.
        void this.runClaudeQuery(userText, entry, claudeSessionId);

        // The A2A turn stays open exactly as long as the agent is busy: until the
        // query reaches a terminal state, or parks waiting for the client.
        await entry.turn.promise;
    }

    /**
     * Second (or later) turn on a task parked in `input-required`: hands the
     * user's answer to the waiting `canUseTool` promise and waits for the query
     * to either finish or park again.
     */
    private async answerParkedTask(
        requestContext: RequestContext,
        eventBus: ExecutionEventBus,
        userText: string,
        userData: Record<string, unknown> | undefined
    ): Promise<void> {
        const { taskId } = requestContext;
        const a2aResponse = new A2AResponse(requestContext, eventBus);

        // A2A requires a `task` (or `message`) as the first event of a stream.
        // We publish the STORED task verbatim (same id, still INPUT_REQUIRED,
        // its artifacts and history) rather than a fabricated `working` task,
        // so the client can recognise a resume from the `task` event alone;
        // the `working` transition is the `resumed` status update right after.
        // See `A2AResponse.publishTaskSnapshot` for why an INPUT_REQUIRED
        // `task` event does not terminate this turn's stream.
        a2aResponse.publishTaskSnapshot(requestContext.task);
        a2aResponse.publishStatusUpdateResumed();

        const entry = this.running.get(taskId);
        const pending = entry?.pendingPrompt;

        if (!entry || !pending) {
            // The stored task says "waiting for input" but no query is parked:
            // the server was restarted, or the task was canceled meanwhile.
            // Fail explicitly rather than hang the client forever.
            a2aResponse.publishStatusUpdateFailed(
                `Task ${taskId} is waiting for input, but the agent run behind it is gone `
                + `(the server restarted, or the task was canceled). Please start a new task.`
            );
            a2aResponse.finished();
            return;
        }

        // Rebind to this turn's bus. In practice it is the very same instance
        // (`createOrGetByTaskId`), but the running query must always publish
        // onto the bus the current turn is draining.
        entry.a2aResponse = a2aResponse;
        entry.pendingPrompt = undefined;
        // Re-arm the barrier BEFORE unblocking the query, otherwise the query
        // could finish and release the previous (already settled) deferred.
        entry.turn = createDeferred();

        const result = this.buildPermissionResult(entry, pending, userText, userData);
        claudeLog('debug', `Answering parked ${pending.kind} for ${pending.toolName}`, result);
        pending.resolve(result);

        await entry.turn.promise;
    }

    /** Denials allowed on one task before the run is stopped. */
    private get maxPermissionDenials(): number {
        return this.claudeConfig.maxPermissionDenials ?? DEFAULT_MAX_PERMISSION_DENIALS;
    }

    /**
     * Turns the client's reply into the `PermissionResult` the parked query
     * expects, and keeps the per-task denial record up to date.
     *
     * `AskUserQuestion` is unconditionally allowed (the answer IS the point).
     * A permission prompt goes through {@link readPermissionAnswer}: structured
     * first, tolerant free text second, anything unclear denied with a reason.
     *
     * Every denial is recorded under its {@link permissionKey} so a repeat of
     * the same request can be auto-denied in `handleToolPrompt` without ever
     * bothering the user again, and counted against
     * `claude.maxPermissionDenials` — the last allowed denial carries
     * `interrupt: true` and stops the run.
     */
    private buildPermissionResult(
        entry: TaskEntry,
        pending: PendingPrompt,
        userText: string,
        userData: Record<string, unknown> | undefined
    ): PermissionResult {
        if (pending.kind === 'ask_user_question') {
            return {
                behavior: 'allow',
                updatedInput: { ...pending.input, answers: buildAnswers(pending, userText, userData) },
            };
        }

        const answer = readPermissionAnswer(userText, userData);
        if (answer.decision === 'allow') {
            return { behavior: 'allow', updatedInput: pending.input };
        }

        const key = permissionKey(pending.toolName, pending.input);
        entry.deniedPrompts.set(key, (entry.deniedPrompts.get(key) ?? 0) + 1);

        const denials = countDenials(entry);
        if (denials >= this.maxPermissionDenials) {
            entry.stopReason = `Stopped: the permission denial limit `
                + `(claude.maxPermissionDenials = ${this.maxPermissionDenials}) was reached on this task.`;
            return {
                behavior: 'deny',
                message: stoppingDenialMessage(answer.reason, entry.stopReason),
                interrupt: true,
            };
        }

        return { behavior: 'deny', message: denialMessage(answer.reason) };
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
            canUseTool: (toolName, input, options) =>
                this.handleToolPrompt(entry, toolName, input, options.title, options.decisionReason),
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

    /**
     * `canUseTool`: everything Claude cannot decide on its own lands here.
     *
     * Publishes an `input-required` status carrying the bare prompt as text
     * and every detail (options, tool input, …) in a `data` part the client can
     * answer programmatically, then returns a promise that stays pending until
     * the A2A client replies (or the task is canceled). The status message is
     * tagged `metadata.kind` with the same value as the data part's `kind`.
     */
    private handleToolPrompt(
        entry: TaskEntry,
        toolName: string,
        input: Record<string, unknown>,
        title: string | undefined,
        decisionReason?: string
    ): Promise<PermissionResult> {
        if (entry.canceled) {
            return Promise.resolve({ behavior: 'deny', message: 'Task canceled', interrupt: true });
        }

        const isQuestion = toolName === 'AskUserQuestion';
        const policy = this.claudeConfig.permissionPrompts ?? 'input-required';

        // `AskUserQuestion` is always bridged: it asks the user something, it
        // does not grant a privilege. Only real permission prompts are gated.
        if (!isQuestion && policy === 'deny') {
            claudeLog('debug', `Denying permission prompt for ${toolName} (permissionPrompts: "deny")`);
            return Promise.resolve({
                behavior: 'deny',
                message: `This agent cannot ask for permissions (claude.permissionPrompts is "deny"), `
                    + `so ${toolName} was not allowed.`,
            });
        }

        // Loop breaker. The client already refused this exact call; asking it
        // again is the round-trip storm this whole mechanism exists to stop, so
        // the answer is decided here and the run is ended rather than parked.
        if (!isQuestion) {
            const key = permissionKey(toolName, input);
            if (entry.deniedPrompts.has(key)) {
                entry.stopReason =
                    `Stopped: Claude requested the same denied permission again (${toolName}).`;
                claudeLog('error', entry.stopReason);
                return Promise.resolve({
                    behavior: 'deny',
                    message: `${entry.stopReason} The user already refused this exact call; it will not be asked again.`,
                    interrupt: true,
                });
            }
        }

        const kind: PendingPrompt['kind'] = isQuestion ? 'ask_user_question' : 'permission_request';
        const { text, data } = isQuestion
            ? renderQuestionPrompt(input)
            : renderPermissionPrompt(toolName, input, title, decisionReason);

        claudeLog('debug', `Parking task ${entry.taskId} on a ${kind} (${toolName})`);

        return new Promise<PermissionResult>((resolve) => {
            entry.pendingPrompt = { kind, toolName, input, resolve };
            const a2aResponse = entry.a2aResponse;
            // Publish first, release the turn second: the request handler reads
            // the LAST state published on the bus when `execute()` resolves, and
            // it must read INPUT_REQUIRED to keep the bus alive.
            a2aResponse.publishStatusUpdateInputRequired(
                a2aResponse.buildPromptMessage(text, data, { kind })
            );
            entry.turn.resolve();
        });
    }

    /**
     * Runs one Claude query for a task, from the first prompt to the terminal
     * A2A status. Detached from `execute()`, so it never rejects: failures are
     * published as `TASK_STATE_FAILED`.
     */
    private async runClaudeQuery(userText: string, entry: TaskEntry, claudeSessionId: string | undefined): Promise<void> {

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

                        // `metadata.kind` lets a client tell tool activity
                        // apart from the answer; the text is unchanged for
                        // clients that only read text parts.
                        entry.a2aResponse.publishStatusUpdateWorking(
                          entry.a2aResponse.buildTextMessage(
                            `Calling tool ${toolName}`,
                            undefined,
                            { kind: 'tool_use', toolName }
                          )
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

                      // Sends claude response as working text message, tagged
                      // `kind: 'result'` so a client can render it as the
                      // agent's answer rather than as progress noise.
                      entry.a2aResponse.publishStatusUpdateWorking(
                        entry.a2aResponse.buildTextMessage(
                          claudeTextResponse,
                          undefined,
                          { kind: 'result' }
                        )
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

        try {
            // Save claudeSessionId (mapped by A2A contextId) to re-use in future query calls
            if (newClaudeSessionId) {
                this.sessions.set(entry.contextId, newClaudeSessionId);
            }

            // A canceled task already got its final CANCELED status from cancelTask;
            // publishing anything else here would violate the task lifecycle.
            if (entry.canceled) {
                a2aLog('out', `Task ${entry.taskId} was canceled: no final status published here`);
                return;
            }

            // Exactly ONE terminal status is published here, and `stopReason`
            // wins over whatever Claude reported.
            //
            // What `interrupt: true` on a deny actually does to the query
            // stream, observed against @anthropic-ai/claude-agent-sdk 0.3:
            // the CLI answers the tool call with its own canned rejection text
            // (`is_error: true`) INSTEAD of the `message` we passed, injects a
            // synthetic user message `[Request interrupted by user]`, then ends
            // the query with a `result` message of subtype
            // `error_during_execution` carrying no `result` text. (A plain deny
            // without `interrupt` is the opposite: our `message` is delivered
            // verbatim as the tool_result, which is what makes the "do not ask
            // again" instruction land.) So on the interrupt path the only
            // usable explanation is the one we kept ourselves.
            if (entry.stopReason) {
                a2aLog('out', `Task ${entry.taskId} stopped: ${entry.stopReason}`, { claudeReported: failure });
                entry.a2aResponse.publishStatusUpdateFailed(entry.stopReason);
            } else if (failure) {
                entry.a2aResponse.publishStatusUpdateFailed(failure);
            } else {
                entry.a2aResponse.publishStatusUpdateCompleted();
            }

            // The request handler's `_settleBus` closes the bus once `execute()`
            // resolves on a terminal state, but the pre-existing behaviour of this
            // executor was to close it itself; `finished()` is idempotent.
            entry.a2aResponse.finished();
        } finally {
            this.running.remove(entry.taskId);
            // Always last: the terminal status must be on the bus before the
            // turn is released, so `_settleBus` sees it.
            entry.turn.resolve();
        }
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

    // Released only now: waking a parked query earlier could let it publish
    // (or settle the turn, and thus the bus) before CANCELED is on the wire.
    const pending = entry.pendingPrompt;
    if (pending) {
      entry.pendingPrompt = undefined;
      pending.resolve({ behavior: 'deny', message: 'Task canceled', interrupt: true });
    }

    this.running.remove(taskId);
    // Unblocks a follow-up `execute()` that was awaiting this task's turn.
    entry.turn.resolve();
  };
}

/** Reads the first text part and the first structured `data` part of a message. */
function readMessageParts(message: Message): { text: string; data: Record<string, unknown> | undefined } {
    let text = '';
    let data: Record<string, unknown> | undefined;

    for (const part of message.parts ?? []) {
        // A2A v1.0: parts carry a `content` oneof discriminated by `$case`.
        if (part.content?.$case === 'text' && !text) {
            text = part.content.value;
        } else if (part.content?.$case === 'data' && !data) {
            const value = part.content.value;
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                data = value as Record<string, unknown>;
            }
        }
    }

    return { text, data };
}

/**
 * Renders an `AskUserQuestion` input.
 *
 * The text part carries the QUESTIONS ONLY, one per line — no options, no
 * "reply here" hint. Options, headers and `multiSelect` live in the `data`
 * part alone, so a client rendering both parts never prints them twice.
 */
function renderQuestionPrompt(input: Record<string, unknown>): { text: string; data: unknown } {
    const questions = (Array.isArray(input.questions) ? input.questions : []) as AskUserQuestion[];

    const text = questions.map((question) => question.question).join('\n');

    return { text, data: { kind: 'ask_user_question', questions } };
}

/**
 * Renders a tool permission request.
 *
 * As for questions, the text part is the bare sentence; the tool name, its
 * input, the title and any decision reason live only in the `data` part.
 */
function renderPermissionPrompt(
    toolName: string,
    input: Record<string, unknown>,
    title: string | undefined,
    decisionReason?: string
): { text: string; data: unknown } {
    return {
        text: `Claude wants to use ${title ?? toolName}.`,
        data: { kind: 'permission_request', toolName, input, title, decisionReason },
    };
}

/** Total number of permission denials recorded on a task. */
function countDenials(entry: TaskEntry): number {
    let total = 0;
    for (const count of entry.deniedPrompts.values()) total += count;
    return total;
}

/**
 * `AskUserQuestion` expects its answers keyed by question text. A client can
 * send them structured (`data: { answers: { … } }`); otherwise the free text of
 * the reply is taken as the answer to the first (usually only) question.
 */
function buildAnswers(
    pending: PendingPrompt,
    userText: string,
    userData: Record<string, unknown> | undefined
): Record<string, string> {
    const provided = userData?.answers;
    if (provided && typeof provided === 'object' && !Array.isArray(provided)) {
        return provided as Record<string, string>;
    }

    const questions = (Array.isArray(pending.input.questions) ? pending.input.questions : []) as AskUserQuestion[];
    const first = questions[0]?.question;
    return first ? { [first]: userText } : {};
}

export default ClaudeCodeExecutor;
