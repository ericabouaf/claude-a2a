#!/usr/bin/env node

import express from "express";
import { AGENT_CARD_PATH, type AgentCard } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { A2AExpressApp } from "@a2a-js/sdk/server/express";

import ClaudeCodeExecutor from "./executor";
import { ClaudeA2AConfig } from "./types";
import { loadConfig } from "./configLoader";

export async function startServer(config: ClaudeA2AConfig) {
  const port = config.server?.port || 3008;

  const store = new InMemoryTaskStore();
  const agentCard = buildAgentCard(config);

  const claudeCodeExecutor = new ClaudeCodeExecutor();

  const requestHandler = new DefaultRequestHandler(agentCard, store, claudeCodeExecutor);

  const appBuilder = new A2AExpressApp(requestHandler);
  const expressApp = appBuilder.setupRoutes(express());

  expressApp.listen(port, () => {
    console.log(`🚀 Server started on http://localhost:${port}`);
    console.log(`🪪 Agent card available at http://localhost:${port}/${AGENT_CARD_PATH}`);
  });
  
  return agentCard;
}

/**
 * Builds an AgentCard from a config.
 * @param config The config to build the agent card from.
 * @returns The agent card.
 */
function buildAgentCard(config: ClaudeA2AConfig): AgentCard {
  const port = config.server?.port || 3008;
  const host = config.server?.host || 'localhost';

  return {
    name: config.agentCard?.name || "A2A Agent",
    description: config.agentCard?.description || "An agent that serves as an A2A protocol agent.",
    url: `http://localhost:${port}`,
    provider: config.agentCard?.provider,
    version: config.agentCard?.version || "0.0.1",
    capabilities: {
      streaming: config.agentCard?.capabilities?.streaming ?? true,
      pushNotifications: config.agentCard?.capabilities?.pushNotifications ?? false,
      stateTransitionHistory: config.agentCard?.capabilities?.stateTransitionHistory ?? false,
    },
    // authentication: config.agentCard?.authentication ?? null,
    defaultInputModes: config.agentCard?.defaultInputModes || ["text"],
    defaultOutputModes: config.agentCard?.defaultOutputModes || ["text"],
    skills: config.agentCard?.skills || [],
    protocolVersion: "0.3.0",
  };
}

// Load configuration from file or use defaults
startServer(
  loadConfig()
);