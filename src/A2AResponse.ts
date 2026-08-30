import { Message, Part, Role, TaskState } from "@a2a-js/sdk";
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
