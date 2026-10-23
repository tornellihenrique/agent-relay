import type { Effort } from '../core/config.js';

/**
 * What the bot layer needs from an agent runtime. Claude Code (via the Agent SDK) is the first
 * implementation; another runtime only has to provide a long-lived session that runs turns and
 * reports progress through a TurnSink.
 */

export interface AgentImage {
  mediaType: string;
  base64: string;
}

export interface AgentInput {
  text: string;
  images?: AgentImage[];
}

export interface ToolStart {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Set when the call comes from a subagent. */
  parentId?: string | null;
}

export interface CompactInfo {
  trigger: 'manual' | 'auto';
  preTokens: number;
  postTokens?: number;
}

/** Receives a turn's progress as it happens. Every method must be cheap and must not throw. */
export interface TurnSink {
  thinking(delta: string): void;
  text(delta: string): void;
  toolStart(tool: ToolStart): void;
  toolEnd(id: string, ok: boolean, output: string): void;
  compacted(info: CompactInfo): void;
  status(status: 'compacting' | 'retrying' | 'running', detail?: string): void;
}

export interface TurnOutcome {
  status: 'ok' | 'error' | 'interrupted';
  /** The answer: text written after the last substantive tool call. */
  text: string;
  /** Everything the agent wrote during the turn, narration included. */
  fullText: string;
  error?: string;
  durationMs: number;
  costUsd?: number;
  sessionId?: string;
  /** True when the session could not be resumed and a fresh one was started. */
  freshSession?: boolean;
}

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  title?: string;
  description?: string;
  displayName?: string;
  reason?: string;
  blockedPath?: string;
  canAlwaysAllow: boolean;
}

export type PermissionDecision =
  | { allow: true; always?: boolean }
  | { allow: false; message: string };

export interface QuestionRequest {
  toolUseId: string;
  questions: {
    question: string;
    header: string;
    options: { label: string; description: string }[];
    multiSelect: boolean;
  }[];
}

/** Answers keyed by question text (multi-select answers comma-separated), or null if unanswered. */
export type QuestionAnswer = { answers: Record<string, string>; response?: string } | null;

export interface RateLimits {
  fiveHour?: number;
  sevenDay?: number;
  fiveHourResetsAt?: number;
  sevenDayResetsAt?: number;
  status?: string;
}

export interface SessionInfo {
  runtime: string;
  sessionId?: string;
  alive: boolean;
  busy: boolean;
  model?: string;
  modelLabel?: string;
  contextWindow?: number;
  effort?: Effort | string;
  ctxTokens?: number;
  ctxMax?: number;
  ctxPercent?: number;
  totalCostUsd?: number;
  rateLimits?: RateLimits;
  permissionMode?: string;
  mcpServers?: { name: string; status: string }[];
  transcriptPath?: string;
  cliVersion?: string;
  startedAt?: number;
  lastTurnAt?: number;
}

export interface ModelOption {
  value: string;
  label: string;
  description?: string;
  efforts?: string[];
}

export interface ContextCategory {
  name: string;
  tokens: number;
  kind: string;
}

/** A background turn the agent started on its own (e.g. a finished background task). */
export interface BackgroundTurnHandler {
  (): { sink: TurnSink; done: (outcome: TurnOutcome) => void };
}

export interface AgentSession {
  readonly alive: boolean;
  readonly busy: boolean;
  info(): SessionInfo;
  /** Starts the agent process now (otherwise it starts on the first turn). */
  start(): Promise<void>;
  run(input: AgentInput, sink: TurnSink): Promise<TurnOutcome>;
  /** Runs a runtime command such as /compact. */
  command(command: string, sink: TurnSink): Promise<TurnOutcome>;
  interrupt(): Promise<void>;
  setModel(model: string | undefined): Promise<void>;
  setEffort(effort: Effort | undefined): Promise<void>;
  refreshContext(): Promise<void>;
  contextBreakdown(): Promise<ContextCategory[] | null>;
  models(): Promise<ModelOption[]>;
  /** Updates the set of MCP servers to hide from the agent. */
  close(reason: string): void;
  onBackgroundTurn?: BackgroundTurnHandler;
  onInfoChanged?: () => void;
}

export interface SessionCallbacks {
  onPermission(req: PermissionRequest): Promise<PermissionDecision>;
  onQuestion(req: QuestionRequest): Promise<QuestionAnswer>;
  onSessionId(id: string): void;
  onSuggestion?(text: string): void;
}
