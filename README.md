# Synapse

Cross-project messaging between Claude Code sessions via named agents.

Synapse lets multiple Claude Code sessions talk to each other — even across different project folders. One agent finishes work and sends context to another.

```
Terminal 1 (~/backend)              Terminal 2 (~/frontend)
┌──────────────────┐                ┌──────────────────┐
│ Agent: "backend"  │   send_message │ Agent: "frontend" │
│                   │ ──────────────>│                   │
│ Claude Code       │    (broker)    │ Claude Code       │
└──────────────────┘                └──────────────────┘
         │                                   │
         └──────── Synapse Broker ───────────┘
              (localhost:3117, auto-started)
```

## Quickstart

```bash
# Install
npm install -g claude-synapse

# One-time setup (registers MCP server, installs hook, configures status line)
claude-synapse setup
```

Then open two terminals:

```bash
# Terminal 1
SYNAPSE_AGENT_NAME=backend claude

# Terminal 2
SYNAPSE_AGENT_NAME=frontend claude
```

The broker starts automatically when the first agent connects.

In Terminal 1, say: *"Send frontend a message: the API is ready at POST /api/meetings"*

Terminal 2 will pick it up after the next tool use.

### Real-time push (optional)

For instant message delivery without waiting for a tool use, add the channels flag:

```bash
SYNAPSE_AGENT_NAME=backend claude --dangerously-load-development-channels server:synapse
```

This enables Claude Code's Channels API for real-time push. The flag is required during the channels research preview — it will go away once Synapse is published as an approved plugin.

## How It Works

Synapse supports two delivery modes:

**Standard mode** (no flag needed):
1. Agent A sends a message to Agent B via the `send_message` tool
2. The broker queues the message
3. After Agent B's next tool use, a PostToolUse hook checks for pending messages
4. Claude sees the notification and calls `check_messages` to retrieve them

**Channel mode** (with `--dangerously-load-development-channels`):
1. Agent A sends a message to Agent B via the `send_message` tool
2. The broker pushes it instantly via SSE
3. The message appears in Agent B's context as a `<channel>` tag — no polling needed

In both modes, if the target agent is offline, messages are queued to disk and delivered on reconnect.

## CLI

```bash
claude-synapse setup           # Configure Synapse (run once)
claude-synapse broker start    # Start broker manually (usually auto-started)
claude-synapse broker stop     # Stop the broker
claude-synapse broker status   # Show broker and connected agents
claude-synapse version         # Show version
```

## Agent Naming

Set the agent name via environment variable:

```bash
SYNAPSE_AGENT_NAME=backend claude
```

Or register from within a session by telling Claude: *"Register as backend"*

If neither is set, defaults to the current folder name (e.g. `~/projects/backend` becomes `backend`).

## Tools

Once connected, Claude has these tools:

| Tool | Description |
|------|-------------|
| `send_message` | Send a message to another agent by name |
| `check_messages` | Retrieve pending messages from the queue |
| `list_agents` | List all registered agents and their status |
| `register_agent` | Set or change the agent name for this session |

## What `setup` does

Running `claude-synapse setup` configures three things:

1. **MCP server** — Registers Synapse globally in `~/.claude.json` so the tools are available in every Claude Code session
2. **PostToolUse hook** — Adds a hook to `~/.claude/settings.json` that checks for pending messages after every tool use and nudges Claude to read them
3. **Status line** — Wraps your existing status line to show the Synapse agent name and pending message count (e.g. `backend [synapse: backend (3)]`)

## Architecture

**Broker** — Lightweight HTTP server on `localhost:3117`
- Routes messages between agents via SSE (channel mode) or queue polling (standard mode)
- Persists undelivered messages to disk (`~/.claude-synapse/queues.jsonl`)
- Zero external dependencies (Node.js stdlib only)

**MCP Server** — Registered globally, spawned per Claude Code session
- Provides send_message, check_messages, list_agents, and register_agent tools
- Auto-starts the broker if it's not running
- In channel mode, also pushes messages in real-time via SSE

## Security

- Broker binds to `127.0.0.1` only (not exposed to network)
- All authenticated requests require a token (generated during setup)
- Data directory permissions: `700`, file permissions: `600`
- Max message size: 100KB
- Max queue depth: 100 messages per agent
- Messages are drained from the queue after delivery

**Prompt injection note:** Messages from other agents enter Claude's context. While Claude Code's permission system prevents unauthorized tool use, be aware that message content is treated as context. Do not send secrets or credentials through Synapse.

## Requirements

- Node.js >= 18
- Claude Code

For real-time push (channel mode):
- Claude Code v2.1.80+
- claude.ai login (channels don't work with API key auth)

## License

MIT
