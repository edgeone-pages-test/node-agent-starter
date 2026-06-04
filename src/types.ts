// ─── Legacy chat types (still used by /history adapter & SSE callback bridge) ──
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  activity?: {
    type: 'web_search';
    label: string;
    status: 'active' | 'done';
  };
}

export interface ToolLampState {
  id: string;
  label: string;
  icon: string;
  active: boolean;
  animKey: number;
}

// ─── REPL line model ─────────────────────────────────────────────────────────
// Each REPL render row is one of these tagged variants. The render layer
// (`ReplLine.tsx`) switches on `kind` and never inspects fields it does not own.

export type ReplLine =
  | { kind: 'motd'; id: string }
  | { kind: 'user'; id: string; text: string; ts: number }
  | {
      kind: 'text';
      id: string;
      turnId: string;
      text: string;
      ts: number;
      /** True when this text line follows a tool call within the same turn,
       *  so the renderer can suppress the agent▸ prefix to avoid noise. */
      isContinuation?: boolean;
    }
  | {
      kind: 'tool';
      id: string;
      turnId: string;
      tool: string;
      ts: number;
      argsPreview?: string;
      durationMs?: number;
      resultSummary?: string;
    }
  | {
      kind: 'done';
      id: string;
      turnId: string;
      ts: number;
      elapsedMs: number;
      toolRounds: number;
    }
  | { kind: 'error'; id: string; turnId?: string; message: string; ts: number }
  | { kind: 'restored'; id: string; ts: number; count: number }
  | { kind: 'sysHint'; id: string; text: string; ts: number; tone?: 'dim' | 'warn' | 'error' };

export interface TurnMeta {
  turnId: string;
  startTs: number;
  toolRounds: number;
  /** True once at least one text_delta has been observed for this turn. */
  hasText: boolean;
  /** ID of the latest `text` line in `lines` for delta append, or null if next delta should create a new one. */
  currentTextLineId: string | null;
}
