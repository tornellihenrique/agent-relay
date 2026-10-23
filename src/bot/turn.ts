import fs from 'node:fs';
import path from 'node:path';
import type { SessionInfo, TurnOutcome, TurnSink } from '../agent/types.js';
import { tokensLabel } from '../agent/models.js';
import { throttle } from '../core/async.js';
import type { BotConfig } from '../core/config.js';
import type { Logger } from '../core/log.js';
import { formatDuration, oneLine, tail, truncate } from '../core/text.js';
import { quoteBlock } from '../platform/markdown.js';
import type { ButtonSpec, Platform } from '../platform/types.js';
import type { Marks } from './marks.js';
import { toolLabel } from './tool-labels.js';

export type PendingKind = 'message' | 'reaction' | 'summon' | 'choice' | 'schedule' | 'internal' | 'command';

export interface TriggerRef {
  channelId: string;
  messageId: string;
  userId?: string;
  userName?: string;
  kind: PendingKind;
}

export interface ChoiceOffer {
  question?: string;
  options: { label: string; description?: string; emoji?: string; style?: 'primary' | 'secondary' | 'success' | 'danger' }[];
  allowOther: boolean;
}

/** The turn a session is running, shared with the relay tools (react, offer_choices...). */
export interface TurnContext {
  id: string;
  conv: string;
  channelId: string;
  triggers: TriggerRef[];
  main?: TriggerRef;
  choices?: ChoiceOffer;
  finalReaction?: string;
  /** The agent reacted to the main trigger itself (react tool). */
  agentReacted?: boolean;
  startedAt: number;
  /** No Discord output at all (notebook saves before compaction). */
  quiet: boolean;
  label?: string;
}

interface ToolRow {
  id: string;
  emoji: string;
  text: string;
  state: 'running' | 'ok' | 'error';
  sub: boolean;
}

export interface TurnViewOptions {
  platform: Platform;
  marks: Marks;
  cfg: BotConfig;
  log: Logger;
  turn: TurnContext;
  info: () => SessionInfo;
  refresh: () => Promise<void>;
  stopButtonId: string;
  inboxDir: string;
  onReply: (ids: string[], text: string) => void;
}

const NO_REPLY = /\bNO_REPLY\b\.?|<no[_-]?reply\s*\/?>/gi;
const MAX_INLINE_ANSWER = 9000;

/**
 * Everything the user sees while a turn runs: reactions on the triggering message, the typing
 * indicator, the live "working" message (reasoning + tool calls, with a Stop button), and the
 * final answer with its completion reaction.
 */
export class TurnView {
  readonly sink: TurnSink;
  private thinking = '';
  private writing = '';
  private tools: ToolRow[] = [];
  private phase: 'starting' | 'thinking' | 'tool' | 'writing' | 'waiting' | 'compacting' = 'starting';
  private waitingLabel = '';
  private retryNote = '';
  private liveId: string | undefined;
  private liveCreating: Promise<void> | undefined;
  private typingTimer: NodeJS.Timeout | undefined;
  private liveTimer: NodeJS.Timeout | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
  private reaction: string | undefined;
  private finished = false;
  private compactNote = '';
  private postponed = false;
  private readonly render = throttle(2200, () => this.renderLive());
  private readonly setReaction = throttle(2500, (emoji: string) => this.applyReaction(emoji));

  constructor(private o: TurnViewOptions) {
    const self = this;
    this.sink = {
      thinking(delta) {
        self.thinking += delta;
        self.setPhase('thinking');
      },
      text(delta) {
        self.writing += delta;
        self.setPhase('writing');
      },
      toolStart(t) {
        const label = toolLabel(t.name, t.input, o.cfg.context);
        self.tools.push({ id: t.id, emoji: label.emoji, text: label.text, state: 'running', sub: Boolean(t.parentId) });
        if (!t.parentId) {
          self.writing = '';
          if (self.thinking && !self.thinking.endsWith('\n')) self.thinking += '\n\n';
        }
        self.phase = 'tool';
        if (label.reaction && o.cfg.feedback.toolReactions && !t.parentId) self.setReaction(label.reaction);
        self.render();
      },
      toolEnd(id, ok) {
        const row = self.tools.find((r) => r.id === id);
        if (row) row.state = ok ? 'ok' : 'error';
        self.render();
      },
      compacted(info) {
        self.compactNote = `🗜️ context compacted (${tokensLabel(info.preTokens)} → ${tokensLabel(info.postTokens)})`;
        self.render();
      },
      status(status, detail) {
        if (status === 'compacting') self.phase = 'compacting';
        if (status === 'retrying') self.retryNote = `⏳ API retry ${detail ?? ''}`;
        self.render();
      },
    };
  }

  private get turn(): TurnContext {
    return this.o.turn;
  }

  private setPhase(phase: TurnView['phase']): void {
    if (this.phase !== phase) {
      this.phase = phase;
      if (phase === 'thinking') this.setReaction(this.o.cfg.feedback.reactions.thinking);
      if (phase === 'writing') this.setReaction(this.o.cfg.feedback.reactions.writing);
    }
    this.render();
  }

  // ── lifecycle ─────────────────────────────────────────────

  async begin(): Promise<void> {
    if (this.turn.quiet) return;
    const r = this.o.cfg.feedback.reactions;
    const main = this.turn.main;
    if (main) {
      // The received/queued marks were added when the event arrived; the main trigger now shows progress.
      void this.o.marks.swap(main.channelId, main.messageId, [r.received, r.queued], r.thinking);
      this.reaction = r.thinking;
      for (const t of this.turn.triggers) {
        if (t !== main) void this.o.marks.swap(t.channelId, t.messageId, [r.queued], r.received);
      }
    }
    const typing = () => void this.o.platform.typing(this.turn.channelId).catch(() => {});
    typing();
    this.typingTimer = setInterval(typing, 8000);
    this.liveTimer = setTimeout(() => void this.ensureLive(), this.o.cfg.feedback.liveAfterSeconds * 1000);
  }

  /** Shows that the turn waits on a person (a question or a permission prompt). */
  waiting(label: string | undefined): void {
    if (this.turn.quiet) return;
    if (label) {
      this.waitingLabel = label;
      this.phase = 'waiting';
      this.setReaction(this.o.cfg.feedback.reactions.waiting);
    } else {
      this.waitingLabel = '';
      this.phase = 'thinking';
    }
    this.render();
  }

  private async ensureLive(): Promise<void> {
    if (this.finished || this.liveId || this.turn.quiet) return;
    // The answer is already being written: wait a bit rather than flash a message that is deleted right away.
    if (this.phase === 'writing' && !this.postponed) {
      this.postponed = true;
      this.liveTimer = setTimeout(() => void this.ensureLive(), 4000);
      return;
    }
    this.liveCreating ??= (async () => {
      try {
        const [id] = await this.o.platform.send(this.turn.channelId, {
          text: this.liveText(),
          replyTo: this.turn.main?.channelId === this.turn.channelId ? this.turn.main.messageId : undefined,
          silent: true,
          buttons: this.liveButtons(),
        });
        this.liveId = id;
        if (this.finished) await this.removeLive();
        else this.tickTimer = setInterval(() => this.render(), 10_000);
      } catch (err) {
        this.o.log.warn('could not post the live message:', err);
      }
    })();
    await this.liveCreating;
  }

  private liveButtons(): ButtonSpec[][] {
    return [[{ id: this.o.stopButtonId, label: 'Stop', emoji: '⏹️', style: 'secondary' }]];
  }

  private liveText(): string {
    const elapsed = formatDuration(Date.now() - this.turn.startedAt);
    const main = this.tools.filter((t) => !t.sub);
    const subs = this.tools.length - main.length;
    const label = {
      starting: '🤔 Starting',
      thinking: '🤔 Thinking',
      tool: '🛠️ Working',
      writing: '✍️ Writing the answer',
      waiting: `🙋 ${this.waitingLabel || 'Waiting for an answer'}`,
      compacting: '🗜️ Compacting context',
    }[this.phase];
    const counts = [elapsed, main.length ? `${main.length} tool${main.length === 1 ? '' : 's'}` : '', subs ? `${subs} in subagents` : '']
      .filter(Boolean)
      .join(' · ');
    const lines = [`**${label}…** · ${this.turn.label ? `${this.turn.label} · ` : ''}${counts}`];
    const reasoning = this.thinking.trim();
    if (reasoning) lines.push(quoteBlock(tail(reasoning, 900)));
    if (main.length) {
      const shown = main.slice(-7);
      const hidden = main.length - shown.length;
      const rows = shown.map((t) => `${t.state === 'running' ? '⏳' : t.state === 'ok' ? '✓' : '✗'} ${t.emoji} ${truncate(t.text, 90)}`);
      if (hidden > 0) rows.unshift(`-# … ${hidden} earlier`);
      lines.push(rows.join('\n'));
    }
    if (this.phase === 'writing' && this.writing.trim()) lines.push(`-# ${oneLine(tail(this.writing, 160), 160)}`);
    if (this.compactNote) lines.push(`-# ${this.compactNote}`);
    if (this.retryNote) lines.push(`-# ${this.retryNote}`);
    return truncate(lines.join('\n'), 1950);
  }

  private async renderLive(): Promise<void> {
    if (this.finished || this.turn.quiet) return;
    if (!this.liveId) return;
    try {
      await this.o.platform.edit(this.turn.channelId, this.liveId, { text: this.liveText(), buttons: this.liveButtons() });
    } catch (err) {
      this.o.log.debug('live edit failed:', err);
    }
  }

  private async removeLive(): Promise<void> {
    const id = this.liveId;
    this.liveId = undefined;
    if (id) await this.o.platform.delete(this.turn.channelId, id).catch(() => {});
  }

  // ── reactions ─────────────────────────────────────────────

  private async applyReaction(emoji: string): Promise<void> {
    const main = this.turn.main;
    if (this.finished || !main || this.turn.quiet || emoji === this.reaction) return;
    const old = this.reaction;
    this.reaction = emoji;
    await this.o.marks.swap(main.channelId, main.messageId, old ? [old] : [], emoji);
  }

  // ── the end ───────────────────────────────────────────────

  private stopTimers(): void {
    this.finished = true;
    clearInterval(this.typingTimer);
    clearTimeout(this.liveTimer);
    clearInterval(this.tickTimer);
    this.render.cancel();
    this.setReaction.cancel();
  }

  private footer(o: TurnOutcome, info: SessionInfo): string | undefined {
    const mode = this.o.cfg.feedback.footer;
    const main = this.tools.filter((t) => !t.sub).length;
    if (mode === 'never') return undefined;
    if (mode === 'auto' && o.durationMs < 20_000 && main < 3) return undefined;
    const bits = [
      info.modelLabel,
      info.effort ? String(info.effort) : undefined,
      formatDuration(o.durationMs),
      main ? `${main} tool${main === 1 ? '' : 's'}` : undefined,
      info.ctxPercent !== undefined ? `ctx ${Math.round(info.ctxPercent)}%` : undefined,
      this.o.cfg.agent.auth === 'apiKey' && o.costUsd ? `$${o.costUsd.toFixed(2)}` : undefined,
    ];
    return `-# ${bits.filter(Boolean).join(' · ')}`;
  }

  private choiceButtons(): ButtonSpec[][] {
    const c = this.turn.choices;
    if (!c) return [];
    const buttons: ButtonSpec[] = c.options.slice(0, 19).map((opt, i) => ({
      id: `ch:${i}`,
      label: opt.label,
      emoji: opt.emoji,
      style: opt.style ?? (i === 0 ? 'primary' : 'secondary'),
    }));
    if (c.allowOther) buttons.push({ id: 'ch:other', label: 'Other…', emoji: '✏️', style: 'secondary' });
    const rows: ButtonSpec[][] = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push(buttons.slice(i, i + 5));
    return rows.slice(0, 4);
  }

  /** Posts the answer and settles the reactions. Returns the ids of the messages posted. */
  async finish(o: TurnOutcome): Promise<string[]> {
    this.stopTimers();
    await this.liveCreating;
    const r = this.o.cfg.feedback.reactions;
    const p = this.o.platform;
    const main = this.turn.main;
    if (this.turn.quiet) return [];

    await this.o.refresh().catch(() => {});
    const info = this.o.info();
    let ids: string[] = [];
    let finalEmoji = r.done;

    try {
      if (o.status === 'ok') {
        const answer = o.text.replace(NO_REPLY, '').trim();
        const silent = !answer;
        await this.removeLive();
        if (!silent || this.turn.choices) {
          ids = await this.postAnswer(answer, o, info);
        }
        if (this.turn.finalReaction) finalEmoji = this.turn.finalReaction;
        // A silent turn where the agent answered with its own reaction needs no ✅ next to it.
        else if (silent && this.turn.agentReacted) finalEmoji = '';
      } else if (o.status === 'interrupted') {
        finalEmoji = r.stopped;
        const note = `⏹️ Stopped after ${formatDuration(o.durationMs)}.`;
        if (this.liveId) {
          await p.edit(this.turn.channelId, this.liveId, { text: `${this.liveText().split('\n').slice(1).join('\n')}\n${note}`.trim() });
          ids = [this.liveId];
          this.liveId = undefined;
        } else if (main) {
          ids = await p.send(this.turn.channelId, { text: note, replyTo: main.messageId, silent: true });
        }
      } else {
        finalEmoji = r.error;
        await this.removeLive();
        ids = await p.send(this.turn.channelId, {
          text: errorText(o.error ?? 'unknown error'),
          replyTo: main?.messageId,
          silent: true,
        });
      }
    } catch (err) {
      this.o.log.error('could not deliver the answer:', err);
      finalEmoji = r.error;
    }

    for (const t of this.turn.triggers) {
      await this.o.marks.settle(t.channelId, t.messageId, t === main ? finalEmoji || undefined : r.done);
    }
    return ids;
  }

  private async postAnswer(answer: string, o: TurnOutcome, info: SessionInfo): Promise<string[]> {
    const main = this.turn.main;
    const footer = this.footer(o, info);
    let text = answer;
    const files: { path: string; name: string }[] = [];
    if (text.length > MAX_INLINE_ANSWER) {
      const file = path.join(this.o.inboxDir, `answer-${this.turn.id}.md`);
      fs.mkdirSync(this.o.inboxDir, { recursive: true });
      fs.writeFileSync(file, answer, 'utf8');
      files.push({ path: file, name: 'answer.md' });
      text = `${truncate(answer, 3500)}\n\n-# The full answer is in the attached file.`;
    }
    const choices = this.turn.choices;
    const question = choices?.question?.trim();
    const asksAlready = /\?\s*$/.test(text.trim()) || text.toLowerCase().includes(question?.toLowerCase() ?? '\0');
    if (question && !asksAlready) text = `${text}\n\n**${question}**`.trim();
    // The buttons only carry short labels: list what each one does.
    if (choices?.options.some((opt) => opt.description)) {
      const list = choices.options
        .map((opt) => `- ${opt.emoji ? `${opt.emoji} ` : ''}**${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`)
        .join('\n');
      text = `${text}\n${list}`.trim();
    }
    if (footer) text = `${text}\n${footer}`;
    const ping = o.durationMs >= this.o.cfg.feedback.pingAfterSeconds * 1000;
    const ids = await this.o.platform.send(this.turn.channelId, {
      text: text.trim() || undefined,
      replyTo: main?.channelId === this.turn.channelId ? main.messageId : undefined,
      ping,
      buttons: this.choiceButtons(),
      files,
    });
    this.o.onReply(ids, answer);
    return ids;
  }
}

function errorText(error: string): string {
  const first = oneLine(error.split('\n')[0], 300);
  let hint = '';
  if (/not logged in|\/login|authentication_failed|invalid api key|401/i.test(error)) {
    hint = '\n-# The agent is not logged in on the host. Run `claude` there and log in (or fix the API key), then retry.';
  } else if (/rate.?limit|usage limit|429/i.test(error)) {
    hint = '\n-# Usage limit reached. Try again later.';
  } else if (/overloaded|529|5\d\d/.test(error)) {
    hint = '\n-# The API is having trouble. Try again in a moment.';
  }
  const details = error.includes('\n') ? `\n-# ${oneLine(error.split('\n').slice(1).join(' '), 300)}` : '';
  return `⚠️ ${first}${hint}${details}`;
}
