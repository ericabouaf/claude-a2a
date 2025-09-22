# Claude A2A

A server wrapper that exposes the a Claude Code agent via the [A2A (Agent-to-Agent)](https://a2a-protocol.org/) protocol.

WARNING: This project is not production ready. Use it at your own risks.

## Description

This project enables Claude Code to be used as an A2A-compatible agent, facilitating integration with other systems that support this AI agent interoperability standard.
It uses the [Claude Code SDK](https://github.com/anthropics/claude-code).

## Quickstart

### Global Installation

```bash
npm install -g claude-a2a
```

### Prerequisites

Set your Anthropic API key as an environment variable:

```bash
export ANTHROPIC_API_KEY=your-api-key-here
```

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
npm run build
```

Compiles TypeScript to JavaScript in the `dist/` folder

### Type Checking

```bash
npm run typecheck
```

## Configuration

The server starts by default on port 3008. The agent card is accessible at:
- `http://localhost:3008/.well-known/agent-card`

## Features

- Response streaming support
- Contextual session management
- Artifact publishing (created/modified files)
- Custom hooks to intercept tool usage

## TODOs

- [ ] **Configuration file support**: Add support for external configuration files (.claude/claude-a2a.settings.json) to customize A2A settings

## Potential Enhancements

- **Authentication**: Implement authentication mechanisms for secure agent access
- **Tool expansion**: Enable more Claude Code SDK tools beyond Write, WebSearch, and Edit
- **Persistent storage**: Replace in-memory task store with database-backed storage
- **Error handling**: Enhanced error recovery and retry mechanisms
- **Monitoring**: Add logging, metrics, and observability features
- **Docker support**: Containerize the application for easier deployment
- **WebSocket support**: Real-time bidirectional communication for push notifications

## License

ISC