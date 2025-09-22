import { AgentCard } from "@a2a-js/sdk";

/**
 * Server configuration options.
 */
export interface ServerConfig {
  /** Hostname or IP address to bind */
  host?: string;
  /** Port to listen on (if not provided, will be autodetected) */
  port?: number;
}

/**
 * Main agent configuration schema.
 */
export interface ClaudeA2AConfig {
  /** Server settings */
  server?: ServerConfig;

  agentCard?: AgentCard;
}
