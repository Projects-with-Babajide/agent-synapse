# Privacy Policy

Agent Synapse runs entirely on your local machine. It does not collect, transmit, or store data on external servers.

## What stays local

- **Messages** are routed through a broker bound to `127.0.0.1` (localhost only). No network traffic leaves your machine.
- **Undelivered messages** are persisted to `~/.claude-synapse/queues.jsonl` until the recipient agent drains them. Delivered messages are not retained.
- **Auth tokens** are generated locally and stored in `~/.claude-synapse/auth.json`. They are used only for localhost communication between the broker and MCP server.

## What we don't do

- No telemetry or analytics
- No external API calls
- No data shared with third parties
- No cookies, tracking, or fingerprinting

## Questions

If you have questions about privacy, open an issue at https://github.com/DisposableByDefault/agent-synapse/issues.
