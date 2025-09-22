import fs from 'fs';
import path from 'path';
import { ClaudeA2AConfig } from './types';

/**
 * Loads the Claude A2A configuration from a JSON file if it exists.
 * Looks for .claude/claude-a2a.config.json in the current working directory.
 *
 * @returns The loaded configuration or undefined if the file doesn't exist
 */
export function loadConfig(): ClaudeA2AConfig {
  const configPath = path.join(process.cwd(), '.claude', 'claude-a2a.config.json');

  try {
    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configContent) as ClaudeA2AConfig;
      console.log(`✅ Loaded configuration from ${configPath}`);
      return config;
    } else {
      console.log(`No config file found (looked for: ${configPath})`);
    }
  } catch (error) {
    console.error(`❌ Error loading configuration from ${configPath}:`, error);
  }

  return {};
}