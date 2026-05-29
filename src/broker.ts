import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PORT,
  DEFAULT_HOST,
  MAX_MESSAGE_SIZE,
  MAX_QUEUE_DEPTH,
  KEEPALIVE_INTERVAL_MS,
  PRESENCE_TTL_MS,
} from "./types.js";
import type { SynapseMessage, SSEHint, Agent } from "./types.js";
import { isValidAgentName } from "./config.js";
import {
  getConfig,
  getQueuesPath,
  writePidFile,
  removePidFile,
} from "./config.js";

// --- In-memory state ---

const agents = new Map<string, Agent>();
const queues = new Map<string, SynapseMessage[]>();
const sseClients = new Map<string, http.ServerResponse[]>();

// --- Persistence ---

function loadQueues(): void {
  const queuesPath = getQueuesPath();
  if (!fs.existsSync(queuesPath)) return;

  const raw = fs.readFileSync(queuesPath, "utf-8").trim();
  if (!raw) return;

  for (const line of raw.split("\n")) {
    try {
      const entry = JSON.parse(line) as { to: string; message: SynapseMessage };
      if (!queues.has(entry.to)) queues.set(entry.to, []);
      queues.get(entry.to)!.push(entry.message);
    } catch {
      // Skip malformed lines
    }
  }
}

function persistQueues(): void {
  const queuesPath = getQueuesPath();
  const lines: string[] = [];
  for (const [to, messages] of queues) {
    for (const message of messages) {
      lines.push(JSON.stringify({ to, message }));
    }
  }
  fs.writeFileSync(queuesPath, lines.length ? lines.join("\n") + "\n" : "", {
    mode: 0o600,
  });
}

// --- Helpers ---

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_MESSAGE_SIZE) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function parseUrl(req: http.IncomingMessage): { pathname: string; searchParams: URLSearchParams } {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

function validateToken(token: string | null, expectedToken: string): boolean {
  return token === expectedToken;
}

// Refresh an agent's last-seen marker. Called on any authenticated activity so
// presence reflects reachability, not just whether an SSE socket is open.
function touch(name: string): void {
  const agent = agents.get(name);
  if (agent) agent.last_seen = new Date().toISOString();
}

// --- SSE notification ---

function notifyViaSSE(to: string, message: SynapseMessage): boolean {
  const clients = sseClients.get(to);
  if (clients && clients.length > 0) {
    // Send a lightweight hint — the agent should call check_messages to retrieve
    const hint: SSEHint = { type: "message_available", from: message.from, timestamp: message.timestamp };
    const data = `data: ${JSON.stringify(hint)}\n\n`;
    for (const client of clients) {
      client.write(data);
    }
    return true;
  }
  return false;
}

// --- Server ---

export function startBroker(): void {
  const config = getConfig();
  if (!config) {
    console.error("No config found. Run 'claude-synapse setup' first.");
    process.exit(1);
  }

  loadQueues();

  const server = http.createServer(async (req, res) => {
    const { pathname, searchParams } = parseUrl(req);
    const method = req.method ?? "GET";

    // No CORS — this API should only be called by local processes, not browsers

    // --- GET /health (no auth) ---
    if (method === "GET" && pathname === "/health") {
      json(res, 200, { status: "ok", agents: agents.size });
      return;
    }

    // --- Auth for all other endpoints ---
    let token: string | null = null;
    if (method === "GET") {
      // Accept token from Authorization header or query param (fallback)
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        token = authHeader.slice(7);
      } else {
        token = searchParams.get("token");
      }
    } else {
      // Token comes in the request body for POST requests
    }

    // --- GET /agents ---
    if (method === "GET" && pathname === "/agents") {
      if (!validateToken(token, config.token)) {
        json(res, 401, { error: "Invalid token" });
        return;
      }
      // Derive presence: an agent is "connected" if it has a live SSE socket OR
      // the broker has seen activity from it within PRESENCE_TTL_MS. The stored
      // status flag only tracks the SSE socket, which drops on sleep/network blips
      // even though the agent is still alive and reachable via the queue.
      const now = Date.now();
      const list = Array.from(agents.values()).map((a) => {
        const hasLiveSSE = (sseClients.get(a.name)?.length ?? 0) > 0;
        const lastSeenMs = Date.parse(a.last_seen);
        const recentlySeen =
          !Number.isNaN(lastSeenMs) && now - lastSeenMs < PRESENCE_TTL_MS;
        return {
          ...a,
          status: hasLiveSSE || recentlySeen ? "connected" : "disconnected",
        };
      });
      json(res, 200, { agents: list });
      return;
    }

    // --- GET /pending/:name (no auth — used by status line script) ---
    if (method === "GET" && pathname.startsWith("/pending/")) {
      const agentName = pathname.slice("/pending/".length);
      const count = queues.get(agentName)?.length ?? 0;
      json(res, 200, { agent: agentName, pending: count });
      return;
    }

    // --- GET /drain/:name — return and clear queued messages ---
    if (method === "GET" && pathname.startsWith("/drain/")) {
      if (!validateToken(token, config.token)) {
        json(res, 401, { error: "Invalid token" });
        return;
      }
      const agentName = pathname.slice("/drain/".length);
      touch(agentName);
      const messages = queues.get(agentName) ?? [];
      queues.delete(agentName);
      if (messages.length > 0) persistQueues();
      json(res, 200, { agent: agentName, messages });
      return;
    }

    // --- GET /stream/:name ---
    if (method === "GET" && pathname.startsWith("/stream/")) {
      if (!validateToken(token, config.token)) {
        json(res, 401, { error: "Invalid token" });
        return;
      }

      const agentName = pathname.slice("/stream/".length);
      if (!agentName) {
        json(res, 400, { error: "Missing agent name" });
        return;
      }

      // Set up SSE
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(":connected\n\n");

      // Register SSE client
      if (!sseClients.has(agentName)) sseClients.set(agentName, []);
      sseClients.get(agentName)!.push(res);

      // Reflect live SSE as connected status (covers reconnect after drop)
      const reconnectedAgent = agents.get(agentName);
      if (reconnectedAgent) reconnectedAgent.status = "connected";
      touch(agentName);

      // Hint about any queued messages, but do NOT drain them here. SSE is a
      // notify-only channel: the client parses every frame as an SSEHint and
      // retrieves bodies via check_messages → /drain. Writing full message
      // bodies here and deleting the queue (as this used to) silently dropped
      // the content — the client never reads bodies off the stream, so the
      // message became unreadable while the notification still fired.
      const pending = queues.get(agentName);
      if (pending && pending.length > 0) {
        for (const msg of pending) {
          const hint: SSEHint = {
            type: "message_available",
            from: msg.from,
            timestamp: msg.timestamp,
          };
          res.write(`data: ${JSON.stringify(hint)}\n\n`);
        }
      }

      // Keepalive
      const keepalive = setInterval(() => {
        res.write(":keepalive\n\n");
      }, KEEPALIVE_INTERVAL_MS);

      // Cleanup on disconnect
      req.on("close", () => {
        clearInterval(keepalive);
        const clients = sseClients.get(agentName);
        if (clients) {
          const idx = clients.indexOf(res);
          if (idx !== -1) clients.splice(idx, 1);
          if (clients.length === 0) {
            sseClients.delete(agentName);
            // Mark agent as disconnected
            const agent = agents.get(agentName);
            if (agent) agent.status = "disconnected";
          }
        }
      });

      return;
    }

    // --- POST endpoints (token in body) ---
    if (method === "POST") {
      let body: string;
      try {
        body = await readBody(req);
      } catch (err) {
        json(res, 413, { error: "Payload too large" });
        return;
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(body);
      } catch {
        json(res, 400, { error: "Invalid JSON" });
        return;
      }

      if (!validateToken(payload.token as string | null, config.token)) {
        json(res, 401, { error: "Invalid token" });
        return;
      }

      // --- POST /register ---
      if (pathname === "/register") {
        const name = payload.name as string;
        if (!name) {
          json(res, 400, { error: "Missing agent name" });
          return;
        }
        if (!isValidAgentName(name)) {
          json(res, 400, { error: "Invalid agent name. Use only letters, numbers, hyphens, and underscores (max 64 chars)." });
          return;
        }

        const nowIso = new Date().toISOString();
        agents.set(name, {
          name,
          status: "connected",
          registered_at: nowIso,
          last_seen: nowIso,
        });

        json(res, 200, { registered: name });
        return;
      }

      // --- POST /send ---
      if (pathname === "/send") {
        const from = payload.from as string;
        const to = payload.to as string;
        const content = payload.content as string;

        if (!from || !to || !content) {
          json(res, 400, { error: "Missing from, to, or content" });
          return;
        }

        // A sending agent is provably alive — refresh its presence.
        touch(from);

        if (Buffer.byteLength(content, "utf-8") > MAX_MESSAGE_SIZE) {
          json(res, 413, { error: "Message too large" });
          return;
        }

        const message: SynapseMessage = {
          from,
          to,
          content,
          timestamp: new Date().toISOString(),
        };

        // Always queue the message — check_messages is the reliable delivery path
        if (!queues.has(to)) queues.set(to, []);
        const queue = queues.get(to)!;

        if (queue.length >= MAX_QUEUE_DEPTH) {
          json(res, 429, { error: "Queue full for target agent" });
          return;
        }

        queue.push(message);
        persistQueues();

        // Notify via SSE as a hint (agent still needs to call check_messages)
        const notified = notifyViaSSE(to, message);

        json(res, 200, {
          sent: true,
          queued: true,
          notified,
          to,
        });
        return;
      }

      // --- POST /unregister ---
      if (pathname === "/unregister") {
        const name = payload.name as string;
        if (!name) {
          json(res, 400, { error: "Missing agent name" });
          return;
        }

        const wasRegistered = agents.delete(name);

        const clients = sseClients.get(name);
        if (clients) {
          for (const client of clients) {
            try { client.end(); } catch {}
          }
          sseClients.delete(name);
        }

        json(res, 200, { unregistered: name, wasRegistered });
        return;
      }

      // --- POST /rename ---
      if (pathname === "/rename") {
        const from = payload.from as string | undefined;
        const to = payload.to as string;

        if (!to) {
          json(res, 400, { error: "Missing new name" });
          return;
        }
        if (!isValidAgentName(to)) {
          json(res, 400, { error: "Invalid agent name. Use only letters, numbers, hyphens, and underscores (max 64 chars)." });
          return;
        }

        const existing = from ? agents.get(from) : undefined;

        if (existing && from && from !== to) {
          // Migrate registration metadata
          agents.delete(from);
          agents.set(to, {
            name: to,
            status: existing.status,
            registered_at: existing.registered_at,
            last_seen: new Date().toISOString(),
          });

          // Move pending queue (preserves messages-in-flight across rename)
          const oldQueue = queues.get(from);
          if (oldQueue && oldQueue.length > 0) {
            const newQueue = queues.get(to) ?? [];
            queues.set(to, [...newQueue, ...oldQueue]);
            queues.delete(from);
            persistQueues();
          }

          // Close old SSE so the channel can reconnect under the new name
          const clients = sseClients.get(from);
          if (clients) {
            for (const client of clients) {
              try { client.end(); } catch {}
            }
            sseClients.delete(from);
          }

          json(res, 200, { renamed: { from, to }, registered: false });
          return;
        }

        // No prior registration (or same name) — register fresh
        const renameNowIso = new Date().toISOString();
        agents.set(to, {
          name: to,
          status: "connected",
          registered_at: renameNowIso,
          last_seen: renameNowIso,
        });

        json(res, 200, { renamed: { from: from ?? null, to }, registered: true });
        return;
      }
    }

    // --- 404 ---
    json(res, 404, { error: "Not found" });
  });

  server.listen(config.port, config.host, () => {
    writePidFile(process.pid);
    console.log(`Synapse broker running on ${config.host}:${config.port}`);
  });

  // Graceful shutdown
  function shutdown() {
    console.log("\nShutting down broker...");
    persistQueues();
    removePidFile();

    // Close all SSE connections
    for (const clients of sseClients.values()) {
      for (const client of clients) {
        client.end();
      }
    }

    server.close(() => {
      process.exit(0);
    });

    // Force exit after 5 seconds
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Run directly if this is the entry point
const resolvedEntry = process.argv[1]
  ? path.resolve(process.argv[1])
  : "";
const thisFile = fileURLToPath(import.meta.url);
if (resolvedEntry === thisFile || resolvedEntry === thisFile.replace(/\.ts$/, ".js")) {
  startBroker();
}
