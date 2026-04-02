import http from "node:http";
import fs from "node:fs";
import {
  DEFAULT_PORT,
  DEFAULT_HOST,
  MAX_MESSAGE_SIZE,
  MAX_QUEUE_DEPTH,
  KEEPALIVE_INTERVAL_MS,
} from "./types.js";
import type { SynapseMessage, Agent } from "./types.js";
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

// --- SSE delivery ---

function deliverMessage(to: string, message: SynapseMessage): boolean {
  const clients = sseClients.get(to);
  if (clients && clients.length > 0) {
    const data = `data: ${JSON.stringify(message)}\n\n`;
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

    // CORS for local development
    res.setHeader("Access-Control-Allow-Origin", "*");

    // --- GET /health (no auth) ---
    if (method === "GET" && pathname === "/health") {
      json(res, 200, { status: "ok", agents: agents.size });
      return;
    }

    // --- Auth for all other endpoints ---
    let token: string | null = null;
    if (method === "GET") {
      token = searchParams.get("token");
    } else {
      // Token comes in the request body for POST requests
    }

    // --- GET /agents ---
    if (method === "GET" && pathname === "/agents") {
      if (!validateToken(token, config.token)) {
        json(res, 401, { error: "Invalid token" });
        return;
      }
      const list = Array.from(agents.values());
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

      // Flush queued messages
      const pending = queues.get(agentName);
      if (pending && pending.length > 0) {
        for (const msg of pending) {
          res.write(`data: ${JSON.stringify(msg)}\n\n`);
        }
        queues.delete(agentName);
        persistQueues();
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

        agents.set(name, {
          name,
          status: "connected",
          registered_at: new Date().toISOString(),
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

        // Try to deliver via SSE first
        const delivered = deliverMessage(to, message);

        if (!delivered) {
          // Queue the message
          if (!queues.has(to)) queues.set(to, []);
          const queue = queues.get(to)!;

          if (queue.length >= MAX_QUEUE_DEPTH) {
            json(res, 429, { error: "Queue full for target agent" });
            return;
          }

          queue.push(message);
          persistQueues();
        }

        json(res, 200, {
          sent: true,
          delivered,
          to,
        });
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
    setTimeout(() => process.exit(0), 5000);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Run directly if this is the entry point
const isDirectRun =
  process.argv[1]?.endsWith("broker.js") ||
  process.argv[1]?.endsWith("broker.ts");

if (isDirectRun) {
  startBroker();
}
