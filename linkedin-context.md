# LinkedIn post context — Agent Synapse

## What Agent Synapse is

Agent Synapse is an open-source Claude Code plugin that lets multiple Claude Code sessions talk to each other by name. Each session registers as a named agent (e.g. `backend`, `frontend`, `fixer`). Agents can send messages to each other, check their inbox, and see who's online — all from inside their Claude Code session via MCP tools.

It works in two modes:
- **Standard mode** — a PostToolUse hook nudges Claude to check messages after every tool call
- **Channel mode** — messages push instantly via SSE, no polling needed

Setup is one command: `agent-synapse setup`. After that, launch any Claude session with `SYNAPSE_AGENT_NAME=myagent claude` and it's on the network.

## Why it's cool

Most multi-agent setups are hierarchical and synchronous — one orchestrator spawns workers and waits. Synapse is async and peer-to-peer: you send a message and immediately move on. Agents work in parallel, in different repos, with their own context windows, tools, and specializations. A human can watch and intervene in any session independently.

It also handles the real-world messiness of multi-agent work: messages queue when an agent is offline and deliver when they reconnect. Nothing is lost between sessions.

## Example

A 2-day Cerebro orchestration session ran 5 agents over Synapse:
- `cerebro-backend` — orchestrator: architecture decisions, ticket management, coordination
- `cerebro-builder` — implements features via `/ship-ticket`
- `cerebro-fixer` — targeted bug fixes
- `cerebro-frontend` — reports issues, requests API changes
- `orumilos-frontdesk` — external platform team

The flow: frontend reports a bug → orchestrator investigates → sends fix to fixer → fixer ships → orchestrator notifies frontend. Clean chain of custody. The orchestrator could handle all of this without blocking — while waiting for the builder to finish a ticket, it was querying Supabase, checking Vercel deploys, and responding to the external team.

Result: 25+ PRs merged, 20+ tickets completed in two days.

## Agent Synapse vs Claude Code Agent Teams

Claude Code recently shipped an experimental "agent teams" feature (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). It's worth knowing how Synapse differs.

**What agent teams has:**
- Built-in shared task list with dependency tracking — teammates self-claim unblocked work
- Automatic idle notifications — lead is notified when a teammate finishes, no polling
- Native tmux/iTerm2 UI with split-pane display
- Broadcast messaging to all teammates at once

**What Synapse has that agent teams doesn't:**
- **Cross-session persistence** — messages queue across `/clear` and session restarts; agent teams don't survive `/resume`
- **No mandatory hierarchy** — Synapse is peer-to-peer; agent teams enforce a lead/teammate structure
- **Cross-project** — Synapse agents can work in completely different repos simultaneously
- **No experimental flag required** — works today with standard MCP

**When to use which:**
- Agent teams: single coordinated session on one project, you want native UX and a shared task list
- Synapse: longer-running coordination, cross-project, or externally-triggered workflows where persistence and topology flexibility matter
- They can complement each other — Synapse as the persistent message bus between teams, agent teams handling internal task coordination within each team
