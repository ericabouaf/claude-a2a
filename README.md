# Claude A2A

A server wrapper that exposes the a Claude Code agent via the [A2A (Agent-to-Agent)](https://a2a-protocol.org/) protocol.

WARNING: This project is not production ready. Use it at your own risks.

## Description

This project enables Claude Code to be used as an A2A-compatible agent, facilitating integration with other systems that support this AI agent interoperability standard.
It uses the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).

The server speaks **A2A protocol v1.0** and keeps **v0.3 clients working** through
the `@a2a-js/sdk` compatibility layer: v0.3 JSON-RPC methods (`message/stream`,
`tasks/get`, …) are accepted, and the agent card is served in the v0.3 shape
unless the request carries an `A2A-Version: 1.0` header.

## Quickstart

### Global Installation

```bash
npm install -g claude-a2a
```

### Prerequisites

The server uses your local Claude Code login: run `claude` once to log in, and
the Claude Agent SDK will reuse those credentials. No API key is needed.

### Running the Server

After global installation, navigate to your agent's working directory and start the server:

```bash
cd /path/to/your/agent-folder
claude-a2a
```

The server will start on `http://localhost:3008` and use the current directory as the working directory for Claude Code operations.


### Local Development

For local development:

```bash
npm run dev
```

### Build

```bash
npm run dist
```

Compiles TypeScript to JavaScript in the `dist/` folder

### Type Checking

```bash
npm run typecheck
```

## Configuration

The server starts by default on port 3008. The agent card is accessible at:
- `http://localhost:3008/.well-known/agent-card.json` (also served on the
  pre-v1.0 path `/.well-known/agent-card`)

Optional settings are read from `.claude/claude-a2a.config.json` in the current
working directory:

```json
{
  "server": {
    "port": 3008,
    "publicUrl": "https://my-agent.example.com"
  },
  "agentCard": {
    "name": "My Claude Agent",
    "description": "A Claude Code agent exposed over A2A.",
    "version": "1.0.0",
    "capabilities": { "streaming": true, "pushNotifications": false },
    "defaultInputModes": ["text"],
    "defaultOutputModes": ["text"],
    "skills": []
  }
}
```

`server.publicUrl` is the URL advertised in the agent card's
`supportedInterfaces`; it defaults to `http://localhost:<port>`.

### Claude options

The optional `claude` block is forwarded to the Claude Agent SDK `query()`:

```json
{
  "claude": {
    "cwd": "/path/to/the/agent/workspace",
    "permissionMode": "acceptEdits",
    "model": "claude-sonnet-4-5",
    "allowedTools": ["Read", "Write", "Edit"],
    "settingSources": ["user", "project", "local"],
    "maxTurns": 20
  }
}
```

| Key | Default | Notes |
|---|---|---|
| `cwd` | `process.cwd()` | Working directory for Claude; also where the session file lives. |
| `permissionMode` | `"acceptEdits"` | `default`, `acceptEdits`, `bypassPermissions`, `plan`, … |
| `model` | SDK default | Model id. |
| `allowedTools` | SDK default | Tools usable without a permission prompt. |
| `settingSources` | `["user", "project", "local"]` | The Agent SDK loads **no** settings source by default: without this, `CLAUDE.md`, `settings.json` and project slash commands are ignored. The default above restores the `claude` CLI behaviour. |
| `maxTurns` | unlimited | Hard cap on agent turns per task. |

## Session persistence

The `A2A contextId -> Claude session_id` map is written to
`<cwd>/.claude/claude-a2a.sessions.json` (atomically, on every change) and
reloaded at startup, so restarting the server does not break the continuity of
ongoing A2A conversations. The file is local state: keep it out of git.

## Cancellation

`tasks/cancel` (v0.3) / `CancelTask` (v1.0) interrupts the Claude query backing
the task: the server calls `query.interrupt()`, aborts the query, and publishes
a final `TASK_STATE_CANCELED` status update. A task that is not running on this
server is rejected with `TaskNotCancelable`.

## Features

- Response streaming support
- Contextual session management
- Artifact publishing (created/modified files)
- Custom hooks to intercept tool usage

## Potential Enhancements

- **Authentication**: Implement authentication mechanisms for secure agent access
- **Tool expansion**: Enable more Claude Agent SDK tools beyond Write, WebSearch, and Edit
- **Persistent storage**: Replace in-memory task store with database-backed storage
- **Error handling**: Enhanced error recovery and retry mechanisms
- **Monitoring**: Add logging, metrics, and observability features
- **Docker support**: Containerize the application for easier deployment
- **WebSocket support**: Real-time bidirectional communication for push notifications

## License

ISC