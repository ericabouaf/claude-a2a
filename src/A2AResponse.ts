import { Message, Part, Role, Task, TaskState } from "@a2a-js/sdk";
import { AgentEvent, AgentExecutionEvent, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { randomUUID } from "node:crypto";
import { a2aLog } from './logger';

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

    public publishStatusUpdateWorking(message?: Message) {
        a2aLog('out', 'status-update working', message);
        this.publish(AgentEvent.statusUpdate({
            taskId: this.taskId,
            contextId: this.contextId,
            status: {
                state: TaskState.TASK_STATE_WORKING,
                message: message,
                timestamp: new Date().toISOString(),
            },
            metadata: undefined,
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
     * Re-opens a parked task: republishes it in the `working` state.
     *
     * A2A requires the first event of any stream to be a `task` or a `message`
     * (`DefaultRequestHandler._advanceStreamPattern` throws otherwise), so this
     * is what a follow-up turn on an input-required task must publish first.
     * Artifacts and history are carried over from the stored task.
     */
    public publishTaskResumed(storedTask: Task | undefined) {
        a2aLog('out', 'Task resumed event (working)');
        this.publish(AgentEvent.task({
            id: this.taskId,
            contextId: this.contextId,
            status: {
                state: TaskState.TASK_STATE_WORKING,
                message: undefined,
                timestamp: new Date().toISOString(),
            },
            artifacts: storedTask?.artifacts ?? [],
            history: storedTask?.history ?? [],
            metadata: storedTask?.metadata,
        }));
    }

    /**
     * Builds an agent message carrying both a human readable rendering and the
     * machine readable payload a client needs to answer programmatically.
     */
    public buildPromptMessage(text: string, data: unknown): Message {
        const message = this.buildTextMessage(text);
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

    public buildTextMessage(messageText: string, role: Role = Role.ROLE_AGENT): Message {
        return {
            messageId: randomUUID(),
            contextId: this.contextId,
            taskId: this.taskId,
            role: role,
            parts: [buildTextPart(messageText)],
            metadata: undefined,
            extensions: [],
            referenceTaskIds: [],
        };
    }
}

export default A2AResponse;
