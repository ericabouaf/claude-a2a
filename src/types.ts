import { AgentProvider, AgentSkill } from "@a2a-js/sdk";

/**
 * Server configuration options.
 */
export interface ServerConfig {
  /** Hostname or IP address to bind */
  host?: string;
  /** Port to listen on (defaults to 3008) */
  port?: number;
  /**
   * Public base URL advertised in the agent card `supportedInterfaces`.
   * Defaults to `http://localhost:${port}` when omitted.
   */
  publicUrl?: string;
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
}
