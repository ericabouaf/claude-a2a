import { Message, Part, Role, Task, TaskState } from "@a2a-js/sdk";
import { AgentEvent, AgentExecutionEvent, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { randomUUID } from "node:crypto";
import { a2aLog } from './logger';

/**
 * A2A metadata bag (proto `Struct`). Used here to carry the `kind` discriminator
 * documented in the README: `tool_use`, `result`, `ask_user_question`,
 * `permission_request`, `resumed`.
 */
export type Metadata = { [key: string]: any };

/** Builds an A2A v1.0 text `Part`. */
function buildTextPart(text: string): Part {
    return {
        content: { $case: 'text', value: text },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
    };
}

/** Builds an A2A v1.0 structured `data` `Part`. */
function buildDataPart(value: unknown): Part {
    return {
        content: { $case: 'data', value },
        metadata: undefined,
        filename: '',
        mediaType: 'application/json',
    };
}

class A2AResponse {

    private requestContext: RequestContext;
    private eventBus: ExecutionEventBus;

    private taskId: string;
    private contextId: string;

    constructor(
        requestContext: RequestContext,
        eventBus: ExecutionEventBus
    ) {
        this.requestContext = requestContext;
        this.eventBus = eventBus;

        this.taskId = requestContext.taskId;
        this.contextId = requestContext.contextId;
    }

    public publish(event: AgentExecutionEvent) {
        //a2aLog('out', 'Response event', event);
        this.eventBus.publish(event);
    }

    public finished() {
        this.eventBus.finished();
        a2aLog('out', 'Finished response stream');
    }

    public publishTaskSubmitted() {
        a2aLog('out', 'Task submitted event');
        this.publish(AgentEvent.task({
            id: this.taskId,
            contextId: this.contextId,
            status: {
                state: TaskState.TASK_STATE_SUBMITTED,
                message: undefined,
                timestamp: new Date().toISOString(),
            },
            artifacts: [],
            history: [],
            metadata: undefined,
        }));
    }

    public publishStatusUpdateWorking(message?: Message, metadata?: Metadata) {
        a2aLog('out', 'status-update working', message);
        this.publish(AgentEvent.statusUpdate({
            taskId: this.taskId,
            contextId: this.contextId,
            status: {
                state: TaskState.TASK_STATE_WORKING,
                message: message,
                timestamp: new Date().toISOString(),
            },
            metadata,
        }));
    }

    public publishStatusUpdateCompleted() {
        a2aLog('out', 'status-update completed (FINAL)');
        this.publish(AgentEvent.statusUpdate({
            taskId: this.taskId,
            contextId: this.contextId,
            status: {
                state: TaskState.TASK_STATE_COMPLETED,
                message: undefined,
                timestamp: new Date().toISOString(),
            },
            metadata: undefined,
        }));
    }

    /**
     * Publishes the final `canceled` state.
     *
     * The A2A `DefaultRequestHandler.cancelTask` does NOT publish this itself
     * when an event bus exists for the task: it calls
     * `agentExecutor.cancelTask(taskId, eventBus)`, drains the bus, then
     * reloads the task and throws `TaskNotCancelableError` unless the stored
     * state is CANCELED. Publishing it here is what makes the RPC succeed.
     */
    public publishStatusUpdateCanceled() {
        a2aLog('out', 'status-update canceled (FINAL)');
        this.publish(AgentEvent.statusUpdate({
            taskId: this.taskId,
            contextId: this.contextId,
            status: {
                state: TaskState.TASK_STATE_CANCELED,
                message: this.buildTextMessage('Task canceled.'),
                timestamp: new Date().toISOString(),
            },
            metadata: undefined,
        }));
    }

    /** Publishes the final `failed` state, carrying the error text. */
    public publishStatusUpdateFailed(messageText: string) {
        a2aLog('out', 'status-update failed (FINAL)', messageText);
        this.publish(AgentEvent.statusUpdate({
            taskId: this.taskId,
            contextId: this.contextId,
            status: {
                state: TaskState.TASK_STATE_FAILED,
                message: this.buildTextMessage(messageText),
                timestamp: new Date().toISOString(),
            },
            metadata: undefined,
        }));
    }

    /**
     * Publishes the non-final `input-required` state: the task parks until the
     * client sends another message carrying the same `taskId`.
     *
     * INPUT_REQUIRED is in the handler's default `keepBusAliveStates`, so the
     * event bus survives `execute()` returning and the follow-up turn reuses it.
     */
    public publishStatusUpdateInputRequired(message: Message) {
        a2aLog('out', 'status-update input-required');
        this.publish(AgentEvent.statusUpdate({
            taskId: this.taskId,
            contextId: this.contextId,
            status: {
                state: TaskState.TASK_STATE_INPUT_REQUIRED,
                message,
                timestamp: new Date().toISOString(),
            },
            metadata: undefined,
        }));
    }

    /**
     * Re-opens a parked task by republishing the STORED task, verbatim.
     *
     * A2A requires the first event of any stream to be a `task` or a `message`
     * (`DefaultRequestHandler._advanceStreamPattern` throws otherwise), so a
     * follow-up turn on an input-required task must publish one first.
     *
     * It is published as a pure SNAPSHOT — same id, its current
     * INPUT_REQUIRED state, its artifacts and history — rather than as a
     * fabricated `working` task, so a client can tell "new task" (state
     * SUBMITTED) from "resumed task" (state INPUT_REQUIRED, id already known)
     * from the `task` event alone. The `working` transition is then announced
     * by the `resumed` status update below.
     *
     * Safe against the SDK stream machinery, checked in
     * `node_modules/@a2a-js/sdk/dist/server/index.js`:
     *
     * - `ExecutionEventQueue.events()` stops only on `kind === 'message'` or on
     *   a `kind === 'statusUpdate'` whose state is terminal or INPUT_REQUIRED.
     *   A `task` event NEVER terminates the queue, whatever its state — so
     *   re-publishing the task in INPUT_REQUIRED does not close the new turn's
     *   stream.
     * - `_advanceStreamPattern` moves UNDETERMINED -> TASK_LIFECYCLE on a
     *   `task` event, which is exactly the pattern the rest of the turn
     *   (statusUpdate / artifactUpdate events) needs.
     * - `_settleBus` is fed by `trackLatestTaskState`, i.e. the LAST state
     *   published on the bus, not the first: the snapshot cannot make the
     *   handler think the turn ended in INPUT_REQUIRED.
     * - `ResultManager.processTaskEventLocked` merges the event with the
     *   persisted task (history kept when the event carries none, artifacts
     *   merged) before saving, so re-publishing the stored task is a no-op on
     *   the store; the `working` status update right after supersedes the
     *   state anyway.
     */
    public publishTaskSnapshot(storedTask: Task | undefined) {
        a2aLog('out', 'Task snapshot event (resumed)');
        this.publish(AgentEvent.task({
            id: this.taskId,
            contextId: this.contextId,
            status: storedTask?.status ?? {
                state: TaskState.TASK_STATE_INPUT_REQUIRED,
                message: undefined,
                timestamp: new Date().toISOString(),
            },
            artifacts: storedTask?.artifacts ?? [],
            history: storedTask?.history ?? [],
            metadata: storedTask?.metadata,
        }));
    }

    /**
     * Announces that a parked task is running again: a `working` status update
     * tagged `kind: 'resumed'`, published right after the task snapshot.
     */
    public publishStatusUpdateResumed() {
        this.publishStatusUpdateWorking(
            this.buildMetadataMessage({ kind: 'resumed' }),
            { kind: 'resumed' }
        );
    }

    /**
     * Builds an agent message carrying both a human readable rendering and the
     * machine readable payload a client needs to answer programmatically.
     */
    public buildPromptMessage(text: string, data: unknown, metadata?: Metadata): Message {
        const message = this.buildTextMessage(text, Role.ROLE_AGENT, metadata);
        message.parts = [...message.parts, buildDataPart(data)];
        return message;
    }

    /**
     * Publishes a whole text file as a single-chunk artifact.
     * The artifact id doubles as its human readable name (the filename).
     */
    public publishTextArtifactUpdate(filename: string, textContent: string) {
        a2aLog('out', `artifact-update (artifactId: ${filename})`);
        this.publish(AgentEvent.artifactUpdate({
            taskId: this.taskId,
            contextId: this.contextId,
            artifact: {
                artifactId: filename,
                name: filename,
                description: '',
                parts: [buildTextPart(textContent)],
                metadata: undefined,
                extensions: [],
            },
            // The whole file is sent at once: not an append, and final chunk.
            append: false,
            lastChunk: true,
            metadata: undefined,
        }));
    }

    public buildTextMessage(messageText: string, role: Role = Role.ROLE_AGENT, metadata?: Metadata): Message {
        return {
            messageId: randomUUID(),
            contextId: this.contextId,
            taskId: this.taskId,
            role: role,
            parts: [buildTextPart(messageText)],
            metadata,
            extensions: [],
            referenceTaskIds: [],
        };
    }

    /**
     * Builds a part-less agent message: nothing to read, only a `metadata.kind`
     * for the client to switch on.
     */
    public buildMetadataMessage(metadata: Metadata, role: Role = Role.ROLE_AGENT): Message {
        const message = this.buildTextMessage('', role, metadata);
        message.parts = [];
        return message;
    }
}

export default A2AResponse;
