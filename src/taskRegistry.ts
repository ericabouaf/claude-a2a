import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type A2AResponse from './A2AResponse';

/**
 * Everything the executor needs to keep hold of while an A2A task is running:
 * the live Claude query (to interrupt it), its abort controller, and the
 * response helper bound to the task's event bus (to publish the final state).
 */
export interface TaskEntry {
  taskId: string;
  contextId: string;
  /** Aborts the Claude query. Passed to `query({ options.abortController })`. */
  abortController: AbortController;
  /** The live Claude query, for `interrupt()`. Set right after `query()`. */
  query?: Query;
  /** Bound to the task's event bus; replaced on each follow-up turn. */
  a2aResponse: A2AResponse;
  /**
   * Set by `cancelTask`. The query loop checks it before publishing anything:
   * once a task is canceled, CANCELED is the only status it may end on.
   */
  canceled: boolean;
}

/**
 * Registry of the A2A tasks currently executing a Claude query.
 *
 * An entry exists from the moment `execute()` starts a query until the query
 * loop reaches a terminal state (completed / failed) or the task is canceled.
 * `cancelTask` uses it to find the query to interrupt.
 */
export class TaskRegistry {
  private readonly entries = new Map<string, TaskEntry>();

  public add(entry: TaskEntry): TaskEntry {
    this.entries.set(entry.taskId, entry);
    return entry;
  }

  public get(taskId: string): TaskEntry | undefined {
    return this.entries.get(taskId);
  }

  public remove(taskId: string): void {
    this.entries.delete(taskId);
  }

  public get size(): number {
    return this.entries.size;
  }
}

export default TaskRegistry;
