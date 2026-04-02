#!/usr/bin/env node

import {
  ensureDataDir,
  generateToken,
  saveConfig,
  getConfig,
  getDataDir,
  getBrokerPid,
  removePidFile,
  installStatusLine,
  installMcpServer,
  installHook,
  spawnBroker,
  uninstall,
} from "./config.js";
import { DEFAULT_PORT, DEFAULT_HOST, VERSION } from "./types.js";

function printUsage(): void {
  console.log(`
agent-synapse — Cross-project messaging between Claude Code sessions

Usage:
  agent-synapse setup              Set up Synapse (generates config and token)
  agent-synapse broker start       Start the message broker daemon
  agent-synapse broker stop        Stop the broker daemon
  agent-synapse broker status      Show broker status and connected agents
  agent-synapse uninstall          Remove Synapse from Claude Code settings
  agent-synapse version            Show version

Environment:
  SYNAPSE_AGENT_NAME    Set the agent name for this session (default: folder name)
`);
}

async function setup(): Promise<void> {
  ensureDataDir();

  const existing = getConfig();
  if (!existing) {
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
  } else {
    console.log("Synapse config already exists.\n");
    console.log(`  Config: ${getDataDir()}/config.json`);
    console.log(`  Broker: ${existing.host}:${existing.port}\n`);
  }

  // Always run integrations (idempotent)
  const mcpResult = installMcpServer();
  console.log(`  MCP server: ${mcpResult.message}`);

  const hookResult = installHook();
  console.log(`  Hook: ${hookResult.message}`);

  const statusResult = installStatusLine();
  console.log(`  Status line: ${statusResult.message}`);

  console.log("\nNext steps:\n");
  console.log("  1. Start Claude Code as a named agent:");
  console.log("     SYNAPSE_AGENT_NAME=backend claude\n");
  console.log("  2. In another terminal:");
  console.log("     SYNAPSE_AGENT_NAME=frontend claude\n");
  console.log("  The broker starts automatically when the first agent connects.");
}

async function brokerStart(): Promise<void> {
  const config = getConfig();
  if (!config) {
    console.error("No config found. Run 'agent-synapse setup' first.");
    process.exit(1);
  }

  const result = await spawnBroker();
  console.log(result.message);
  if (!result.started && !result.pid) {
    process.exit(1);
  }
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
    console.error("No config found. Run 'agent-synapse setup' first.");
    process.exit(1);
  }

  const pid = getBrokerPid();

  try {
    const res = await fetch(`http://${config.host}:${config.port}/agents`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        agents: Array<{ name: string; status: string; registered_at: string }>;
      };

      console.log(
        `Broker: running on ${config.host}:${config.port}${pid ? ` (PID ${pid})` : ""}`
      );
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

function runUninstall(): void {
  const actions = uninstall();
  if (actions.length === 0) {
    console.log("Nothing to uninstall.");
  } else {
    for (const action of actions) {
      console.log(`  ${action}`);
    }
    console.log("\nSynapse removed from Claude Code settings.");
    console.log("Config and data remain at ~/.claude-synapse/ — delete manually if desired.");
  }
}

function version(): void {
  console.log(`agent-synapse v${VERSION}`);
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
  case "uninstall":
    runUninstall();
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
