import {
    query,
    type SDKMessage,
    type SDKUserMessage,
    type PostToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { AgentExecutor, RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import path from 'path';
import A2AResponse from './A2AResponse';
import { a2aLog, claudeLog } from './logger';



class ClaudeCodeExecutor implements AgentExecutor {

    // Map a2a contextId to a claude sessionId
    private a2aContextToClaudeSession: Record<string, string> = {};

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
        const claudeSessionId = this.a2aContextToClaudeSession[contextId] ?? undefined;

        const newClaudeSessionId = await this.startClaudeExecution(userText, a2aResponse, claudeSessionId);

        // Save claudeSessionId (mapped by A2A contextId) to re-use in future query calls
        if (newClaudeSessionId) {
          this.a2aContextToClaudeSession[contextId] = newClaudeSessionId;
        }

         // Publish final 'completed' state.
        a2aResponse.publishStatusUpdateCompleted();

        a2aResponse.finished();
    }

    private async startClaudeExecution(userText: string, a2aResponse: A2AResponse, claudeSessionId: string | undefined): Promise<string | null> {

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


        const messages = query({
            prompt: promptIteratorInstance,
            options: {
                resume: claudeSessionId,
                hooks: {
                    PostToolUse: [{
                        hooks: [async (input, toolUseID, options) => {
                            const typedInput = input as PostToolUseHookInput;

                            console.log('\n=== HOOK: PostToolUse ===');
                            //console.log('Timestamp:', new Date().toISOString());
                            console.log('Tool Name:', typedInput.tool_name);
                            console.log('Tool Response:', JSON.stringify(typedInput.tool_response, null, 2).substring(0, 500) + '...');
                            //console.log('Tool Use ID:', toolUseID);
                            console.log('=========================\n');

                            // publish Write as a2a artifacts
                            if (typedInput.tool_name === 'Write') {
                              const writeToolResponse = typedInput.tool_response as {filePath: string, content: string};
                              const filePath = writeToolResponse.filePath;
                              const filename = path.basename(filePath);
                              const content = writeToolResponse.content;
                              a2aResponse.publishTextArtifactUpdate(filename, content);
                            }

                            return { continue: true };
                        }]
                    }]
                }
            }
        });

        let newClaudeSessionId: string | null = null;
        try {
            for await (const message of messages) {
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
                    if ('result' in message) {
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
        } finally {
            // Make sure the generator is always released (errors, early exits…)
            resolveDone!();
        }

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

  cancelTask = async (_taskId: string, _eventBus: ExecutionEventBus): Promise<void> => {
    // TODO step 3: interrupt the running Claude query for this task and publish
    // a TASK_STATE_CANCELED status update on the bus. No-op for now.
  };
}

export default ClaudeCodeExecutor;
