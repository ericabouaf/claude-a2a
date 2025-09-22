
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
export interface AgentConfig {
  /** Server settings */
  server: ServerConfig;
  
  /** Additional agent options (optional) */
  [key: string]: any;
}
