# Synapse

Cross-project messaging between Claude Code sessions via named agents.

Synapse lets multiple Claude Code sessions talk to each other — even across different project folders. One agent finishes work and sends context to another. Messages are pushed automatically via the Claude Code Channels API.

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

# One-time setup (generates auth token)
claude-synapse setup

# Terminal 1: Start as "backend" agent
SYNAPSE_AGENT_NAME=backend claude --dangerously-load-development-channels server:synapse

# Terminal 2: Start as "frontend" agent
SYNAPSE_AGENT_NAME=frontend claude --dangerously-load-development-channels server:synapse
```

The broker starts automatically when the first agent connects.

## How It Works

1. Each Claude Code session starts with a Synapse channel plugin
2. The plugin connects to a shared localhost broker via SSE
3. When Agent A sends a message to Agent B, the broker pushes it instantly
4. Messages arrive in Claude's context as `<channel>` tags — no polling needed
5. If the target agent is offline, messages are queued and delivered on reconnect

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
SYNAPSE_AGENT_NAME=backend claude --dangerously-load-development-channels server:synapse
```

If not set, defaults to the current folder name (e.g. `~/projects/backend` becomes `backend`).

## Tools

Once connected, Claude has two tools:

| Tool | Description |
|------|-------------|
| `send_message` | Send a message to another agent by name |
| `list_agents` | List all registered agents and their status |

## Architecture

**Broker** — Lightweight HTTP server on `localhost:3117`
- Routes messages between agents via Server-Sent Events (SSE)
- Persists undelivered messages to disk (`~/.claude-synapse/queues.jsonl`)
- Zero external dependencies (Node.js stdlib only)

**Channel** — MCP server with Claude Code channel capability
- Spawned per Claude Code session as a subprocess
- Connects to broker for real-time message delivery
- Auto-starts the broker if it's not running

## Security

- Broker binds to `127.0.0.1` only (not exposed to network)
- All requests require an auth token (generated during setup)
- Data directory permissions: `700`, file permissions: `600`
- Max message size: 100KB
- Max queue depth: 100 messages per agent

**Note:** Messages from other agents enter Claude's context. While Claude Code's permission system prevents unauthorized actions, be aware that message content is treated as context, not instructions.

## Requirements

- Node.js >= 18
- Claude Code v2.1.80+ (for Channels support)
- claude.ai login (Channels don't work with API key auth)

## License

MIT
