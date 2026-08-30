# Claude A2A

A server wrapper that exposes the a Claude Code agent via the [A2A (Agent-to-Agent)](https://a2a-protocol.org/) protocol.

WARNING: This project is not production ready. Use it at your own risks.

## Description

This project enables Claude Code to be used as an A2A-compatible agent, facilitating integration with other systems that support this AI agent interoperability standard.
It uses the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).

The server speaks **A2A protocol v1.0** only (JSON-RPC binding, `@a2a-js/sdk` 1.x).
v0.3 clients are not supported.

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
    "host": "127.0.0.1",
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

`server.host` is the bind address, and it defaults to `127.0.0.1`: this server
has **no authentication of its own**, so it stays on loopback unless you opt in.
Binding `0.0.0.0` exposes an unauthenticated Claude Code session to your whole
LAN — only do it behind a reverse proxy that authenticates, as below.

## Exposing the server on a Tailscale tailnet

[`tailscale serve`](https://tailscale.com/kb/1312/serve) runs on the same
machine, terminates TLS, and reverse-proxies
`https://<machine>.<tailnet>.ts.net` to the loopback port. Only devices on your
tailnet can reach it, and Tailscale adds identity headers
(`Tailscale-User-Login`, `Tailscale-User-Name`, `Tailscale-User-Profile-Pic`) to
every request it proxies.

```bash
tailscale serve --bg 3008   # proxy https://<machine>.<tailnet>.ts.net -> 127.0.0.1:3008
tailscale serve status      # check what is currently served
```

Config side:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 3008,
    "publicUrl": "https://my-machine.tailnet-name.ts.net",
    "allowedLogins": ["you@example.com"]
  }
}
```

- Keep `host` on `127.0.0.1`: `tailscale serve` connects locally, so the server
  never needs to listen anywhere else. Everything reaching it then comes through
  the proxy, headers included.
- `publicUrl` **must** be the tailnet URL. The agent card advertises it in
  `supportedInterfaces`, and a remote client follows that URL for every call —
  leave it on `http://localhost:3008` and clients will talk to themselves.
- `allowedLogins` is optional. When set and non-empty, a request whose
  `Tailscale-User-Login` is missing or not in the list is answered `403
  {"error":"forbidden"}` before it reaches the agent. The agent card stays
  public: a client must be able to discover the agent before it may talk to it.
  Unset (the default) means no gating — any tailnet device can drive the agent.
- The caller's login is stored on the A2A `ServerCallContext.state` under
  `caller` and logged with every incoming request (`caller: <login>`, or
  `anonymous` when the header is absent).

⚠️ Anyone who gets through reaches a Claude Code session running with
`permissionMode` `acceptEdits` in the configured `cwd` — it can read and write
files there. Treat access as equivalent to a shell on that directory.

Note that these headers are asserted by the proxy, not verified by this server:
they are trustworthy only as long as the server is unreachable except through
`tailscale serve` — which is exactly what the loopback default buys you.

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
    "maxTurns": 20,
    "maxPermissionDenials": 3
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
| `permissionPrompts` | `"input-required"` | What to do with a tool permission prompt `permissionMode` did not auto-allow: bridge it to the client (see below) or `"deny"` it outright. |
| `maxPermissionDenials` | `3` | Permission denials a single task may collect before it is stopped. See [loop protection](#loop-protection). |

## Session persistence

The `A2A contextId -> Claude session_id` map is written to
`<cwd>/.claude/claude-a2a.sessions.json` (atomically, on every change) and
reloaded at startup, so restarting the server does not break the continuity of
ongoing A2A conversations. The file is local state: keep it out of git.

## Interactive tasks (input-required)

When Claude needs the human — it calls `AskUserQuestion`, or a tool needs a
permission the `permissionMode` does not auto-allow — the task moves to
`TASK_STATE_INPUT_REQUIRED` instead of blocking or failing. The Claude query
stays alive in the background while the A2A turn ends, and the next message
carrying the same `taskId` resumes it.

The `input-required` status message carries two parts, and they do **not**
overlap: the `text` part is the bare prompt (the question text(s), one per line;
or `Claude wants to use <tool>.`), and the `application/json` `data` part holds
everything else — options, descriptions, tool input. A client can render both
without printing anything twice.

A question (`AskUserQuestion`) — text part: `Which colour do you prefer?`, data
part:

```json
{
  "kind": "ask_user_question",
  "questions": [
    {
      "question": "Which colour do you prefer?",
      "header": "Colour",
      "options": [
        { "label": "red", "description": "Choose red" },
        { "label": "blue", "description": "Choose blue" }
      ],
      "multiSelect": false
    }
  ]
}
```

A permission request — text part:
``Claude wants to run `rm -rf build`.``, data part:

```json
{
  "kind": "permission_request",
  "toolName": "Bash",
  "input": { "command": "rm -rf build" },
  "title": "Claude wants to run `rm -rf build`",
  "decisionReason": "Bash command not in allowedTools"
}
```

### Answering

Send another message on the **same `taskId`** (and `contextId`). A structured
`data` part always wins over the text part.

#### Answering a question (`ask_user_question`)

- **Free text** — taken as the answer to the first (usually only) question.
- **Structured** — `data` part `{ "answers": { "<question text>": "<label>" } }`,
  to answer several questions at once.

#### Answering a permission request (`permission_request`)

- **Structured** — `data` part:

  ```json
  { "kind": "permission_response", "decision": "deny", "reason": "no writes outside the repo" }
  ```

  `decision` is `"allow"` or `"deny"`; `reason` is optional and only used on a
  deny. This is the unambiguous form, and the one an app should send.

- **Free text** — tolerant, because humans do not answer in enum values. The
  reply is lowercased, split into words (punctuation stripped from the edges,
  but `-` and `'` kept inside a word), and for a reply of **8 words or fewer**:

  | | |
  |---|---|
  | allow | a word from `yes`, `y`, `oui`, `ok`, `okay`, `sure`, `allow`, `go`, `vas-y`, `d'accord`, `autorise` is present **and** no deny word is |
  | deny | a word from `no`, `non`, `deny`, `refuse`, `nope`, `stop`, `cancel`, `annule`, `jamais` is present |

  So `Yes.`, `ok go ahead` and `oui, vas-y` all allow; `ok but no` denies.
  Anything ambiguous — and any reply longer than 8 words — is **denied**, on
  the principle that a privilege is granted explicitly or not at all. The
  denial then carries a reason saying the reply was not a clear yes or no,
  rather than echoing the user's words back at Claude.

#### Loop protection

A denial handed to Claude reads:

> The user denied this action (*reason*). Do not request the same permission
> again; pick another approach or finish the task and explain.

Without that second sentence Claude treats the reason as feedback on the
attempt and immediately asks for the *same* permission again — which
round-trips to the client forever. Two backstops make that unrecoverable-loop
impossible even if the model ignores the instruction:

- **Same request twice.** Every denial is recorded per task under
  `toolName + JSON.stringify(input)`. If Claude asks for a key that was already
  refused, the server does **not** ask the client again: it denies with
  `interrupt: true` and the task ends `failed` with
  `Stopped: Claude requested the same denied permission again (<tool>)`.
- **Too many denials.** Once a task reaches `claude.maxPermissionDenials`
  denials (default 3, any keys), that last denial also carries
  `interrupt: true` and the task ends `failed` with an explanatory message.

In both cases exactly one terminal status is published, and its message says
why the task stopped — not whatever the interrupted Claude run reported.

Cancelling a task parked in `input-required` works as usual: the pending
question is denied and the task ends `canceled`.

## Event stream contract (`metadata.kind`)

Every status update the server publishes carries its status **message** — and
that message's `metadata.kind` says what the text is, so a client does not have
to guess from the text itself. The status update event carries the same `kind`
in its own `metadata` when the message has no text to show (`resumed`).

| `metadata.kind` | Task state | Message text | Data part |
|---|---|---|---|
| `tool_use` | `working` | `Calling tool <toolName>` | — (`toolName` is in `metadata`) |
| `result` | `working` | Claude's final answer for the turn | — |
| `ask_user_question` | `input-required` | the question text(s), one per line | `{ kind, questions }` |
| `permission_request` | `input-required` | `Claude wants to use <title ?? toolName>.` | `{ kind, toolName, input, title, decisionReason }` |
| `resumed` | `working` | *(none — the message carries only metadata)* | — |

Status updates with no message (`completed`) or with an unmarked message
(`failed`, `canceled`) carry no `kind`: treat an absent `metadata.kind` as
plain text.

## Resuming a parked task

A follow-up turn answering an `input-required` task must start, like any A2A
stream, with a `task` or `message` event. This server publishes the **stored
task, verbatim** — same id, still in `input-required`, with its artifacts and
history — as a pure snapshot, immediately followed by a `working` status update
tagged `kind: "resumed"`. So:

- a `task` event in `submitted` with an id the client has not seen = a new task;
- a `task` event in `input-required` with an id the client is answering = a
  resume.

Republishing the task in a non-terminal, non-`working` state is safe:
`ExecutionEventQueue.events()` (in `@a2a-js/sdk`) terminates a stream only on a
`message` event or on a `statusUpdate` whose state is terminal or
`input-required` — a `task` event never ends the stream, whatever its state.

## Cancellation

`CancelTask` interrupts the Claude query backing
the task: the server calls `query.interrupt()`, aborts the query, and publishes
a final `TASK_STATE_CANCELED` status update. A task that is not running on this
server is rejected with `TaskNotCancelable`.

## Tests

`npm run smoke` runs the unit tests plus every end-to-end smoke against a
server that must already be running (`A2A_URL`, default `http://localhost:3008`):

| script | what it covers |
|---|---|
| `npm run test:unit` | the permission-answer decision table (no server, no Claude call) |
| `npm run smoke:v1` | a plain single-turn task |
| `npm run smoke:cancel` | `CancelTask` on a running task |
| `npm run smoke:input` | `AskUserQuestion` bridged to `input-required`, and the resume |
| `npm run smoke:permission` | a structured `permission_response` deny beats a contradicting `yes` and stops the loop; `oui, vas-y` allows |

```bash
A2A_URL=http://localhost:3018 npm run smoke
```

`smoke:permission` writes into a temporary directory outside the server's `cwd`
(override with `SMOKE_DIR`), because that is what `permissionMode: "acceptEdits"`
does not auto-allow — which is how the permission prompt is triggered at all.

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