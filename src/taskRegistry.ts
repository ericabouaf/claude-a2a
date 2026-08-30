import type { PermissionResult, Query } from '@anthropic-ai/claude-agent-sdk';
import type A2AResponse from './A2AResponse';

/** A promise plus the function that settles it. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/**
 * A tool call parked in `canUseTool`, waiting for the A2A client to answer.
 *
 * `AskUserQuestion` is bridged as a question; anything else that reaches
 * `canUseTool` is a permission prompt the `permissionMode` did not auto-allow.
 */
export interface PendingPrompt {
  kind: 'ask_user_question' | 'permission_request';
  toolName: string;
  /** The tool input as Claude proposed it. */
  input: Record<string, unknown>;
  /** Settles the `canUseTool` promise, unblocking the Claude query. */
  resolve: (result: PermissionResult) => void;
}

/**
 * Everything the executor needs to keep hold of while an A2A task is running:
 * the live Claude query (to interrupt it), its abort controller, the response
 * helper bound to the task's event bus, and — when the task is parked in
 * `input-required` — the tool call waiting for an answer.
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
  /** Set while the task is parked in `input-required`. */
  pendingPrompt?: PendingPrompt;
  /**
   * Permission prompts the client already refused on this task, keyed by
   * `permissionKey(toolName, input)` and counted.
   *
   * This is the loop breaker: a key already in this map must never round-trip
   * to the user a second time — Claude re-asking for a permission it was just
   * refused is what turned a single "no" into an infinite conversation.
   */
  deniedPrompts: Map<string, number>;
  /**
   * Set when the run must end in `failed` rather than in whatever Claude
   * reports: a repeated denied permission, or the denial cap being reached.
   * Read once by the query loop, which then publishes exactly this message as
   * the single terminal status.
   */
  stopReason?: string;
  /**
   * Released when the current A2A turn is over: either the Claude query reached
   * a terminal state, or it parked on a question. `execute()` awaits it, which
   * is what keeps the A2A turn open exactly as long as the agent is busy.
   * Re-armed at the start of every follow-up turn.
   */
  turn: Deferred<void>;
}

/**
 * Registry of the A2A tasks currently backed by a live Claude query.
 *
 * An entry exists from the moment `execute()` starts a query until the query
 * loop reaches a terminal state (completed / failed) or the task is canceled —
 * including while the task sits parked in `input-required`, which is precisely
 * what lets a follow-up turn find the pending question to answer.
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
