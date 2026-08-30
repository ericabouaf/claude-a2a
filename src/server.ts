#!/usr/bin/env node

import express from "express";
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, type AgentCard } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";

import ClaudeCodeExecutor from "./executor";
import { ClaudeA2AConfig } from "./types";
import { loadConfig } from "./configLoader";

export async function startServer(config: ClaudeA2AConfig) {
  const port = config.server?.port || 3008;

  const store = new InMemoryTaskStore();
  const agentCard = buildAgentCard(config);

  const claudeCodeExecutor = new ClaudeCodeExecutor(config.claude ?? {});

  const requestHandler = new DefaultRequestHandler(agentCard, store, claudeCodeExecutor);

  const cardHandler = agentCardHandler({ agentCardProvider: requestHandler });

  const expressApp = express();
  expressApp.use(`/${AGENT_CARD_PATH}`, cardHandler);
  expressApp.use(
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    })
  );

  expressApp.listen(port, () => {
    console.log(`🚀 Server started on http://localhost:${port}`);
    console.log(`🪪 Agent card available at http://localhost:${port}/${AGENT_CARD_PATH}`);
  });

  return agentCard;
}

/**
 * Builds an A2A v1.0 AgentCard from a config.
 * @param config The config to build the agent card from.
 * @returns The agent card.
 */
function buildAgentCard(config: ClaudeA2AConfig): AgentCard {
  const port = config.server?.port || 3008;
  const url = config.server?.publicUrl || `http://localhost:${port}`;

  return {
    name: config.agentCard?.name || "A2A Agent",
    description: config.agentCard?.description || "An agent that serves as an A2A protocol agent.",
    supportedInterfaces: [
      {
        url,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: config.agentCard?.provider,
    version: config.agentCard?.version || "0.0.1",
    documentationUrl: config.agentCard?.documentationUrl || "",
    capabilities: {
      streaming: config.agentCard?.capabilities?.streaming ?? true,
      pushNotifications: config.agentCard?.capabilities?.pushNotifications ?? false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: config.agentCard?.defaultInputModes || ["text"],
    defaultOutputModes: config.agentCard?.defaultOutputModes || ["text"],
    skills: config.agentCard?.skills || [],
    signatures: [],
  };
}

// Load configuration from file or use defaults
startServer(
  loadConfig()
);
