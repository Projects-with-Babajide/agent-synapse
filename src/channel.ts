import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { getConfig, resolveAgentName } from "./config.js";
import type { BrokerConfig, SynapseMessage } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Broker communication ---

function brokerUrl(config: BrokerConfig, pathname: string): string {
  return `http://${config.host}:${config.port}${pathname}`;
}

async function brokerPost(
  config: BrokerConfig,
  pathname: string,
  body: Record<string, unknown>
): Promise<{ status: number; data: unknown }> {
  const payload = JSON.stringify({ ...body, token: config.token });
  const url = new URL(brokerUrl(config, pathname));

  return new Promise((resolve, reject) => {
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
  });
}

async function brokerGet(
  config: BrokerConfig,
  pathname: string
): Promise<{ status: number; data: unknown }> {
  const url = new URL(brokerUrl(config, pathname));

  return new Promise((resolve, reject) => {
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
  });
}

// --- Broker auto-start ---

async function isBrokerRunning(config: BrokerConfig): Promise<boolean> {
  try {
    const { status } = await brokerGet(config, "/health");
    return status === 200;
  } catch {
    return false;
  }
}

async function ensureBroker(config: BrokerConfig): Promise<void> {
  if (await isBrokerRunning(config)) return;

  const brokerScript = path.join(__dirname, "broker.js");
  const child = spawn("node", [brokerScript], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  // Wait up to 3 seconds for broker to start
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isBrokerRunning(config)) return;
  }

  throw new Error("Failed to auto-start broker");
}

// --- SSE listener ---

function connectSSE(
  getConfig: () => BrokerConfig,
  agentName: string,
  onMessage: (msg: SynapseMessage) => void
): void {
  function connect() {
    // Re-read config each time we connect — token may have changed
    const config = getConfig();
    const sseUrl = new URL(brokerUrl(config, `/stream/${agentName}`));

    const req = http.get(
      {
        hostname: sseUrl.hostname,
        port: sseUrl.port,
        path: sseUrl.pathname,
        headers: { Authorization: `Bearer ${config.token}` },
      },
      (res) => {
      // Auth failure — config may have changed, re-register and retry
      if (res.statusCode === 401) {
        res.resume();
        setTimeout(async () => {
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

      // Disable timeout on the response socket — SSE connections are long-lived
      res.socket?.setTimeout(0);
      res.socket?.setKeepAlive(true);

      let buffer = "";

      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const message = JSON.parse(line.slice(6)) as SynapseMessage;
              onMessage(message);
            } catch {
              // Skip malformed messages
            }
          }
        }
      });

      res.on("end", () => {
        // Reconnect after a delay
        setTimeout(connect, 2000);
      });

      res.on("error", () => {
        setTimeout(connect, 2000);
      });
    });

    // Disable timeout on the request itself
    req.setTimeout(0);

    req.on("error", () => {
      // Broker might be down, retry
      setTimeout(connect, 5000);
    });
  }

  connect();
}

// --- Main ---

async function main(): Promise<void> {
  const config = getConfig();
  if (!config) {
    console.error(
      "No config found. Run 'claude-synapse setup' first."
    );
    process.exit(1);
  }

  let agentName = resolveAgentName();
  let sseAbort: (() => void) | null = null;

  // Auto-start broker if needed
  await ensureBroker(config);

  // Register with broker
  await brokerPost(config, "/register", { name: agentName });

  // Set up MCP server with channel capability
  const mcp = new Server(
    { name: "synapse", version: "0.1.0" },
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

  // Helper to start/restart SSE listener
  function startSSE(name: string) {
    if (sseAbort) sseAbort();
    const abortController = { aborted: false };
    sseAbort = () => { abortController.aborted = true; };
    connectSSE(() => getConfig()!, name, async (msg) => {
      if (abortController.aborted) return;
      try {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: msg.content,
            meta: {
              from: msg.from,
              timestamp: msg.timestamp,
            },
          },
        });
      } catch {
        // If notification fails, message is lost — acceptable for v1
      }
    });
  }

  // Tools
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "register_agent",
        description:
          "Register this session as a named Synapse agent. Use this if SYNAPSE_AGENT_NAME was not set when starting the session.",
        inputSchema: {
          type: "object" as const,
          properties: {
            name: {
              type: "string",
              description:
                "Agent name (e.g. 'backend', 'frontend', 'cerebro-backend')",
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
            to: {
              type: "string",
              description: "Target agent name",
            },
            content: {
              type: "string",
              description: "Message content",
            },
          },
          required: ["to", "content"],
        },
      },
      {
        name: "check_messages",
        description:
          "Check for and retrieve pending messages from other agents. Call this regularly or when prompted by the hook.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "list_agents",
        description: "List all registered Synapse agents and their status",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "register_agent") {
      const newName = (args as Record<string, string>).name;
      try {
        await brokerPost(config, "/register", { name: newName });
        agentName = newName;
        // Reconnect SSE with new name
        startSSE(newName);
        return {
          content: [
            {
              type: "text" as const,
              text: `Registered as "${newName}". Now listening for messages.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to register: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }

    if (name === "send_message") {
      const to = (args as Record<string, string>).to;
      const content = (args as Record<string, string>).content;

      try {
        const { status, data } = await brokerPost(config, "/send", {
          from: agentName,
          to,
          content,
        });

        if (status === 200) {
          const result = data as { delivered: boolean };
          return {
            content: [
              {
                type: "text" as const,
                text: result.delivered
                  ? `Message delivered to "${to}"`
                  : `Message queued for "${to}" (they'll receive it when they connect)`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to send: ${JSON.stringify(data)}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }

    if (name === "check_messages") {
      try {
        const { data } = await brokerGet(config, `/drain/${agentName}`);
        const result = data as {
          messages: Array<{ from: string; content: string; timestamp: string }>;
        };

        if (!result.messages || result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No pending messages." }],
          };
        }

        const formatted = result.messages
          .map((m) => `[From ${m.from} at ${m.timestamp}]\n${m.content}`)
          .join("\n\n---\n\n");
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} message(s) received:\n\n${formatted}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }

    if (name === "list_agents") {
      try {
        const { data } = await brokerGet(config, "/agents");
        const result = data as {
          agents: Array<{
            name: string;
            status: string;
            registered_at: string;
          }>;
        };

        if (!result.agents || result.agents.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No agents registered" }],
          };
        }

        const lines = result.agents.map(
          (a) => `${a.name} (${a.status}, registered ${a.registered_at})`
        );
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing agents: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }

    return {
      content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
    };
  });

  // Start listening for messages via SSE
  startSSE(agentName);

  // Connect to Claude Code via stdio
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch((err) => {
  console.error("Synapse channel failed to start:", err);
  process.exit(1);
});
