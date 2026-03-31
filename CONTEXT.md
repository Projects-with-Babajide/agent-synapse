# Synapse — Named Agent Messaging for Claude Code

## What This Is

Synapse is a lightweight MCP server that lets multiple Claude Code sessions communicate via named message queues. Each session registers as a named agent (e.g. "backend", "frontend"), and agents can send messages to each other by name. Messages are queued (FIFO) and polled — no interruptions, no real-time push required.

The name comes from the Cerebro project universe (brain theme) — a synapse is the gap between neurons where signals pass.

## Problem

When working with separate Claude Code sessions on related repos (e.g. a backend and frontend for the same project), there's no built-in way for one agent to send context to another. Today you copy-paste between terminals. Synapse automates that handoff.

## How It Works

```
Terminal 1                    Terminal 2
+-----------+                 +-----------+
| Agent:    |   send_message  | Agent:    |
| "backend" | ──────────────> | "frontend"|
|           |   (file queue)  |           |
+-----------+                 +-----------+
      |                             |
      v                             v
~/.claude-agents/             ~/.claude-agents/
  queues/backend.jsonl          queues/frontend.jsonl
  registry.json                 registry.json
```

1. Each session registers as a named agent via `register_agent` tool
2. Agent A finishes work, calls `send_message(to: "frontend", content: "...")`
3. Message is appended to `~/.claude-agents/queues/frontend.jsonl`
4. Agent B finishes its current task, calls `check_messages`
5. Agent B sees the message, asks the user whether to process it now
6. Messages are processed in arrival order (FIFO)

## Agent Behavior Protocol

Add this to `CLAUDE.md` or system prompt for each session:

```markdown
## Message Queue Protocol

You are a named agent. At the start of every session, register yourself using `register_agent`.

After completing any user-requested task:
1. Call `check_messages` to see if other agents sent you work
2. If messages exist, show them to the user and ask: "I have a message from [agent]. Process it now?"
3. Process messages in the order they arrived (oldest first)
4. If no messages, tell the user you're ready for the next task

When the user says "send this to [name]", use `send_message` with the relevant context.
```

## MCP Server Design

### File Structure

```
~/.claude-agents/
  server.ts              # MCP server source
  registry.json          # { "backend": { registered_at, status }, ... }
  queues/
    backend.jsonl        # one JSON object per line, FIFO
    frontend.jsonl
```

### Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `register_agent` | `name: string` | Register this session as a named agent. Creates queue file if needed. |
| `send_message` | `to: string, content: string, from: string` | Append a message to the target agent's queue. |
| `check_messages` | `name: string` | Read and drain all pending messages for this agent. Returns them in arrival order. |
| `list_agents` | (none) | List all registered agents and their status. |

### Message Format (each line in the JSONL queue)

```json
{
  "from": "backend",
  "content": "POST /api/v1/meetings returns { items: Meeting[], next_cursor: string | null, has_more: boolean }. Zod schema is in src/app/api/v1/meetings/schemas.ts. See the route handler for full request/response shapes.",
  "timestamp": "2026-03-31T14:22:00.000Z"
}
```

### MCP Server Implementation

```typescript
// ~/.claude-agents/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "fs";
import path from "path";

const BASE = path.join(process.env.HOME!, ".claude-agents");
const QUEUES = path.join(BASE, "queues");
const REGISTRY = path.join(BASE, "registry.json");

fs.mkdirSync(QUEUES, { recursive: true });

function getRegistry() {
  if (!fs.existsSync(REGISTRY)) return {};
  return JSON.parse(fs.readFileSync(REGISTRY, "utf-8"));
}

function saveRegistry(reg: any) {
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
}

const server = new Server(
  { name: "agent-messenger", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "register_agent",
      description: "Register this session as a named agent",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Agent name (e.g. 'backend', 'frontend')" } },
        required: ["name"],
      },
    },
    {
      name: "send_message",
      description: "Send a message to another named agent's queue",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Target agent name" },
          content: { type: "string", description: "Message content" },
          from: { type: "string", description: "Sender agent name" },
        },
        required: ["to", "content", "from"],
      },
    },
    {
      name: "check_messages",
      description: "Check and retrieve pending messages for this agent (drains the queue)",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "This agent's name" } },
        required: ["name"],
      },
    },
    {
      name: "list_agents",
      description: "List all registered agents",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "register_agent") {
    const reg = getRegistry();
    reg[args.name] = {
      registered_at: new Date().toISOString(),
      status: "active",
    };
    saveRegistry(reg);
    const queueFile = path.join(QUEUES, `${args.name}.jsonl`);
    if (!fs.existsSync(queueFile)) fs.writeFileSync(queueFile, "");
    return { content: [{ type: "text", text: `Registered as "${args.name}"` }] };
  }

  if (name === "send_message") {
    const reg = getRegistry();
    if (!reg[args.to]) {
      return {
        content: [{ type: "text", text: `Agent "${args.to}" is not registered. Known agents: ${Object.keys(reg).join(", ") || "none"}` }],
      };
    }
    const queueFile = path.join(QUEUES, `${args.to}.jsonl`);
    const message = JSON.stringify({
      from: args.from,
      content: args.content,
      timestamp: new Date().toISOString(),
    });
    fs.appendFileSync(queueFile, message + "\n");
    return { content: [{ type: "text", text: `Message queued for "${args.to}"` }] };
  }

  if (name === "check_messages") {
    const queueFile = path.join(QUEUES, `${args.name}.jsonl`);
    if (!fs.existsSync(queueFile)) {
      return { content: [{ type: "text", text: "No messages" }] };
    }
    const raw = fs.readFileSync(queueFile, "utf-8").trim();
    if (!raw) {
      return { content: [{ type: "text", text: "No messages" }] };
    }
    // Drain queue after reading
    fs.writeFileSync(queueFile, "");
    const messages = raw.split("\n").map((line) => JSON.parse(line));
    return {
      content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
    };
  }

  if (name === "list_agents") {
    const reg = getRegistry();
    const agents = Object.entries(reg).map(
      ([name, info]: [string, any]) => `${name} (registered ${info.registered_at}, ${info.status})`
    );
    return {
      content: [{ type: "text", text: agents.length ? agents.join("\n") : "No agents registered" }],
    };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
});

const transport = new StdioServerTransport();
server.connect(transport);
```

## Claude Code Configuration

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "agent-messenger": {
      "command": "npx",
      "args": ["tsx", "~/.claude-agents/server.ts"]
    }
  }
}
```

This makes the tools available in every Claude Code session globally.

## Usage Example

### Terminal 1 (backend agent)

```
You: Register as "backend"
Claude: Registered as "backend"

You: Implement the meetings endpoint per ticket C1A-12
Claude: [works on it... finishes]
        Done. The endpoint is at POST /api/v1/meetings.
        Let me check for messages... No messages.

You: Send the API contract to "frontend"
Claude: [calls send_message] Message queued for "frontend"
```

### Terminal 2 (frontend agent)

```
You: Register as "frontend"
Claude: Registered as "frontend"

You: Check messages
Claude: You have 1 message from "backend" (received 2026-03-31T14:22:00Z):
        "POST /api/v1/meetings returns { items, next_cursor, has_more }..."

        Should I process this now?

You: Yes, build the meetings list page
Claude: [builds UI based on the API contract]
```

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| File-based queues (JSONL) | Zero dependencies, works everywhere, easy to debug |
| Drain on read | Simple FIFO — once read, messages are consumed. No ack/nack complexity. |
| No push/interruption | Agents poll when idle. Avoids complexity of interrupting mid-task. |
| MCP server (not hooks) | Tools are explicit and visible. Agent decides when to check, not the system. |
| Global settings.json | Available in every session without per-project config. |
| Registry tracks agents | `send_message` can validate the target exists before queuing. |

## Future Ideas

- **Peek without drain** — `peek_messages` tool that reads without consuming
- **Message acknowledgment** — agent marks messages as processed explicitly
- **Priority levels** — urgent messages surface first
- **Agent status** — "busy", "idle", "waiting" so senders know what to expect
- **Conversation context forwarding** — attach file diffs or code snippets as structured payloads
- **TTL on messages** — auto-expire old messages after N hours
- **Web dashboard** — simple HTML page showing agent status and queue depths
