# Roadmap

Feedback from a 2-day, 5-agent Cerebro orchestration session (25+ PRs, 20+ tickets). Core model validated — gaps are visibility and convenience.

## Near-term

### 1. Agent connection status on send
**Problem:** After sending, the caller can't tell if the target is online. The broker already returns `notified: bool` but the conceptual model is muddy — everything is "queued" even for connected agents.

**Fix:** Return `{ status: "delivered" | "queued", agent_connected: bool }` from `/send`. Use `delivered` only when the SSE hint fired; use `queued` for offline delivery. Update tool response text to match.

**Files:** `src/broker.ts` (`/send`), `src/channel.ts` (`send_message` handler)

---

### 2. Multicast
**Problem:** Notifying multiple agents requires N separate `send_message` calls.

**Fix:** Accept `to` as a string or string array. Broker fans out to each target, returns a per-agent status map.

**Files:** `src/broker.ts` (`/send`), `src/channel.ts` (tool schema + handler), `src/types.ts`

---

## Medium-term

### 3. Message history
**Problem:** Context is fully lost on `/clear` or session restart. Agents reconnecting to a conversation have no record of what was exchanged.

**Fix:** Append all messages to a persistent log (`~/.claude-synapse/history.jsonl`). Add a `get_message_history` tool — `get_message_history(with: "agent-name", limit: 20)` — that reads from the log without draining it. Separate from the delivery queue.

**Files:** `src/broker.ts` (persist on `/send`), `src/channel.ts` (new tool), `src/types.ts`

---

### 4. Read receipts
**Problem:** Senders don't know if a message was read or if the agent is working on it.

**Fix:** On `/drain`, record a read timestamp per message. Expose a `/receipt/:name` endpoint the sender can poll. Add a `message_read` SSE hint back to the original sender. Requires message IDs.

**Files:** `src/types.ts` (add `id` to `SynapseMessage`), `src/broker.ts` (drain updates receipt, new endpoint), `src/channel.ts` (emit hint)

---

## Longer-term

### 5. Agent groups / availability routing
**Problem:** "Send to whichever of builder/fixer is connected" requires manual fallback logic.

**Fix:** Register agents into named groups (`cerebro-workers`). `send_message(to: "cerebro-workers")` routes to the first connected member, or queues for all if none are online.

---

### 6. Native escalation pattern
**Problem:** The "builder hits a blocker → asks orchestrator → orchestrator escalates to user" chain is implemented ad-hoc each session.

**Fix:** Add `escalate(to: "parent-agent", content, priority: "high"|"normal")` tool. High-priority messages surface via a distinct SSE hint so the parent agent is nudged immediately, not on next tool call.

---

### 7. Message forwarding
**Problem:** When a target agent is offline, there's no way to relay its queued messages to another agent.

**Fix:** Add `forward_message(message_id, to: "other-agent")` tool. Moves the queued message to a new target without re-sending the content.
