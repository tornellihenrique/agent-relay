import type { Effort, TriggerMode } from './config.js';
import { readJson, writeJsonAtomic } from './paths.js';

/** Per-conversation memory of the runtime (what to resume, what was already seen). */
export interface ConversationState {
  sessionId?: string;
  /** Overrides set at runtime with /model and /effort. */
  model?: string;
  effort?: Effort;
  /** Time of the newest channel message the agent has seen (older ones aren't repeated as context). */
  lastSeenTs?: number;
  /** Modification time of NOTEBOOK.md when this conversation last saw it. */
  notebookSeenAt?: number;
  lastActiveAt?: number;
  /** Last known session numbers, shown while the agent process is asleep. */
  last?: { model?: string; modelLabel?: string; contextWindow?: number; ctxPercent?: number; ctxTokens?: number };
  /** Channel this conversation replies to by default. */
  channelId?: string;
}

export interface BotState {
  conversations: Record<string, ConversationState>;
  /** Per-channel trigger overrides set with /listen. */
  triggers: Record<string, TriggerMode>;
  /** Names of MCP servers seen in the last session (used to build the deny list for an allowlist). */
  knownMcpServers: string[];
}

/** Small JSON file with debounced writes. */
export class StateStore {
  private data: BotState;
  private timer: NodeJS.Timeout | undefined;

  constructor(private file: string) {
    const raw = readJson<Partial<BotState>>(file) ?? {};
    this.data = {
      conversations: raw.conversations ?? {},
      triggers: raw.triggers ?? {},
      knownMcpServers: raw.knownMcpServers ?? [],
    };
  }

  get state(): BotState {
    return this.data;
  }

  conversation(key: string): ConversationState {
    return (this.data.conversations[key] ??= {});
  }

  update(mutator: (s: BotState) => void): void {
    mutator(this.data);
    this.save();
  }

  save(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    writeJsonAtomic(this.file, this.data);
  }
}
