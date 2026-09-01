import fs from 'node:fs';
import path from 'node:path';
import { claudeLog } from './logger';

/** File name of the on-disk session map, inside `<cwd>/.claude/`. */
const SESSIONS_FILE = 'claude-a2a.sessions.json';

/**
 * Persists the `A2A contextId -> Claude session_id` mapping so a server
 * restart does not lose the conversations it was hosting.
 *
 * Deliberately tiny: the whole map is a flat JSON object, it is loaded once at
 * construction and rewritten (atomically: temp file + rename) on every change.
 * A2A contexts are few and short-lived enough that this costs nothing.
 */
export class SessionStore {
  private readonly filePath: string;
  private sessions: Record<string, string> = {};

  constructor(cwd: string) {
    this.filePath = path.join(cwd, '.claude', SESSIONS_FILE);
    this.load();
  }

  /** Claude session id previously used for this A2A context, if any. */
  public get(contextId: string): string | undefined {
    return this.sessions[contextId];
  }

  /** Records (and persists) the Claude session id used for an A2A context. */
  public set(contextId: string, sessionId: string): void {
    if (this.sessions[contextId] === sessionId) {
      return;
    }
    this.sessions[contextId] = sessionId;
    this.persist();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [contextId, sessionId] of Object.entries(parsed)) {
          if (typeof sessionId === 'string') {
            this.sessions[contextId] = sessionId;
          }
        }
      }
      claudeLog(
        'debug',
        `Loaded ${Object.keys(this.sessions).length} session(s) from ${this.filePath}`
      );
    } catch (error) {
      // A corrupt or unreadable file must not prevent the server from starting:
      // the worst case is that existing contexts start a fresh Claude session.
      console.error(`❌ Could not read ${this.filePath}:`, error);
      this.sessions = {};
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      // Atomic write: a crash mid-write leaves the previous file intact.
      const tmpPath = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.sessions, null, 2) + '\n', 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (error) {
      console.error(`❌ Could not persist sessions to ${this.filePath}:`, error);
    }
  }
}

export default SessionStore;
