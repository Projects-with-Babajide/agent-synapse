import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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

export function resolveAgentName(): string {
  // Priority: env var → CLI --name arg → folder name
  if (process.env.SYNAPSE_AGENT_NAME) {
    return process.env.SYNAPSE_AGENT_NAME;
  }

  const nameArgIndex = process.argv.indexOf("--name");
  if (nameArgIndex !== -1 && process.argv[nameArgIndex + 1]) {
    return process.argv[nameArgIndex + 1];
  }

  return path.basename(process.cwd());
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
