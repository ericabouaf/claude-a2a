#!/usr/bin/env node

import express from "express";
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, type AgentCard } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";

import ClaudeCodeExecutor from "./executor";
import { ClaudeA2AConfig } from "./types";
import { loadConfig } from "./configLoader";
import { allowedLoginsGate, callerServerCallContextBuilder } from "./caller";

/**
 * Default bind address: loopback only. The server has no authentication of its
 * own, so it must not be reachable from the LAN unless someone opts in by
 * setting `server.host` (e.g. `0.0.0.0`). To share it, put a reverse proxy that
 * authenticates in front of it — see the Tailscale section of the README.
 */
const DEFAULT_HOST = "127.0.0.1";

export async function startServer(config: ClaudeA2AConfig) {
  const port = config.server?.port || 3008;
  const host = config.server?.host || DEFAULT_HOST;
  const allowedLogins = config.server?.allowedLogins;

  const store = new InMemoryTaskStore();
  const agentCard = buildAgentCard(config);

  const claudeCodeExecutor = new ClaudeCodeExecutor(config.claude ?? {});

  const requestHandler = new DefaultRequestHandler(agentCard, store, claudeCodeExecutor);

  const cardHandler = agentCardHandler({ agentCardProvider: requestHandler });

  const expressApp = express();
  // The agent card is mounted first, and deliberately stays public: a client
  // must be able to discover the agent before it is allowed to talk to it.
  expressApp.use(`/${AGENT_CARD_PATH}`, cardHandler);
  if (allowedLogins?.length) {
    expressApp.use(allowedLoginsGate(allowedLogins));
  }
  expressApp.use(
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
      contextBuilder: callerServerCallContextBuilder,
    })
  );

  expressApp.listen(port, host, () => {
    console.log(`🚀 Server started on http://${host}:${port}`);
    console.log(`🪪 Agent card available at http://${host}:${port}/${AGENT_CARD_PATH}`);
    if (allowedLogins?.length) {
      console.log(`🔒 Restricted to Tailscale logins: ${allowedLogins.join(", ")}`);
    }
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
