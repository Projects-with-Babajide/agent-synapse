import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfig, resolveAgentName, spawnBroker, createAgent } from "./config.js";
import type { BrokerConfig, SSEHint } from "./types.js";
import { VERSION, HTTP_TIMEOUT_MS } from "./types.js";

// --- Session name file (keyed by Claude Code's PID so multiple sessions don't collide) ---

const SESSION_FILE = path.join(
  os.homedir(),
  ".claude-synapse",
  `session-${process.ppid}.name`
);

function writeSessionName(name: string): void {
  try {
    fs.writeFileSync(SESSION_FILE, name, { mode: 0o600 });
  } catch {
    // Non-fatal
  }
}

function cleanupSessionFile(): void {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch {
    // Non-fatal
  }
}

process.on("exit", cleanupSessionFile);
process.on("SIGINT", () => { cleanupSessionFile(); process.exit(0); });
process.on("SIGTERM", () => { cleanupSessionFile(); process.exit(0); });

// --- Broker communication ---

function brokerUrl(config: BrokerConfig, pathname: string): string {
  return `http://${config.host}:${config.port}${pathname}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Request timed out")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function brokerPost(
  config: BrokerConfig,
  pathname: string,
  body: Record<string, unknown>
): Promise<{ status: number; data: unknown }> {
  const payload = JSON.stringify({ ...body, token: config.token });
  const url = new URL(brokerUrl(config, pathname));

  return withTimeout(
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve({ status: res.statusCode ?? 500, data: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode ?? 500, data });
            }
          });
        }
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    }),
    HTTP_TIMEOUT_MS
  );
}

async function brokerGet(
  config: BrokerConfig,
  pathname: string
): Promise<{ status: number; data: unknown }> {
  const url = new URL(brokerUrl(config, pathname));

  return withTimeout(
    new Promise((resolve, reject) => {
      http
        .get(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            headers: { Authorization: `Bearer ${config.token}` },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
              try {
                resolve({ status: res.statusCode ?? 500, data: JSON.parse(data) });
              } catch {
                resolve({ status: res.statusCode ?? 500, data });
              }
            });
          }
        )
        .on("error", reject);
    }),
    HTTP_TIMEOUT_MS
  );
}

// --- Broker auto-start ---

async function ensureBroker(config: BrokerConfig): Promise<void> {
  try {
    const res = await brokerGet(config, "/health");
    if (res.status === 200) return;
  } catch {
    // Not running
  }

  const result = await spawnBroker();
  if (!result.started && !result.pid) {
    throw new Error(result.message);
  }
}

// --- SSE listener ---

function connectSSE(
  getConfig: () => BrokerConfig,
  agentName: string,
  onMessage: (hint: SSEHint) => void
): { destroy: () => void } {
  let destroyed = false;
  let currentReq: http.ClientRequest | null = null;

  function connect() {
    if (destroyed) return;

    const config = getConfig();

    // Idempotent re-register before opening SSE — heals broker restarts and
    // refreshes the agents map after any drop/reconnect cycle.
    brokerPost(config, "/register", { name: agentName }).catch(() => {
      // Non-fatal: if broker is down, SSE attempt below will also fail and we'll retry
    });

    const sseUrl = new URL(brokerUrl(config, `/stream/${agentName}`));

    const req = http.get(
      {
        hostname: sseUrl.hostname,
        port: sseUrl.port,
        path: sseUrl.pathname,
        headers: { Authorization: `Bearer ${config.token}` },
      },
      (res) => {
        if (destroyed) { res.destroy(); return; }

        // Auth failure — re-register and retry
        if (res.statusCode === 401) {
          res.resume();
          setTimeout(async () => {
            if (destroyed) return;
            try {
              const freshConfig = getConfig();
              await brokerPost(freshConfig, "/register", { name: agentName });
            } catch {
              // Broker might be down
            }
            connect();
          }, 2000);
          return;
        }

        res.socket?.setTimeout(0);
        res.socket?.setKeepAlive(true);

        let buffer = "";

        res.on("data", (chunk: Buffer) => {
          if (destroyed) return;
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const hint = JSON.parse(line.slice(6)) as SSEHint;
                onMessage(hint);
              } catch {
                // Skip malformed messages
              }
            }
          }
        });

        res.on("end", () => {
          if (!destroyed) setTimeout(connect, 2000);
        });

        res.on("error", () => {
          if (!destroyed) setTimeout(connect, 2000);
        });
      }
    );

    currentReq = req;
    req.setTimeout(0);

    req.on("error", () => {
      if (!destroyed) setTimeout(connect, 5000);
    });
  }

  connect();

  return {
    destroy() {
      destroyed = true;
      if (currentReq) {
        currentReq.destroy();
        currentReq = null;
      }
    },
  };
}

// --- Tool helpers ---

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

async function safeCall(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return textResult(
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// --- Main ---

async function main(): Promise<void> {
  const initialConfig = getConfig();
  if (!initialConfig) {
    console.error("No config found. Run 'agent-synapse setup' first.");
    process.exit(1);
  }

  // Fresh config reader for tool handlers
  function freshConfig(): BrokerConfig {
    return getConfig()!;
  }

  let agentName = resolveAgentName();
  let sseHandle: { destroy: () => void } | null = null;

  await ensureBroker(initialConfig);
  await brokerPost(initialConfig, "/register", { name: agentName });
  writeSessionName(agentName);

  const mcp = new Server(
    { name: "synapse", version: VERSION },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions: [
        `You are connected to Synapse as agent "${agentName}".`,
        "When you see a '[Synapse: N pending message(s)]' notice, immediately call check_messages to retrieve them.",
        "Use send_message to send messages to other agents.",
        "Use list_agents to see who is connected.",
        "Use check_messages to pull pending messages from other agents.",
        "If not registered yet, use register_agent to set your agent name.",
      ].join(" "),
    }
  );

  function startSSE(name: string) {
    if (sseHandle) sseHandle.destroy();
    sseHandle = connectSSE(freshConfig, name, async (hint) => {
      // Try to push a channel notification — Claude Code may surface this to the model
      try {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: `[Synapse: new message from ${hint.from} — use check_messages to read it]`,
            meta: { from: hint.from, timestamp: hint.timestamp },
          },
        });
      } catch {
        // If channel notifications aren't supported, the UserPromptSubmit/PostToolUse hooks
        // will still catch pending messages
      }
    });
  }

  // Tool definitions
  const toolDefs = [
    {
      name: "register_agent",
      description:
        "Register this session as a named Synapse agent. Use this if SYNAPSE_AGENT_NAME was not set.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "Agent name (e.g. 'backend', 'frontend')",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "unregister_agent",
      description:
        "Remove this session's Synapse registration. The agent disappears from list_agents and stops receiving messages. Use when the session no longer wants to be reachable.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "rename_agent",
      description:
        "Rename this session's Synapse identity to a new name. If the session is already registered, the registration metadata and any pending queued messages are migrated. If the session is not registered, this registers it with the new name (equivalent to register_agent).",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "New agent name",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "send_message",
      description: "Send a message to another Claude Code agent",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Target agent name" },
          content: { type: "string", description: "Message content" },
        },
        required: ["to", "content"],
      },
    },
    {
      name: "check_messages",
      description:
        "Check for and retrieve pending messages from other agents.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "list_agents",
      description: "List all registered Synapse agents and their status",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "create_agent",
      description:
        "Scaffold a new named agent in the current project. Creates an agents/<name>/CLAUDE.md with the agent's identity and a Synapse self-registration instruction so the agent registers automatically when its session starts.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "Agent name (e.g. 'backend', 'data-pipeline')",
          },
          description: {
            type: "string",
            description: "What this agent does — written into its CLAUDE.md",
          },
          dir: {
            type: "string",
            description:
              "Base directory to create the agent in (default: current working directory)",
          },
        },
        required: ["name", "description"],
      },
    },
  ];

  // Tool handlers
  const handlers: Record<
    string,
    (args: Record<string, string>) => Promise<ToolResult>
  > = {
    async register_agent(args) {
      const newName = args.name;
      await brokerPost(freshConfig(), "/register", { name: newName });
      agentName = newName;
      writeSessionName(newName);
      startSSE(newName);
      return textResult(`Registered as "${newName}". Now listening for messages.`);
    },

    async unregister_agent() {
      const config = freshConfig();
      const { status, data } = await brokerPost(config, "/unregister", {
        name: agentName,
      });

      if (status !== 200) {
        return textResult(`Failed to unregister: ${JSON.stringify(data)}`);
      }

      // Stop the local SSE so we don't auto-reconnect under the dropped name
      if (sseHandle) {
        sseHandle.destroy();
        sseHandle = null;
      }
      cleanupSessionFile();

      return textResult(
        `Unregistered "${agentName}". This session is no longer reachable via Synapse. Call register_agent to come back online.`
      );
    },

    async rename_agent(args) {
      const newName = args.name;
      if (!newName) {
        return textResult("Error: name is required");
      }

      const config = freshConfig();
      const { status, data } = await brokerPost(config, "/rename", {
        from: agentName,
        to: newName,
      });

      if (status !== 200) {
        return textResult(`Failed to rename: ${JSON.stringify(data)}`);
      }

      const result = data as { renamed: { from: string | null; to: string }; registered: boolean };

      agentName = newName;
      writeSessionName(newName);
      startSSE(newName);

      return textResult(
        result.registered
          ? `Registered as "${newName}" (no prior registration found). Now listening for messages.`
          : `Renamed from "${result.renamed.from}" to "${newName}". Pending messages and identity migrated.`
      );
    },

    async send_message(args) {
      const config = freshConfig();
      const { status, data } = await brokerPost(config, "/send", {
        from: agentName,
        to: args.to,
        content: args.content,
      });

      if (status === 200) {
        const result = data as { queued: boolean; notified: boolean };
        return textResult(
          result.notified
            ? `Message sent to "${args.to}" — they'll be prompted to check messages`
            : `Message queued for "${args.to}" (they'll receive it when they connect)`
        );
      }

      return textResult(`Failed to send: ${JSON.stringify(data)}`);
    },

    async check_messages() {
      const config = freshConfig();
      const { data } = await brokerGet(config, `/drain/${agentName}`);
      const result = data as {
        messages: Array<{ from: string; content: string; timestamp: string }>;
      };

      if (!result.messages || result.messages.length === 0) {
        return textResult("No pending messages.");
      }

      const formatted = result.messages
        .map((m) => `[From ${m.from} at ${m.timestamp}]\n${m.content}`)
        .join("\n\n---\n\n");
      return textResult(
        `${result.messages.length} message(s) received:\n\n${formatted}`
      );
    },

    async list_agents() {
      const config = freshConfig();
      const { data } = await brokerGet(config, "/agents");
      const result = data as {
        agents: Array<{ name: string; status: string; registered_at: string }>;
      };

      if (!result.agents || result.agents.length === 0) {
        return textResult("No agents registered");
      }

      const lines = result.agents.map(
        (a) => `${a.name} (${a.status}, registered ${a.registered_at})`
      );
      return textResult(lines.join("\n"));
    },

    async create_agent(args) {
      const baseDir = args.dir || process.cwd();
      const result = createAgent(args.name, args.description, baseDir);

      if (!result.created) {
        return textResult(result.message);
      }

      return textResult(
        `${result.message}\n\nTo start this agent, open a new terminal and run:\n  cd ${result.agentDir} && claude\n\nThe agent will register itself as "${args.name}" automatically when the session starts.`
      );
    },
  };

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefs,
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = handlers[name];
    if (!handler) return textResult(`Unknown tool: ${name}`);
    return safeCall(() => handler(args as Record<string, string>));
  });

  startSSE(agentName);

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch((err) => {
  console.error("Synapse channel failed to start:", err);
  process.exit(1);
});
