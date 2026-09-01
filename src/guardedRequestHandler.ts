import type { AgentCard } from '@a2a-js/sdk';
import type { Message, SendMessageRequest, StreamResponse, Task } from '@a2a-js/sdk';
import {
    DefaultRequestHandler,
    type ServerCallContext,
    type TaskStore,
} from '@a2a-js/sdk/server';
import type ClaudeCodeExecutor from './executor';

/**
 * A `DefaultRequestHandler` that refuses a follow-up turn on a task whose
 * previous turn is still running.
 *
 * ## Why the check cannot live in the executor
 *
 * All turns of one task share a single event bus:
 * `DefaultExecutionEventBusManager.createOrGetByTaskId(taskId)` hands the very
 * same instance to every call, which is what makes resuming a parked task
 * possible at all. The cost is that a turn arriving while another is still open
 * publishes into the *other turn's* live `ExecutionEventQueue`. The queue's
 * consumer runs `_advanceStreamPattern`, which is already in TASK_LIFECYCLE and
 * throws on anything that is not a statusUpdate / artifactUpdate:
 *
 *     Stream ordering violation: received task in task lifecycle stream.
 *
 * That is exactly the crash reported by the first real client, and the head
 * `task` snapshot every answer turn must publish (the A2A stream contract wants
 * a `task` or `message` first — `_advanceStreamPattern`, UNDETERMINED case)
 * is what triggers it.
 *
 * Refusing from inside `execute()` does not help, and makes it worse. Read
 * `_runStreamExecutor` in `node_modules/@a2a-js/sdk/dist/server/index.js`: it
 * attaches a `.catch()` on `execute()` and, when nothing has been published on
 * that turn yet, **publishes a synthetic `task` event plus a
 * `statusUpdate(FAILED)` on the same shared bus**. So throwing an `A2AError`
 * from `execute()` would inject precisely the two events we are trying to keep
 * off the bus — the ordering violation would still fire, and the running task
 * would additionally be persisted as FAILED. Returning early without publishing
 * is no better: `_settleBus` would then see no state, call `eventBus.finished()`
 * and `cleanupByTaskId`, killing the bus the other turn is still writing to.
 *
 * The only place a rejection touches nothing shared is *before* the bus is
 * opened. `sendMessageStream` does, in order: `_createRequestContext` (which
 * also appends the message to the stored task's history), then
 * `createOrGetByTaskId`, then `_runStreamExecutor`. Throwing at the top of the
 * override happens before all three, so:
 *
 * - nothing is published, nothing is persisted, no bus is created or settled;
 * - the express JSON-RPC handler catches it on its `await iterator.next()`
 *   "Pre-stream error" branch and answers the *new* request with a plain
 *   JSON-RPC error body (HTTP 200, no SSE stream opened);
 * - the running turn never notices.
 *
 * `sendMessage` (the blocking variant) is guarded the same way, and for the
 * same reason: its `_runExecutor` has the identical synthetic-FAILED catch.
 */
export class GuardedRequestHandler extends DefaultRequestHandler {

    private readonly executor: ClaudeCodeExecutor;

    constructor(agentCard: AgentCard, taskStore: TaskStore, executor: ClaudeCodeExecutor) {
        super(agentCard, taskStore, executor);
        this.executor = executor;
    }

    override async *sendMessageStream(
        params: SendMessageRequest,
        context: ServerCallContext
    ): AsyncGenerator<StreamResponse, void, undefined> {
        // Before `super`: see the class comment. Once the generator body of
        // `DefaultRequestHandler.sendMessageStream` starts, the shared bus is
        // already in play and no rejection is free any more.
        this.executor.assertAcceptsFollowUp(params.message?.taskId);
        yield* super.sendMessageStream(params, context);
    }

    override async sendMessage(
        params: SendMessageRequest,
        context: ServerCallContext
    ): Promise<Message | Task> {
        this.executor.assertAcceptsFollowUp(params.message?.taskId);
        return super.sendMessage(params, context);
    }
}

export default GuardedRequestHandler;
