import { AgentProvider, AgentSkill } from "@a2a-js/sdk";
import type { PermissionMode, SettingSource } from "@anthropic-ai/claude-agent-sdk";

/**
 * Server configuration options.
 */
export interface ServerConfig {
  /**
   * Hostname or IP address to bind. Defaults to `127.0.0.1`: the server has no
   * authentication of its own, so exposing it beyond loopback (`0.0.0.0`) is an
   * explicit opt-in, and should be paired with an authenticating reverse proxy.
   */
  host?: string;
  /** Port to listen on (defaults to 3008) */
  port?: number;
  /**
   * Public base URL advertised in the agent card `supportedInterfaces`.
   * Defaults to `http://localhost:${port}` when omitted.
   */
  publicUrl?: string;
  /**
   * When set and non-empty, only callers whose `Tailscale-User-Login` header is
   * in this list may reach the JSON-RPC endpoint; everyone else gets a `403`.
   * The agent card stays public. Unset (the default) means no gating at all.
   */
  allowedLogins?: string[];
}

/**
 * Agent capabilities, as configurable from the config file.
 * (Subset of the A2A v1.0 `AgentCapabilities`.)
 */
export interface AgentCapabilitiesConfig {
  streaming?: boolean;
  pushNotifications?: boolean;
}

/**
 * Agent card fields that can be overridden from the config file.
 * The A2A v1.0 plumbing (supportedInterfaces, security, signatures) is
 * derived by the server, not configured here.
 */
export interface AgentCardConfig {
  name?: string;
  description?: string;
  provider?: AgentProvider;
  version?: string;
  capabilities?: AgentCapabilitiesConfig;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills?: AgentSkill[];
  documentationUrl?: string;
}

/**
 * Main agent configuration schema.
 */
export interface ClaudeA2AConfig {
  /** Server settings */
  server?: ServerConfig;

  agentCard?: AgentCardConfig;

  /** Claude Agent SDK settings */
  claude?: ClaudeConfig;
}

/**
 * Claude Agent SDK options exposed through the config file.
 * Everything here is forwarded to `query({ options })`.
 */
export interface ClaudeConfig {
  /** Working directory for Claude. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Permission mode for tool use. Defaults to `'acceptEdits'`. */
  permissionMode?: PermissionMode;
  /** Model id (e.g. "claude-sonnet-4-5"). Defaults to the SDK default. */
  model?: string;
  /** Tools Claude may use without a permission prompt. */
  allowedTools?: string[];
  /**
   * Which settings layers the Agent SDK loads (CLAUDE.md, settings.json,
   * slash commands…). The SDK loads NONE of them by default; this server
   * defaults to `['user', 'project', 'local']` to restore the CLI behaviour.
   */
  settingSources?: SettingSource[];
  /** Hard cap on agent turns for a single task. */
  maxTurns?: number;
  /**
   * What to do with a tool permission prompt the `permissionMode` did not
   * auto-allow: bridge it to the A2A client as `input-required` (default), or
   * deny it outright so the task never blocks.
   *
   * `AskUserQuestion` is always bridged: it is a question for the user, not a
   * privilege grant.
   */
  permissionPrompts?: PermissionPromptPolicy;
  /**
   * How many permission denials a single task may collect before it is
   * stopped. Defaults to 3.
   *
   * Reaching the cap denies with `interrupt: true` and ends the task `failed`,
   * so a client that keeps saying no cannot be walked around the same wall
   * forever. Independent of the same-request protection, which stops the task
   * the first time Claude re-asks for a permission that was already refused.
   */
  maxPermissionDenials?: number;
}

/** @see ClaudeConfig.permissionPrompts */
export type PermissionPromptPolicy = 'input-required' | 'deny';
