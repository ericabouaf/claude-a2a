/**
 * Turning an A2A client's reply into an allow / deny decision for a parked
 * `permission_request`.
 *
 * Kept out of `executor.ts` on purpose: these are pure functions, so the
 * decision table can be unit-tested without a server, a bus or a Claude query
 * (see `scripts/permission-decision.test.mjs`).
 */

/** The outcome of reading a client's answer to a permission prompt. */
export type PermissionDecision =
    | { decision: 'allow'; source: 'structured' | 'text' }
    | { decision: 'deny'; reason: string; source: 'structured' | 'text' };

/**
 * The `data` part a client may send to answer a permission prompt, symmetric
 * to the `ask_user_question` / `data.answers` contract.
 *
 * ```json
 * { "kind": "permission_response", "decision": "deny", "reason": "not on prod" }
 * ```
 */
export const PERMISSION_RESPONSE_KIND = 'permission_response';

/** Words that mean "go ahead", matched on word boundaries, case-insensitive. */
const ALLOW_WORDS = new Set([
    'yes', 'y', 'oui', 'ok', 'okay', 'sure', 'allow', 'go', 'vas-y', "d'accord", 'autorise',
]);

/** Words that mean "do not", matched the same way. They beat allow words. */
const DENY_WORDS = new Set([
    'no', 'non', 'deny', 'refuse', 'nope', 'stop', 'cancel', 'annule', 'jamais',
]);

/**
 * Longest reply still read as a yes/no. Past that the client is explaining
 * something, not answering, and guessing "allow" from a stray "ok" would be a
 * privilege grant nobody asked for — so it is denied, with a reason saying so.
 */
const MAX_ANSWER_WORDS = 8;

/**
 * Splits a reply into comparable words: lowercased, punctuation stripped from
 * the edges, but `-` and `'` KEPT inside a word so `vas-y` and `d'accord` stay
 * single tokens (splitting them would make the bare `y` of `vas-y` a match on
 * its own, and lose `d'accord` entirely).
 */
export function words(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^\p{L}\p{N}'’-]+/u)
        .map((word) => word.replace(/’/g, "'").replace(/^['-]+|['-]+$/g, ''))
        .filter((word) => word.length > 0);
}

/**
 * Reads the client's reply to a `permission_request`.
 *
 * Precedence, and the whole point of the fix: a **structured** answer wins, a
 * **tolerant** free-text answer comes second, and anything unclear denies —
 * but always with a reason the agent can act on, never with a bare echo of the
 * user's words (which Claude used to read as "try again").
 */
export function readPermissionAnswer(
    userText: string,
    userData: Record<string, unknown> | undefined
): PermissionDecision {
    const structured = readStructuredAnswer(userData);
    if (structured) return structured;

    const text = userText.trim();
    if (!text) {
        return {
            decision: 'deny',
            reason: 'the client sent no answer',
            source: 'text',
        };
    }

    const tokens = words(text);
    const hasDeny = tokens.some((word) => DENY_WORDS.has(word));
    const hasAllow = tokens.some((word) => ALLOW_WORDS.has(word));

    if (tokens.length <= MAX_ANSWER_WORDS) {
        if (hasDeny) {
            return { decision: 'deny', reason: text, source: 'text' };
        }
        if (hasAllow) {
            return { decision: 'allow', source: 'text' };
        }
    }

    return {
        decision: 'deny',
        reason: `the reply "${text}" was neither a clear yes nor a clear no, so it was read as a refusal`,
        source: 'text',
    };
}

/** Reads a `{ kind: 'permission_response', decision, reason? }` data part. */
function readStructuredAnswer(
    userData: Record<string, unknown> | undefined
): PermissionDecision | undefined {
    if (!userData) return undefined;

    const kind = userData.kind;
    if (kind !== undefined && kind !== PERMISSION_RESPONSE_KIND) return undefined;

    const decision = userData.decision;
    if (decision === 'allow') return { decision: 'allow', source: 'structured' };
    if (decision !== 'deny') return undefined;

    const reason = typeof userData.reason === 'string' && userData.reason.trim()
        ? userData.reason.trim()
        : 'no reason given';
    return { decision: 'deny', reason, source: 'structured' };
}

/**
 * Identity of a permission prompt, for the per-task denial record.
 *
 * Tool name + exact input: the same tool with different arguments is a
 * different request and gets its own round-trip, but re-asking for the very
 * same call after a refusal is the loop we refuse to run again.
 */
export function permissionKey(toolName: string, input: Record<string, unknown>): string {
    return `${toolName}:${stableStringify(input)}`;
}

/** `JSON.stringify` with object keys sorted, so key order cannot split a key. */
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(',')}}`;
}

/**
 * The `message` handed back to Claude on a deny.
 *
 * The second sentence is the fix for the prompt loop: without it Claude reads
 * the denial reason as feedback on the attempt and immediately asks for the
 * very same permission again, which round-trips to the user forever.
 */
export function denialMessage(reason: string): string {
    return `The user denied this action (${reason}). `
        + `Do not request the same permission again; pick another approach or finish the task and explain.`;
}

/** The `message` handed back when a refusal also stops the run. */
export function stoppingDenialMessage(reason: string, stopReason: string): string {
    return `${denialMessage(reason)} ${stopReason}`;
}
