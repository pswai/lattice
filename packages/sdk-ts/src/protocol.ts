// Wire-level frame types for the Lattice bus protocol (v1).
// Intentionally duplicated from the broker to keep sdk-ts self-contained.

export interface HelloFrame {
  op: 'hello';
  agent_id: string;
  token: string;
  protocol_version: number;
  last_acked_cursor?: number;
  replay?: boolean;
}

export interface SendFrame {
  op: 'send';
  to?: string;
  topic?: string;
  type: 'direct' | 'broadcast' | 'event';
  payload: unknown;
  idempotency_key?: string;
  correlation_id?: string;
}

export interface SubscribeFrame {
  op: 'subscribe';
  topics: string[];
}

export interface AckFrame {
  op: 'ack';
  cursor: number;
}

export interface WelcomeFrame {
  op: 'welcome';
  agent_id: string;
  current_cursor: number;
  replaying: boolean;
  protocol_version: number;
}

export interface MessageFrame {
  op: 'message';
  cursor: number;
  from: string;
  type: string;
  topic: string | null;
  payload: unknown;
  idempotency_key: string | null;
  correlation_id: string | null;
  created_at: number;
}

export interface GapFrame {
  op: 'gap';
  from: number;
  to: number;
  reason: string;
}

export interface ErrorFrame {
  op: 'error';
  code: string;
  message: string;
  [key: string]: unknown;
}

export type InboundFrame = WelcomeFrame | MessageFrame | GapFrame | ErrorFrame;
export type OutboundFrame = HelloFrame | SendFrame | SubscribeFrame | AckFrame;
