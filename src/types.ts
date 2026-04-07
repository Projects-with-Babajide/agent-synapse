export interface SynapseMessage {
  from: string;
  to: string;
  content: string;
  timestamp: string;
}

export interface SSEHint {
  type: "message_available";
  from: string;
  timestamp: string;
}

export interface Agent {
  name: string;
  status: "connected" | "disconnected";
  registered_at: string;
}

export interface BrokerConfig {
  port: number;
  host: string;
  token: string;
  dataDir: string;
}

export const VERSION = "0.1.0";
export const DEFAULT_PORT = 3117;
export const DEFAULT_HOST = "127.0.0.1";
export const MAX_MESSAGE_SIZE = 100 * 1024; // 100KB
export const MAX_QUEUE_DEPTH = 100;
export const KEEPALIVE_INTERVAL_MS = 15_000;
export const HTTP_TIMEOUT_MS = 10_000;
