# Agent Synapse

Cross-project messaging between Claude Code sessions via named agents.

## Architecture

Two components:

- **Broker** (`src/broker.ts`) — HTTP server on localhost:3117. Routes messages via SSE, persists undelivered messages to `~/.claude-synapse/queues.jsonl`. Zero external deps (Node stdlib only).
- **Channel** (`src/channel.ts`) — MCP server with channel capability. Spawned per Claude Code session. Exposes tools (send_message, check_messages, list_agents, register_agent). Connects to broker via SSE for real-time push in channel mode.

## Two delivery modes

- **Standard mode** — MCP tools + PostToolUse hook. Hook checks `/pending/:name` and nudges Claude to call `check_messages`. Works everywhere, no special flags.
- **Channel mode** — Add `--dangerously-load-development-channels server:synapse` flag. Messages push instantly via SSE → channel notifications. Requires Channels API (research preview).

## Key files

- `src/types.ts` — Shared types, constants (VERSION, ports, limits)
- `src/config.ts` — All config management, install/uninstall logic, broker spawn, agent name validation
- `src/broker.ts` — HTTP server with endpoints: /health, /register, /send, /agents, /pending/:name, /drain/:name, /stream/:name
- `src/channel.ts` — MCP server, SSE listener, tool handler map
- `src/cli.ts` — CLI: setup, broker start/stop/status, uninstall, version

## Setup installs three things

1. MCP server in `~/.claude.json` (global, tools available everywhere)
2. PostToolUse hook in `~/.claude/settings.json` (checks for pending messages)
3. Status line wrapper (shows agent name + pending count)

## Build

```bash
npm run build    # tsc → dist/
npm link         # makes `agent-synapse` available globally
```

## Test manually

```bash
agent-synapse setup
agent-synapse broker start
# In separate terminals:
SYNAPSE_AGENT_NAME=backend claude
SYNAPSE_AGENT_NAME=frontend claude
```

## Security decisions

- Broker binds 127.0.0.1 only, auth token required on all endpoints (except /health and /pending)
- Agent names validated: `^[a-zA-Z0-9_-]+$` (prevents shell injection in hook/status scripts)
- Auth via Authorization header (not URL query params) for GET requests
- No CORS headers (prevents browser-based probing)
- Shell scripts use Node for JSON parsing (no jq dependency)

## Publishing

- npm package name: `agent-synapse`
- GitHub: Projects-with-Babajide/agent-synapse (private, planned open source)
- Future: publish as Claude Code plugin to remove `--dangerously-load-development-channels` flag
