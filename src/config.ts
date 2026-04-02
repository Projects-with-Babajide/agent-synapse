import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, DEFAULT_HOST } from "./types.js";
import type { BrokerConfig } from "./types.js";

const DATA_DIR = path.join(process.env.HOME!, ".claude-synapse");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const PID_FILE = path.join(DATA_DIR, "broker.pid");
const QUEUES_FILE = path.join(DATA_DIR, "queues.jsonl");

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

const VALID_AGENT_NAME = /^[a-zA-Z0-9_-]+$/;

export function sanitizeAgentName(name: string): string {
  // Strip any characters that aren't alphanumeric, hyphens, or underscores
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized || "agent";
}

export function isValidAgentName(name: string): boolean {
  return VALID_AGENT_NAME.test(name) && name.length > 0 && name.length <= 64;
}

export function resolveAgentName(): string {
  // Priority: env var → CLI --name arg → folder name
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

  return sanitizeAgentName(name);
}

export function getBrokerPid(): number | null {
  if (!fs.existsSync(PID_FILE)) return null;
  const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (isNaN(pid)) return null;

  // Check if process is still running
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    // Process not running, clean up stale PID file
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

// --- Status line ---

const CLAUDE_SETTINGS_PATH = path.join(
  process.env.HOME!,
  ".claude",
  "settings.json"
);

const SYNAPSE_STATUS_LINE_SCRIPT = path.join(DATA_DIR, "statusline.sh");

function synapseBadge(): string {
  // Shared snippet: query broker for pending count + format the badge
  return `
  agent="$SYNAPSE_AGENT_NAME"
  badge="$agent"
  # Check for pending messages (fast localhost call, timeout 1s)
  pending=$(curl -s --max-time 1 "http://127.0.0.1:${DEFAULT_PORT}/pending/$agent" 2>/dev/null | jq -r '.pending // 0')
  if [ "$pending" != "0" ] && [ -n "$pending" ]; then
    badge="$agent ($pending)"
  fi`;
}

function buildStatusLineScript(existingCommand: string | null): string {
  // If there's an existing status line command, run it first and append synapse info
  if (existingCommand) {
    // Save the original command to a separate script so it runs cleanly
    const originalScriptPath = path.join(DATA_DIR, "statusline-original.sh");
    fs.writeFileSync(
      originalScriptPath,
      `#!/bin/bash\n${existingCommand}\n`,
      { mode: 0o755 }
    );

    return `#!/bin/bash
input=$(cat)
# Run the original status line command
existing=$(echo "$input" | ${originalScriptPath})
# Append synapse agent name if set
if [ -n "$SYNAPSE_AGENT_NAME" ]; then
${synapseBadge()}
  printf '%s [synapse: %s]' "$existing" "$badge"
else
  printf '%s' "$existing"
fi
`;
  }

  // No existing status line — show folder name + synapse info
  return `#!/bin/bash
input=$(cat)
dir=$(echo "$input" | jq -r '.cwd')
name=$(basename "$dir")
if [ -n "$SYNAPSE_AGENT_NAME" ]; then
${synapseBadge()}
  printf ' %s [synapse: %s]' "$name" "$badge"
else
  printf ' %s' "$name"
fi
`;
}

const CLAUDE_JSON_PATH = path.join(process.env.HOME!, ".claude.json");

export function installMcpServer(): { installed: boolean; message: string } {
  let config: Record<string, unknown> = {};
  if (fs.existsSync(CLAUDE_JSON_PATH)) {
    config = JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, "utf-8"));
  }

  const mcpServers = (config.mcpServers ?? {}) as Record<string, unknown>;

  if (mcpServers.synapse) {
    return { installed: false, message: "MCP server already registered" };
  }

  // Use absolute path to the compiled channel.js
  const channelPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "channel.js");

  mcpServers.synapse = {
    type: "stdio",
    command: "node",
    args: [channelPath],
    env: {
      SYNAPSE_AGENT_NAME: "${SYNAPSE_AGENT_NAME}",
    },
  };
  config.mcpServers = mcpServers;

  fs.writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(config, null, 2));

  return { installed: true, message: "MCP server registered globally" };
}

export function installStatusLine(): { installed: boolean; message: string } {
  // Read existing Claude settings
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"));
  }

  const currentStatusLine = settings.statusLine as
    | { type?: string; command?: string }
    | undefined;

  // If already pointing to our script, skip
  if (currentStatusLine?.command?.includes(SYNAPSE_STATUS_LINE_SCRIPT)) {
    return { installed: false, message: "Status line already configured" };
  }

  // Build script that wraps the existing command (if any)
  const existingCommand = currentStatusLine?.command ?? null;
  const script = buildStatusLineScript(existingCommand);

  // Write the status line script
  fs.writeFileSync(SYNAPSE_STATUS_LINE_SCRIPT, script, { mode: 0o755 });

  // Back up the existing status line config
  if (currentStatusLine) {
    const backupPath = path.join(DATA_DIR, "statusline-backup.json");
    fs.writeFileSync(
      backupPath,
      JSON.stringify({ statusLine: currentStatusLine }, null, 2),
      { mode: 0o600 }
    );
  }

  // Update settings to use our wrapper script
  settings.statusLine = {
    type: "command",
    command: SYNAPSE_STATUS_LINE_SCRIPT,
  };

  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));

  return {
    installed: true,
    message: existingCommand
      ? "Status line updated (wraps your existing status line, backup at ~/.claude-synapse/statusline-backup.json)"
      : "Status line configured",
  };
}

// --- PostToolUse hook ---

const SYNAPSE_HOOK_SCRIPT = path.join(DATA_DIR, "check-hook.sh");

export function installHook(): { installed: boolean; message: string } {
  // Write the hook script — checks pending count silently
  const hookScript = `#!/bin/bash
# Only run if SYNAPSE_AGENT_NAME is set
[ -z "$SYNAPSE_AGENT_NAME" ] && exit 0

# Quick check for pending messages (1s timeout)
pending=$(curl -s --max-time 1 "http://127.0.0.1:${DEFAULT_PORT}/pending/$SYNAPSE_AGENT_NAME" 2>/dev/null | jq -r '.pending // 0')

if [ "$pending" != "0" ] && [ -n "$pending" ]; then
  echo "[Synapse: $pending pending message(s) for $SYNAPSE_AGENT_NAME — use check_messages to read them]"
fi
exit 0
`;

  fs.writeFileSync(SYNAPSE_HOOK_SCRIPT, hookScript, { mode: 0o755 });

  // Add hook to settings.json
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"));
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const postToolUse = (hooks.PostToolUse ?? []) as Array<Record<string, unknown>>;

  // Check if our hook is already installed
  const alreadyInstalled = postToolUse.some(
    (h) => {
      const hookEntries = h.hooks as Array<Record<string, unknown>> | undefined;
      return hookEntries?.some(
        (entry) => typeof entry.command === "string" && entry.command.includes("check-hook.sh")
      );
    }
  );

  if (alreadyInstalled) {
    return { installed: false, message: "Hook already configured" };
  }

  postToolUse.push({
    matcher: ".*",
    hooks: [
      {
        type: "command",
        command: SYNAPSE_HOOK_SCRIPT,
      },
    ],
  });

  hooks.PostToolUse = postToolUse;
  settings.hooks = hooks;

  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));

  return { installed: true, message: "PostToolUse hook installed" };
}
