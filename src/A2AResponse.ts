import { Message2 } from "@a2a-js/sdk";
import { AgentExecutionEvent, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { v4 as uuidv4 } from "uuid";
import { a2aLog } from './logger';

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
        this.publish({
          kind: "task",
          id: this.taskId,
          contextId: this.contextId,
          status: { state: "submitted", timestamp: new Date().toISOString() },
        });
    }

    public publishStatusUpdateWorking(message?: Message2) {
        a2aLog('out', 'status-update working', message);
        this.publish({
            kind: "status-update",
            taskId: this.taskId,
            contextId: this.contextId,
            status: { 
                state: "working", 
                timestamp: new Date().toISOString(),
                message: message
            },
            final: false
        });
    }

    public publishStatusUpdateCompleted() {
        a2aLog('out', 'status-update completed (FINAL)');
        this.publish({
            kind: "status-update",
            taskId: this.taskId,
            contextId: this.contextId,
            status: { state: "completed", timestamp: new Date().toISOString() },
            final: true,
        });
    }

    public publishTextArtifactUpdate(artifactId: string, textContent: string) {
        a2aLog('out', `artifact-update (artifactId: ${artifactId})`);
        this.eventBus.publish({
            kind: "artifact-update",
            taskId: this.taskId,
            contextId: this.contextId,
            artifact: { artifactId, parts: [{ kind: "text", text: textContent }] },
        });
    }

    public buildTextMessage(messageText: string, role: 'agent'|'user' = 'agent'): Message2 {
        return {
            kind: 'message',
            role: role,
            messageId: uuidv4(),
            parts: [{ kind: 'text', text: messageText }],
            taskId: this.taskId,
            contextId: this.contextId,
        };
    }
}

export default A2AResponse;
