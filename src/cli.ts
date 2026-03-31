#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureDataDir,
  generateToken,
  saveConfig,
  getConfig,
  getDataDir,
  getBrokerPid,
  removePidFile,
  installStatusLine,
} from "./config.js";
import { DEFAULT_PORT, DEFAULT_HOST } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function printUsage(): void {
  console.log(`
claude-synapse — Cross-project messaging between Claude Code sessions

Usage:
  claude-synapse setup              Set up Synapse (generates config and token)
  claude-synapse broker start       Start the message broker daemon
  claude-synapse broker stop        Stop the broker daemon
  claude-synapse broker status      Show broker status and connected agents
  claude-synapse version            Show version

Environment:
  SYNAPSE_AGENT_NAME    Set the agent name for this session (default: folder name)
`);
}

async function setup(): Promise<void> {
  ensureDataDir();

  const existing = getConfig();
  if (existing) {
    console.log("Synapse is already configured.");
    console.log(`  Config: ${getDataDir()}/config.json`);
    console.log(`  Token: ${existing.token.slice(0, 8)}...`);
    console.log(`  Broker: ${existing.host}:${existing.port}`);
    console.log("\nTo reconfigure, delete ~/.claude-synapse/config.json and run setup again.");
    return;
  }

  const token = generateToken();
  const config = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    token,
    dataDir: getDataDir(),
  };
  saveConfig(config);

  console.log("Synapse configured successfully!\n");
  console.log(`  Config: ${getDataDir()}/config.json`);
  console.log(`  Broker: ${config.host}:${config.port}`);
  console.log(`  Token: ${token.slice(0, 8)}...\n`);
  console.log("Next steps:\n");
  console.log("  1. Start Claude Code with the Synapse channel:");
  console.log("     SYNAPSE_AGENT_NAME=backend claude --dangerously-load-development-channels server:synapse\n");
  console.log("  2. In another terminal:");
  console.log("     SYNAPSE_AGENT_NAME=frontend claude --dangerously-load-development-channels server:synapse\n");
  console.log("  The broker starts automatically when the first agent connects.\n");

  // Install status line
  const statusResult = installStatusLine();
  console.log(`  Status line: ${statusResult.message}`);
}

async function brokerStart(): Promise<void> {
  const config = getConfig();
  if (!config) {
    console.error("No config found. Run 'claude-synapse setup' first.");
    process.exit(1);
  }

  const pid = getBrokerPid();
  if (pid) {
    console.log(`Broker is already running (PID ${pid})`);
    return;
  }

  const brokerScript = path.join(__dirname, "broker.js");
  const child = spawn("node", [brokerScript], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  // Wait for broker to be ready
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(`http://${config.host}:${config.port}/health`);
      if (res.ok) {
        console.log(`Broker started on ${config.host}:${config.port} (PID ${child.pid})`);
        return;
      }
    } catch {
      // Not ready yet
    }
  }

  console.error("Failed to start broker");
  process.exit(1);
}

function brokerStop(): void {
  const pid = getBrokerPid();
  if (!pid) {
    console.log("Broker is not running");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    removePidFile();
    console.log(`Broker stopped (PID ${pid})`);
  } catch {
    console.error(`Failed to stop broker (PID ${pid})`);
    removePidFile();
  }
}

async function brokerStatus(): Promise<void> {
  const config = getConfig();
  if (!config) {
    console.error("No config found. Run 'claude-synapse setup' first.");
    process.exit(1);
  }

  const pid = getBrokerPid();

  try {
    const res = await fetch(`http://${config.host}:${config.port}/agents?token=${config.token}`);
    if (res.ok) {
      const data = (await res.json()) as {
        agents: Array<{ name: string; status: string; registered_at: string }>;
      };

      console.log(`Broker: running on ${config.host}:${config.port}${pid ? ` (PID ${pid})` : ""}`);
      console.log(`Agents: ${data.agents.length}`);
      if (data.agents.length > 0) {
        for (const agent of data.agents) {
          console.log(`  - ${agent.name} (${agent.status})`);
        }
      }
    } else {
      console.log("Broker: not responding");
    }
  } catch {
    console.log("Broker: not running");
  }
}

function version(): void {
  console.log("claude-synapse v0.1.0");
}

// --- Main ---

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

switch (command) {
  case "setup":
    setup();
    break;
  case "broker":
    switch (subcommand) {
      case "start":
        brokerStart();
        break;
      case "stop":
        brokerStop();
        break;
      case "status":
        brokerStatus();
        break;
      default:
        console.error(`Unknown broker command: ${subcommand}`);
        printUsage();
        process.exit(1);
    }
    break;
  case "version":
  case "--version":
  case "-v":
    version();
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    printUsage();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
