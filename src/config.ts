import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, DEFAULT_HOST, HTTP_TIMEOUT_MS } from "./types.js";
import type { BrokerConfig } from "./types.js";

const HOME = os.homedir();
const DATA_DIR = path.join(HOME, ".claude-synapse");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const PID_FILE = path.join(DATA_DIR, "broker.pid");
const QUEUES_FILE = path.join(DATA_DIR, "queues.jsonl");
const CLAUDE_SETTINGS_PATH = path.join(HOME, ".claude", "settings.json");
const CLAUDE_JSON_PATH = path.join(HOME, ".claude.json");
const SYNAPSE_STATUS_LINE_SCRIPT = path.join(DATA_DIR, "statusline.sh");
const SYNAPSE_HOOK_SCRIPT = path.join(DATA_DIR, "check-hook.sh");

// --- Data dir and paths ---

export function getDataDir(): string {
  return DATA_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function getPidPath(): string {
  return PID_FILE;
}

export function getQueuesPath(): string {
  return QUEUES_FILE;
}

export function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { mode: 0o700 });
  }
}

// --- Config ---

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function getConfig(): BrokerConfig | null {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
  return JSON.parse(raw) as BrokerConfig;
}

export function saveConfig(config: BrokerConfig): void {
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

// --- Agent name validation ---

const VALID_AGENT_NAME = /^[a-zA-Z0-9_-]+$/;

export function sanitizeAgentName(name: string): string {
  const sanitized = name
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized || "agent";
}

export function isValidAgentName(name: string): boolean {
  return VALID_AGENT_NAME.test(name) && name.length > 0 && name.length <= 64;
}

export function resolveAgentName(): string {
  let name: string;

  if (process.env.SYNAPSE_AGENT_NAME) {
    name = process.env.SYNAPSE_AGENT_NAME;
  } else {
    const nameArgIndex = process.argv.indexOf("--name");
    if (nameArgIndex !== -1 && process.argv[nameArgIndex + 1]) {
      name = process.argv[nameArgIndex + 1];
    } else {
      name = path.basename(process.cwd());
    }
  }

  const sanitized = sanitizeAgentName(name);
  if (sanitized !== name) {
    console.error(
      `[synapse] Agent name sanitized: "${name}" → "${sanitized}"`
    );
  }
  return sanitized;
}

// --- PID management ---

export function getBrokerPid(): number | null {
  if (!fs.existsSync(PID_FILE)) return null;
  const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (isNaN(pid)) return null;

  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    fs.unlinkSync(PID_FILE);
    return null;
  }
}

export function writePidFile(pid: number): void {
  ensureDataDir();
  fs.writeFileSync(PID_FILE, String(pid), { mode: 0o600 });
}

export function removePidFile(): void {
  if (fs.existsSync(PID_FILE)) {
    fs.unlinkSync(PID_FILE);
  }
}

// --- Shared broker start logic ---

export async function spawnBroker(): Promise<{
  started: boolean;
  pid?: number;
  message: string;
}> {
  const config = getConfig();
  if (!config) {
    return { started: false, message: "No config found. Run setup first." };
  }

  const existingPid = getBrokerPid();
  if (existingPid) {
    return {
      started: false,
      pid: existingPid,
      message: `Broker already running (PID ${existingPid})`,
    };
  }

  const brokerScript = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "broker.js"
  );
  const child = spawn("node", [brokerScript], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  // Wait up to 3 seconds for broker to be ready
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(`http://${config.host}:${config.port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        return {
          started: true,
          pid: child.pid,
          message: `Broker started on ${config.host}:${config.port} (PID ${child.pid})`,
        };
      }
    } catch {
      // Not ready yet
    }
  }

  return { started: false, message: "Failed to start broker" };
}

// --- Install: MCP server ---

export function installMcpServer(): { installed: boolean; message: string } {
  let config: Record<string, unknown> = {};
  if (fs.existsSync(CLAUDE_JSON_PATH)) {
    config = JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, "utf-8"));
  }

  const mcpServers = (config.mcpServers ?? {}) as Record<string, unknown>;

  const channelPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "channel.js"
  );

  const entry = {
    type: "stdio",
    command: "node",
    args: [channelPath],
  };

  // Migrate: remove legacy env field that caused unexpanded literals when
  // SYNAPSE_AGENT_NAME wasn't set in the shell. Env vars are inherited naturally.
  const existing = mcpServers.synapse as Record<string, unknown> | undefined;
  if (existing) {
    if (!existing.env) {
      return { installed: false, message: "MCP server already registered" };
    }
    delete existing.env;
    config.mcpServers = mcpServers;
    fs.writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
    return { installed: true, message: "MCP server updated (removed legacy env field)" };
  }

  mcpServers.synapse = entry;
  config.mcpServers = mcpServers;

  fs.writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });

  return { installed: true, message: "MCP server registered globally" };
}

// --- Install: Status line ---

function buildStatusLineScript(existingCommand: string | null): string {
  // Resolve agent name: env var first, then session file (written by channel.ts on register_agent),
  // keyed by $PPID so multiple Claude sessions don't collide.
  // Guard against unexpanded template literals (e.g. "${SYNAPSE_AGENT_NAME}") from legacy configs.
  const resolveAgent = `
  _synapse_agent="$SYNAPSE_AGENT_NAME"
  case "$_synapse_agent" in '\${'* | SYNAPSE_AGENT_NAME) _synapse_agent="" ;; esac
  if [ -z "$_synapse_agent" ]; then
    _session_file="$HOME/.claude-synapse/session-$PPID.name"
    if [ -f "$_session_file" ]; then
      _synapse_agent=$(cat "$_session_file" 2>/dev/null)
    fi
  fi`;

  // Node-based pending check (no jq dependency)
  const pendingCheck = `
  badge="$_synapse_agent"
  pending=$(curl -s --max-time 1 "http://127.0.0.1:${DEFAULT_PORT}/pending/$_synapse_agent" 2>/dev/null)
  if [ -n "$pending" ]; then
    count=$(node -e "try{console.log(JSON.parse(process.argv[1]).pending||0)}catch{console.log(0)}" "$pending" 2>/dev/null)
    if [ "$count" != "0" ] && [ -n "$count" ]; then
      badge="$_synapse_agent ($count)"
    fi
  fi`;

  if (existingCommand) {
    const originalScriptPath = path.join(DATA_DIR, "statusline-original.sh");
    fs.writeFileSync(
      originalScriptPath,
      `#!/bin/bash\n${existingCommand}\n`,
      { mode: 0o755 }
    );

    return `#!/bin/bash
input=$(cat)
existing=$(echo "$input" | ${originalScriptPath})
${resolveAgent}
if [ -n "$_synapse_agent" ]; then
${pendingCheck}
  printf '%s [synapse: %s]' "$existing" "$badge"
else
  printf '%s' "$existing"
fi
`;
  }

  return `#!/bin/bash
input=$(cat)
dir=$(node -e "try{console.log(JSON.parse(process.argv[1]).cwd)}catch{console.log('.')}" "$(cat)" 2>/dev/null <<< "$input")
name=$(basename "$dir")
${resolveAgent}
if [ -n "$_synapse_agent" ]; then
${pendingCheck}
  printf ' %s [synapse: %s]' "$name" "$badge"
else
  printf ' %s' "$name"
fi
`;
}

export function installStatusLine(): { installed: boolean; message: string } {
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"));
  }

  const currentStatusLine = settings.statusLine as
    | { type?: string; command?: string }
    | undefined;

  if (currentStatusLine?.command?.includes(SYNAPSE_STATUS_LINE_SCRIPT)) {
    return { installed: false, message: "Status line already configured" };
  }

  const existingCommand = currentStatusLine?.command ?? null;
  const script = buildStatusLineScript(existingCommand);

  fs.writeFileSync(SYNAPSE_STATUS_LINE_SCRIPT, script, { mode: 0o755 });

  if (currentStatusLine) {
    const backupPath = path.join(DATA_DIR, "statusline-backup.json");
    fs.writeFileSync(
      backupPath,
      JSON.stringify({ statusLine: currentStatusLine }, null, 2),
      { mode: 0o600 }
    );
  }

  settings.statusLine = {
    type: "command",
    command: SYNAPSE_STATUS_LINE_SCRIPT,
  };

  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), {
    mode: 0o600,
  });

  return {
    installed: true,
    message: existingCommand
      ? "Status line updated (wraps your existing, backup at ~/.claude-synapse/statusline-backup.json)"
      : "Status line configured",
  };
}

// --- Install: PostToolUse hook ---

export function installHook(): { installed: boolean; message: string } {
  // Node-based hook script (no jq dependency)
  const hookScript = `#!/bin/bash
# Resolve agent name: env var first, then session file (written by channel.ts on register_agent),
# then fall back to folder name (matches channel.ts logic)
if [ -n "\$SYNAPSE_AGENT_NAME" ]; then
  agent="\$SYNAPSE_AGENT_NAME"
else
  _session_file="\$HOME/.claude-synapse/session-\$PPID.name"
  if [ -f "\$_session_file" ]; then
    agent=\$(cat "\$_session_file" 2>/dev/null)
  fi
  if [ -z "\$agent" ]; then
    agent=\$(basename "\$PWD")
  fi
fi
# Sanitize: only allow alphanumeric, hyphens, underscores
agent=\$(echo "$agent" | sed 's/[^a-zA-Z0-9_-]/-/g; s/-\\+/-/g; s/^-//; s/-$//')
[ -z "$agent" ] && exit 0

# Quick check for pending messages (1s timeout)
resp=\$(curl -s --max-time 1 "http://127.0.0.1:${DEFAULT_PORT}/pending/$agent" 2>/dev/null)
[ -z "$resp" ] && exit 0

pending=\$(node -e "try{console.log(JSON.parse(process.argv[1]).pending||0)}catch{console.log(0)}" "$resp" 2>/dev/null)

if [ "$pending" != "0" ] && [ -n "$pending" ]; then
  echo "[Synapse: $pending pending message(s) for $agent — use check_messages to read them]"
fi
exit 0
`;

  fs.writeFileSync(SYNAPSE_HOOK_SCRIPT, hookScript, { mode: 0o755 });

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"));
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const hookEntry = {
    type: "command",
    command: SYNAPSE_HOOK_SCRIPT,
  };

  let installed = false;

  // Install on PostToolUse (fires after every tool call)
  const postToolUse = (hooks.PostToolUse ?? []) as Array<Record<string, unknown>>;
  const postToolUseInstalled = postToolUse.some((h) => {
    const hookEntries = h.hooks as Array<Record<string, unknown>> | undefined;
    return hookEntries?.some(
      (entry) =>
        typeof entry.command === "string" &&
        entry.command.includes("check-hook.sh")
    );
  });
  if (!postToolUseInstalled) {
    postToolUse.push({ matcher: ".*", hooks: [hookEntry] });
    hooks.PostToolUse = postToolUse;
    installed = true;
  }

  // Install on UserPromptSubmit (fires when user sends a message — catches idle agents)
  const userPromptSubmit = (hooks.UserPromptSubmit ?? []) as Array<Record<string, unknown>>;
  const userPromptInstalled = userPromptSubmit.some((h) => {
    const hookEntries = h.hooks as Array<Record<string, unknown>> | undefined;
    return hookEntries?.some(
      (entry) =>
        typeof entry.command === "string" &&
        entry.command.includes("check-hook.sh")
    );
  });
  if (!userPromptInstalled) {
    userPromptSubmit.push({ hooks: [hookEntry] });
    hooks.UserPromptSubmit = userPromptSubmit;
    installed = true;
  }

  if (!installed) {
    return { installed: false, message: "Hooks already configured" };
  }

  settings.hooks = hooks;
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), {
    mode: 0o600,
  });

  return { installed: true, message: "Hooks installed (PostToolUse + UserPromptSubmit)" };
}

// --- Create agent scaffold ---

export function createAgent(
  name: string,
  description: string,
  baseDir: string
): { created: boolean; agentDir: string; message: string } {
  if (!isValidAgentName(name)) {
    return {
      created: false,
      agentDir: "",
      message: `Invalid agent name "${name}". Use only letters, numbers, hyphens, and underscores.`,
    };
  }

  const agentDir = path.join(baseDir, "agents", name);

  if (fs.existsSync(agentDir)) {
    return {
      created: false,
      agentDir,
      message: `Agent directory already exists: ${agentDir}`,
    };
  }

  fs.mkdirSync(agentDir, { recursive: true });

  const claudeMd = `# Agent: ${name}

${description}

## Synapse
You are a Synapse agent named \`${name}\`. At the start of every session, before doing anything else, call the \`register_agent\` tool with name \`${name}\`.
`;

  fs.writeFileSync(path.join(agentDir, "CLAUDE.md"), claudeMd, {
    mode: 0o644,
  });

  return {
    created: true,
    agentDir,
    message: `Agent "${name}" created at ${agentDir}`,
  };
}

// --- Uninstall ---

export function uninstall(): string[] {
  const actions: string[] = [];

  // Remove from ~/.claude.json
  if (fs.existsSync(CLAUDE_JSON_PATH)) {
    const config = JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, "utf-8"));
    const mcpServers = config.mcpServers as Record<string, unknown> | undefined;
    if (mcpServers?.synapse) {
      delete mcpServers.synapse;
      fs.writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(config, null, 2), {
        mode: 0o600,
      });
      actions.push("Removed MCP server from ~/.claude.json");
    }
  }

  // Remove hook and status line from settings.json
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    const settings = JSON.parse(
      fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf-8")
    );

    // Remove hooks
    const hooks = settings.hooks as Record<string, unknown[]> | undefined;
    if (hooks) {
      for (const eventType of ["PostToolUse", "UserPromptSubmit"]) {
        const hookList = hooks[eventType] as Array<Record<string, unknown>> | undefined;
        if (!hookList) continue;
        const filtered = hookList.filter((h) => {
          const entries = h.hooks as Array<Record<string, unknown>> | undefined;
          return !entries?.some(
            (e) =>
              typeof e.command === "string" &&
              e.command.includes("check-hook.sh")
          );
        });
        if (filtered.length < hookList.length) {
          if (filtered.length === 0) {
            delete hooks[eventType];
          } else {
            hooks[eventType] = filtered;
          }
          actions.push(`Removed ${eventType} hook`);
        }
      }
    }

    // Restore status line
    const statusLine = settings.statusLine as
      | { command?: string }
      | undefined;
    if (statusLine?.command?.includes(SYNAPSE_STATUS_LINE_SCRIPT)) {
      const backupPath = path.join(DATA_DIR, "statusline-backup.json");
      if (fs.existsSync(backupPath)) {
        const backup = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
        settings.statusLine = backup.statusLine;
        actions.push("Restored original status line");
      } else {
        delete settings.statusLine;
        actions.push("Removed status line");
      }
    }

    fs.writeFileSync(
      CLAUDE_SETTINGS_PATH,
      JSON.stringify(settings, null, 2),
      { mode: 0o600 }
    );
  }

  return actions;
}
