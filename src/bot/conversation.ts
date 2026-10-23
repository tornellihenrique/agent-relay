import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeSession, transcriptExists } from '../agent/claude.js';
import { tokensLabel } from '../agent/models.js';
import type { AgentImage, AgentSession, CompactInfo, SessionInfo, TurnOutcome, TurnSink } from '../agent/types.js';
import type { Archive } from '../core/archive.js';
import { sleep } from '../core/async.js';
import type { BotConfig, Effort } from '../core/config.js';
import type { Logger } from '../core/log.js';
import type { BotPaths } from '../core/paths.js';
import type { ConversationState, StateStore } from '../core/state.js';
import { oneLine } from '../core/text.js';
import type { Platform } from '../platform/types.js';
import type { EnvelopeContext } from './envelope.js';
import type { Marks } from './marks.js';
import { notebookBlock } from './envelope.js';
import { saveNotesPrompt } from './instructions.js';
import type { Prompts } from './prompts.js';
import type { Scheduler } from './scheduler.js';
import { relayTools } from './tools.js';
import { TurnView, type PendingKind, type TriggerRef, type TurnContext } from './turn.js';

export interface PendingInput {
  kind: PendingKind;
  text: string;
  images?: AgentImage[];
  trigger?: TriggerRef;
  ts: number;
  label?: string;
  quiet?: boolean;
  /** Timestamp of the newest channel message this input shows the agent. */
  seenTs?: number;
  /** A job runs in queue order instead of a turn (compaction, reset). */
  job?: () => Promise<void>;
}

/** What a conversation needs from its bot. */
export interface BotRuntime {
  cfg: BotConfig;
  paths: BotPaths;
  platform: Platform;
  archive: Archive;
  state: StateStore;
  scheduler: Scheduler;
  prompts: Prompts;
  log: Logger;
  instructions(): string;
  envelope(): EnvelopeContext;
  inScope(channelId: string): Promise<boolean>;
  rememberMcpServers(names: string[]): void;
  statusChanged(): void;
  recordSent(channelId: string, ids: string[], text: string, turnId?: string): void;
  owners: Set<string>;
  marks: Marks;
}

const QUIET_SINK: TurnSink = { thinking() {}, text() {}, toolStart() {}, toolEnd() {}, compacted() {}, status() {} };

function newTurnId(): string {
  return `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
}

/** One chat (channel, thread or DM) and the agent session that serves it. */
export class Conversation {
  session: AgentSession | undefined;
  private queue: PendingInput[] = [];
  private running = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private needsNotebook = false;
  private compactions = 0;
  private suggestions = new Map<string, string>();
  turn: TurnContext | undefined;
  view: TurnView | undefined;
  private readonly log: Logger;

  constructor(
    readonly key: string,
    public channelId: string,
    private bot: BotRuntime,
  ) {
    this.log = bot.log.child(key.split(':').at(-1) ?? key);
    this.st.channelId ??= channelId;
  }

  get st(): ConversationState {
    return this.bot.state.conversation(this.key);
  }

  get busy(): boolean {
    return this.running || Boolean(this.session?.busy);
  }

  get queued(): number {
    return this.queue.length;
  }

  info(): SessionInfo {
    if (this.session) return this.session.info();
    return {
      runtime: this.bot.cfg.agent.runtime,
      sessionId: this.st.sessionId,
      alive: false,
      busy: false,
      model: this.st.model ?? this.bot.cfg.agent.model,
      effort: this.st.effort ?? this.bot.cfg.agent.effort,
    };
  }

  suggestionFor(messageId: string): string | undefined {
    return this.suggestions.get(messageId);
  }

  // ── session ───────────────────────────────────────────────

  ensureSession(): AgentSession {
    if (this.session) return this.session;
    const { cfg, paths } = this.bot;
    let resumeId = this.st.sessionId;
    if (resumeId && !transcriptExists(cfg.context, resumeId, cfg.agent.claudeConfigDir)) {
      this.log.warn(`transcript for session ${resumeId} is gone; starting a new session`);
      resumeId = undefined;
    }
    this.needsNotebook = !resumeId;
    this.compactions = resumeId ? (this.bot.archive.sessionInfo(resumeId)?.compactions ?? 0) : 0;
    const tools = relayTools({
      cfg,
      platform: this.bot.platform,
      archive: this.bot.archive,
      scheduler: this.bot.scheduler,
      envelope: () => this.bot.envelope(),
      convKey: this.key,
      defaultChannel: () => this.turn?.channelId ?? this.channelId,
      currentTurn: () => this.turn,
      info: () => this.info(),
      inScope: (id) => this.bot.inScope(id),
      recordSent: (ch, ids, text, turnId) => this.bot.recordSent(ch, ids, text, turnId),
      paths: { notebook: paths.notebook, inbox: paths.inbox, db: paths.db },
      sessionStats: () => ({
        compactions: this.compactions,
        archived: this.bot.archive.messageCount(),
        turns: this.bot.archive.turnStats(this.key).turns,
      }),
    });
    const session = new ClaudeSession({
      conv: this.key,
      cwd: cfg.context,
      agent: cfg.agent,
      resumeId,
      model: this.st.model,
      effort: this.st.effort,
      systemAppend: this.bot.instructions(),
      mcpServers: { relay: tools },
      directories: [paths.notebook, paths.inbox],
      knownMcpServers: this.bot.state.state.knownMcpServers,
      onMcpServers: (names) => this.bot.rememberMcpServers(names),
      log: this.log,
      callbacks: {
        onSessionId: (id) => {
          const old = this.st.sessionId;
          this.bot.state.update(() => (this.st.sessionId = id));
          if (old && old !== id) this.bot.archive.endSession(old, 'replaced');
          this.bot.archive.touchSession(id, this.key, this.session?.info().model, this.session?.info().transcriptPath);
        },
        onPermission: async (req) => {
          const turn = this.turn;
          this.view?.waiting('Waiting for permission');
          try {
            return await this.bot.prompts.permission(turn?.channelId ?? this.channelId, turn?.main?.messageId, req, this.bot.owners);
          } finally {
            this.view?.waiting(undefined);
          }
        },
        onQuestion: async (req) => {
          const turn = this.turn;
          const who = new Set<string>(this.bot.owners);
          if (turn?.main?.userId) who.add(turn.main.userId);
          this.view?.waiting('Waiting for an answer');
          try {
            return await this.bot.prompts.question(turn?.channelId ?? this.channelId, turn?.main?.messageId, req, who.size ? who : null);
          } finally {
            this.view?.waiting(undefined);
          }
        },
        onSuggestion: (text) => this.offerSuggestion(text),
      },
    });
    session.onInfoChanged = () => this.bot.statusChanged();
    session.onBackgroundTurn = () => this.backgroundTurn();
    this.session = session;
    return session;
  }

  async warm(): Promise<void> {
    const s = this.ensureSession();
    await s.start();
    await s.models().catch(() => []);
    await s.refreshContext();
    this.armIdle();
  }

  close(reason: string): void {
    clearTimeout(this.idleTimer);
    this.session?.close(reason);
    this.session = undefined;
    this.bot.statusChanged();
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    const minutes = this.bot.cfg.agent.idleMinutes;
    if (!minutes) return;
    this.idleTimer = setTimeout(() => {
      if (this.busy || this.queue.length) return this.armIdle();
      this.log.info(`idle for ${minutes} min; closing the agent process (the session resumes on the next message)`);
      this.session?.close('idle');
      this.session = undefined;
      this.bot.statusChanged();
    }, minutes * 60_000);
  }

  // ── queue ─────────────────────────────────────────────────

  enqueue(input: PendingInput): void {
    clearTimeout(this.idleTimer);
    this.queue.push(input);
    if (this.busy && input.trigger && !input.quiet) {
      const r = this.bot.cfg.feedback.reactions;
      void this.bot.marks.swap(input.trigger.channelId, input.trigger.messageId, [r.received], r.queued);
    }
    this.bot.statusChanged();
    void this.pump();
  }

  private takeBatch(): PendingInput[] {
    const first = this.queue.shift()!;
    if (first.job || first.quiet || first.kind === 'schedule' || first.kind === 'internal') return [first];
    const batch = [first];
    while (this.queue.length && batch.length < 6) {
      const next = this.queue[0];
      if (next.job || next.quiet || next.kind === 'schedule' || next.kind === 'internal') break;
      batch.push(this.queue.shift()!);
    }
    return batch;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const batch = this.takeBatch();
        try {
          if (batch[0].job) await batch[0].job();
          else await this.runBatch(batch);
        } catch (err) {
          this.log.error('turn failed:', err);
        }
      }
    } finally {
      this.running = false;
      this.armIdle();
      this.bot.statusChanged();
    }
  }

  private async waitIdleSession(session: AgentSession): Promise<void> {
    while (session.busy) await sleep(400);
  }

  private notebookText(): string {
    const index = path.join(this.bot.paths.notebook, 'NOTEBOOK.md');
    let content = '';
    try {
      content = fs.readFileSync(index, 'utf8');
    } catch { /* not written yet */ }
    return notebookBlock(index, content);
  }

  private sinkFor(view: TurnView | undefined): TurnSink {
    const base = view?.sink ?? QUIET_SINK;
    return {
      ...base,
      compacted: (info: CompactInfo) => {
        this.onCompacted(info);
        base.compacted(info);
      },
    };
  }

  private onCompacted(info: CompactInfo): void {
    this.needsNotebook = true;
    this.compactions++;
    const sid = this.session?.info().sessionId;
    if (sid) this.bot.archive.countCompaction(sid);
    this.bot.archive.addEvent(this.key, 'compact', info);
    this.log.info(`context compacted (${info.trigger}): ${info.preTokens} → ${info.postTokens ?? '?'} tokens`);
  }

  private async runBatch(batch: PendingInput[]): Promise<void> {
    const session = this.ensureSession();
    await this.waitIdleSession(session);
    const triggers = batch.map((b) => b.trigger).filter((t): t is TriggerRef => Boolean(t));
    const main = triggers.at(-1);
    const quiet = batch.every((b) => b.quiet);
    const turn: TurnContext = {
      id: newTurnId(),
      conv: this.key,
      channelId: main?.channelId ?? this.channelId,
      triggers,
      main,
      startedAt: Date.now(),
      quiet,
      label: batch.find((b) => b.label)?.label,
    };
    const view = quiet ? undefined : this.makeView(turn);
    this.turn = turn;
    this.view = view;
    await view?.begin();
    let text = batch.map((b) => b.text).join('\n\n');
    if (this.needsNotebook) {
      text = `${this.notebookText()}\n\n${text}`;
      this.needsNotebook = false;
    }
    const images = batch.flatMap((b) => b.images ?? []);
    let outcome: TurnOutcome;
    try {
      outcome = await session.run({ text, images }, this.sinkFor(view));
    } catch (err) {
      outcome = { status: 'error', text: '', fullText: '', error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - turn.startedAt };
    }
    if (outcome.freshSession) {
      this.needsNotebook = false;
      this.bot.archive.addEvent(this.key, 'fresh_session', { reason: 'resume failed' });
    }
    const replies = view ? await view.finish(outcome) : [];
    this.turn = undefined;
    this.view = undefined;
    const seen = Math.max(0, ...batch.map((b) => b.seenTs ?? 0));
    this.record(turn, outcome, replies, text, seen || undefined);
    if (outcome.status === 'ok' && !quiet) this.maybeAutoCompact();
  }

  private makeView(turn: TurnContext): TurnView {
    return new TurnView({
      platform: this.bot.platform,
      marks: this.bot.marks,
      cfg: this.bot.cfg,
      log: this.log,
      turn,
      info: () => this.info(),
      refresh: async () => this.session?.refreshContext(),
      stopButtonId: `stop:${this.key}`,
      inboxDir: this.bot.paths.inbox,
      onReply: (ids, text) => this.bot.recordSent(turn.channelId, ids, text, turn.id),
    });
  }

  private record(turn: TurnContext, outcome: TurnOutcome, replies: string[], input: string, seenTs?: number): void {
    const info = this.info();
    this.bot.state.update(() => {
      this.st.lastActiveAt = Date.now();
      if (seenTs && seenTs > (this.st.lastSeenTs ?? 0)) this.st.lastSeenTs = seenTs;
      if (turn.channelId) this.st.channelId = turn.channelId;
    });
    this.bot.archive.saveTurn({
      id: turn.id,
      conv: this.key,
      channelId: turn.channelId,
      sessionId: outcome.sessionId,
      startedAt: turn.startedAt,
      endedAt: Date.now(),
      status: outcome.status,
      model: info.model,
      effort: info.effort ? String(info.effort) : undefined,
      triggerIds: turn.triggers.map((t) => t.messageId),
      replyIds: replies,
      costUsd: outcome.costUsd,
      ctxPercent: info.ctxPercent,
      ctxTokens: info.ctxTokens,
      durationMs: outcome.durationMs,
      error: outcome.error,
      input: input.length > 20000 ? input.slice(0, 20000) : input,
    });
    this.log.info(
      `turn ${turn.id} ${outcome.status} in ${Math.round(outcome.durationMs / 1000)}s` +
        (info.ctxPercent !== undefined ? `, ctx ${info.ctxPercent}%` : '') +
        (outcome.error ? `: ${oneLine(outcome.error, 200)}` : ''),
    );
  }

  /** A turn the agent started by itself (e.g. a background task finished). */
  private backgroundTurn(): { sink: TurnSink; done: (o: TurnOutcome) => void } {
    const turn: TurnContext = {
      id: newTurnId(),
      conv: this.key,
      channelId: this.channelId,
      triggers: [],
      startedAt: Date.now(),
      quiet: false,
      label: 'background task',
    };
    const view = this.makeView(turn);
    this.turn = turn;
    this.view = view;
    void view.begin();
    return {
      sink: this.sinkFor(view),
      done: (o) => {
        void view.finish(o).then((ids) => {
          if (this.turn === turn) {
            this.turn = undefined;
            this.view = undefined;
          }
          this.record(turn, o, ids, '(background)');
        });
      },
    };
  }

  private offerSuggestion(text: string): void {
    if (!this.bot.cfg.feedback.promptSuggestions) return;
    const last = this.bot.archive.read({ channelId: this.channelId, limit: 5 }).reverse().find((r) => r.isSelf);
    if (!last) return;
    this.suggestions.set(last.messageId, text);
    void this.bot.platform
      .edit(this.channelId, last.messageId, { buttons: [[{ id: 'sg', label: text, emoji: '💡', style: 'secondary' }]] })
      .catch(() => {});
  }

  // ── controls ──────────────────────────────────────────────

  async interrupt(): Promise<boolean> {
    if (!this.session?.busy) return false;
    this.bot.prompts.cancelAll('Stopped.');
    await this.session.interrupt();
    return true;
  }

  async setModel(model: string | undefined): Promise<void> {
    this.bot.state.update(() => (this.st.model = model));
    await this.session?.setModel(model);
  }

  async setEffort(effort: Effort | undefined): Promise<void> {
    this.bot.state.update(() => (this.st.effort = effort));
    await this.session?.setEffort(effort);
  }

  private async quietTurn(text: string): Promise<TurnOutcome> {
    const session = this.ensureSession();
    await this.waitIdleSession(session);
    this.turn = { id: newTurnId(), conv: this.key, channelId: this.channelId, triggers: [], startedAt: Date.now(), quiet: true };
    try {
      const prefix = this.needsNotebook ? `${this.notebookText()}\n\n` : '';
      this.needsNotebook = false;
      return await session.run({ text: prefix + text }, this.sinkFor(undefined));
    } finally {
      this.turn = undefined;
    }
  }

  /** Saves notes, then compacts. Runs in queue order. */
  compact(opts: { focus?: string; trigger: 'manual' | 'auto'; by?: string; channelId?: string; onDone?: (msg: string) => void }): void {
    this.enqueue({
      kind: 'internal',
      text: '',
      ts: Date.now(),
      job: async () => {
        const channel = opts.channelId ?? this.channelId;
        if (!this.session && !this.st.sessionId) {
          opts.onDone?.('Nothing to compact yet.');
          return;
        }
        const notice = await this.bot.platform
          .send(channel, { text: `-# 🗜️ Compacting the conversation${this.bot.cfg.agent.saveBeforeCompact ? ' (saving notes first)' : ''}…`, silent: true })
          .catch(() => [] as string[]);
        if (this.bot.cfg.agent.saveBeforeCompact) {
          await this.quietTurn(saveNotesPrompt('compact', path.join(this.bot.paths.notebook, 'NOTEBOOK.md')));
        }
        const session = this.ensureSession();
        await this.waitIdleSession(session);
        let info: CompactInfo | undefined;
        this.turn = { id: newTurnId(), conv: this.key, channelId: channel, triggers: [], startedAt: Date.now(), quiet: true };
        const outcome = await session.command(opts.focus ? `/compact ${opts.focus}` : '/compact', {
          ...QUIET_SINK,
          compacted: (i) => {
            info = i;
            this.onCompacted(i);
          },
        });
        this.turn = undefined;
        this.needsNotebook = true;
        await session.refreshContext();
        const after = this.info();
        const msg =
          outcome.status === 'ok'
            ? `🗜️ Compacted${info ? ` ${tokensLabel(info.preTokens)} → ${tokensLabel(info.postTokens ?? after.ctxTokens)} tokens` : ''}, ${opts.trigger === 'auto' ? 'automatically' : `by ${opts.by ?? 'request'}`}. Notes were saved first; everything said before stays searchable in the archive.`
            : `⚠️ Compaction failed: ${oneLine(outcome.error ?? 'unknown error', 200)}`;
        if (notice[0]) await this.bot.platform.edit(channel, notice[0], { text: `-# ${msg}` }).catch(() => {});
        opts.onDone?.(msg);
        this.bot.statusChanged();
      },
    });
  }

  private maybeAutoCompact(): void {
    const pct = this.info().ctxPercent;
    if (pct === undefined || pct < this.bot.cfg.agent.compactAtPercent) return;
    if (this.queue.some((q) => q.job)) return;
    this.log.info(`context at ${pct}% (≥ ${this.bot.cfg.agent.compactAtPercent}%); compacting`);
    this.compact({ trigger: 'auto' });
  }

  /** Saves notes, then drops the session; the next message starts a new one. */
  reset(opts: { by?: string; channelId?: string; onDone?: (msg: string) => void }): void {
    this.enqueue({
      kind: 'internal',
      text: '',
      ts: Date.now(),
      job: async () => {
        const channel = opts.channelId ?? this.channelId;
        const old = this.st.sessionId;
        if (old && this.bot.cfg.agent.saveBeforeCompact) {
          await this.quietTurn(saveNotesPrompt('reset', path.join(this.bot.paths.notebook, 'NOTEBOOK.md')));
        }
        this.close('reset');
        if (old) this.bot.archive.endSession(old, 'reset');
        this.bot.state.update(() => (this.st.sessionId = undefined));
        this.compactions = 0;
        this.bot.archive.addEvent(this.key, 'reset', { by: opts.by, old });
        const msg = `🧹 Fresh session${opts.by ? ` (reset by ${opts.by})` : ''}. The old one stays in the archive and in Claude Code's history${old ? ` (${old})` : ''}.`;
        await this.bot.platform.send(channel, { text: `-# ${msg}`, silent: true }).catch(() => {});
        opts.onDone?.(msg);
      },
    });
  }
}
