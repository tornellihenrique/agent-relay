import fs from 'node:fs';
import path from 'node:path';
import type { AgentImage, SessionInfo } from '../agent/types.js';
import { modelLabel, windowLabel } from '../agent/models.js';
import { Archive, type ArchiveRow, type ScheduleRow } from '../core/archive.js';
import { throttle } from '../core/async.js';
import { patchBotConfig, type BotConfig, type TriggerMode } from '../core/config.js';
import { logger, type Logger } from '../core/log.js';
import { botPaths, ensureDir, writeJsonAtomic, type BotPaths } from '../core/paths.js';
import { StateStore } from '../core/state.js';
import { truncate } from '../core/text.js';
import { DiscordPlatform } from '../platform/discord.js';
import { STOP_EMOJI } from '../platform/emoji.js';
import type { ChatMessage, ChatRef, EmojiRef, Interaction, Platform, PlatformEvent, UserRef } from '../platform/types.js';
import { handleCommand, COMMANDS } from './commands.js';
import { Conversation, type BotRuntime, type PendingInput } from './conversation.js';
import {
  channelContext,
  choiceEnvelope,
  messageEnvelope,
  reactionEnvelope,
  scheduleEnvelope,
  summonEnvelope,
  type EnvelopeContext,
  type SavedFile,
} from './envelope.js';
import { buildInstructions, NOTEBOOK_TEMPLATE } from './instructions.js';
import { Marks } from './marks.js';
import { Prompts } from './prompts.js';
import { Scheduler } from './scheduler.js';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_FILE = 25 * 1024 * 1024;
const REACTION_DEBOUNCE_MS = 2500;

export interface ConversationStatus {
  key: string;
  channelId: string;
  busy: boolean;
  alive: boolean;
  queued: number;
  model?: string;
  modelLabel?: string;
  effort?: string;
  ctxPercent?: number;
  sessionId?: string;
  lastActiveAt?: number;
}

export interface BotStatus {
  id: string;
  name: string;
  state: 'starting' | 'running' | 'stopping' | 'error';
  pid: number;
  startedAt: number;
  user?: string;
  presence?: string;
  presenceState?: string;
  conversations: ConversationStatus[];
  error?: string;
  inviteUrl?: string;
  rateLimits?: SessionInfo['rateLimits'];
  updatedAt: number;
}

function archivedToChat(r: ArchiveRow): ChatMessage {
  return {
    id: r.messageId,
    chat: { platform: r.platform, channelId: r.channelId, isDM: false, name: r.channelName },
    author: { id: r.authorId ?? '?', name: r.authorName ?? '?', isBot: Boolean(r.isSelf) },
    text: r.text,
    ts: r.ts,
    replyToId: r.replyTo,
    attachments: [],
    mentionsSelf: false,
    fromSelf: Boolean(r.isSelf),
  };
}

export class Bot implements BotRuntime {
  readonly paths: BotPaths;
  readonly archive: Archive;
  readonly state: StateStore;
  readonly platform: Platform;
  readonly scheduler: Scheduler;
  readonly prompts: Prompts;
  readonly log: Logger;
  readonly owners: Set<string>;
  readonly marks: Marks;
  private conversations = new Map<string, Conversation>();
  private reactionBuffers = new Map<string, { timer: NodeJS.Timeout; items: { emoji: EmojiRef; user: UserRef; messageId: string; chat: ChatRef; ts: number }[] }>();
  private recentTriggers = new Set<string>();
  private startedAt = Date.now();
  private stateName: BotStatus['state'] = 'starting';
  private lastError: string | undefined;
  private instructionsText: string | undefined;
  private readonly pushStatus = throttle(4000, () => this.publishStatus());

  constructor(
    readonly cfg: BotConfig,
    private report: (status: BotStatus) => void = () => {},
    platform?: Platform,
  ) {
    this.paths = botPaths(cfg.id, cfg.memory.notebook);
    this.log = logger(cfg.id);
    this.owners = new Set(cfg.owners);
    ensureDir(this.paths.notebook);
    ensureDir(this.paths.inbox);
    const index = path.join(this.paths.notebook, 'NOTEBOOK.md');
    if (!fs.existsSync(index)) fs.writeFileSync(index, NOTEBOOK_TEMPLATE, 'utf8');
    this.archive = new Archive(this.paths.db);
    this.state = new StateStore(this.paths.state);
    this.platform = platform ?? new DiscordPlatform(cfg.platform, this.log.child('discord'));
    this.marks = new Marks(this.platform);
    this.prompts = new Prompts(this.platform, this.log.child('prompts'), {
      permissionTimeoutMs: 10 * 60_000,
      questionTimeoutMs: 30 * 60_000,
    });
    this.scheduler = new Scheduler(this.archive, cfg, (row) => this.onSchedule(row), this.log.child('scheduler'));
  }

  // ── lifecycle ─────────────────────────────────────────────

  async start(): Promise<void> {
    this.publishStatus();
    if (!fs.existsSync(this.cfg.context)) throw new Error(`context folder does not exist: ${this.cfg.context}`);
    await this.platform.start((e) => this.onEvent(e));
    if (this.cfg.platform.slashCommands) {
      await this.platform.registerCommands(COMMANDS).catch((err) => this.log.warn('could not register slash commands:', err));
    }
    this.scheduler.start();
    this.stateName = 'running';
    this.statusChanged();
    if (this.cfg.agent.warmStart) void this.warmStart();
  }

  private async warmStart(): Promise<void> {
    const convs = Object.entries(this.state.state.conversations)
      .filter(([, c]) => c.channelId)
      .sort((a, b) => (b[1].lastActiveAt ?? 0) - (a[1].lastActiveAt ?? 0));
    let target: { key: string; channelId: string } | undefined;
    if (convs.length) target = { key: convs[0][0], channelId: convs[0][1].channelId! };
    else if (this.cfg.platform.channels.length) {
      const channelId = this.cfg.platform.channels[0];
      const chat = await this.platform.describeChat(channelId);
      if (chat && !chat.isDM) target = { key: this.convKey(chat), channelId };
    }
    if (!target) return;
    try {
      this.log.info(`warming up the agent for ${target.key}`);
      await this.conversation(target.key, target.channelId).warm();
    } catch (err) {
      this.log.warn('warm start failed:', err);
    }
  }

  async stop(reason = 'stopping'): Promise<void> {
    this.stateName = 'stopping';
    this.publishStatus();
    this.prompts.cancelAll('The bot is restarting.');
    this.scheduler.stop();
    for (const c of this.conversations.values()) {
      await c.interrupt().catch(() => false);
      c.close(reason);
    }
    await this.platform.setPresence({ state: 'idle', text: `${this.label()} | offline` }).catch(() => {});
    await this.platform.stop();
    this.state.flush();
    this.archive.close();
  }

  fail(err: unknown): void {
    this.stateName = 'error';
    this.lastError = err instanceof Error ? err.message : String(err);
    this.publishStatus();
  }

  // ── runtime services ──────────────────────────────────────

  instructions(): string {
    this.instructionsText ??= buildInstructions({
      cfg: this.cfg,
      selfId: this.platform.selfId,
      selfName: this.platform.selfName,
      notebookDir: this.paths.notebook,
      inboxDir: this.paths.inbox,
    });
    return this.instructionsText;
  }

  envelope(): EnvelopeContext {
    return { timezone: this.cfg.timezone, owners: this.owners, selfId: this.platform.selfId };
  }

  rememberMcpServers(names: string[]): void {
    const known = new Set(this.state.state.knownMcpServers);
    const before = known.size;
    for (const n of names) known.add(n);
    if (known.size !== before) this.state.update((s) => (s.knownMcpServers = [...known].sort()));
  }

  recordSent(channelId: string, ids: string[], text: string, turnId?: string): void {
    ids.forEach((id, i) => {
      this.archive.upsertMessage({
        platform: this.platform.name,
        channelId,
        messageId: id,
        authorId: this.platform.selfId,
        authorName: this.platform.selfName,
        isSelf: true,
        kind: 'message',
        text: i === 0 ? text : `(continued) ${text.slice(0, 200)}`,
        ts: Date.now(),
        turnId,
      });
    });
  }

  /** Whether a chat is one the bot serves. */
  allowedChat(chat: ChatRef, userId?: string): boolean {
    const p = this.cfg.platform;
    if (userId && p.blockedUsers.includes(userId)) return false;
    if (chat.isDM) return Boolean(userId && (p.users.includes(userId) || this.owners.has(userId)));
    const ids = [chat.channelId, ...(chat.ancestors ?? [])];
    if (p.channels.some((c) => ids.includes(c))) return true;
    return Boolean(userId && p.users.includes(userId));
  }

  async inScope(channelId: string): Promise<boolean> {
    if (Object.values(this.state.state.conversations).some((c) => c.channelId === channelId)) return true;
    const chat = await this.platform.describeChat(channelId);
    return Boolean(chat && this.allowedChat(chat));
  }

  private convKey(chat: ChatRef): string {
    return this.cfg.conversation.scope === 'bot' ? 'main' : `${chat.platform}:${chat.channelId}`;
  }

  conversation(key: string, channelId: string): Conversation {
    let c = this.conversations.get(key);
    if (!c) {
      c = new Conversation(key, channelId, this);
      this.conversations.set(key, c);
    }
    return c;
  }

  conversationFor(chat: ChatRef): Conversation {
    const c = this.conversation(this.convKey(chat), chat.channelId);
    if (this.cfg.conversation.scope === 'channel') c.channelId = chat.channelId;
    return c;
  }

  allConversations(): Conversation[] {
    return [...this.conversations.values()];
  }

  /**
   * Changes the bot's default model or effort (saved in bot.json) and makes every channel follow it,
   * dropping the per-channel values set before.
   */
  async setBotDefault(what: 'model' | 'effort', value: string | undefined): Promise<void> {
    patchBotConfig(this.cfg.id, (raw) => {
      raw.agent ??= {};
      if (value) raw.agent[what] = value;
      else delete raw.agent[what];
    });
    if (what === 'model') this.cfg.agent.model = value;
    else this.cfg.agent.effort = value as BotConfig['agent']['effort'];
    this.state.update((s) => {
      for (const c of Object.values(s.conversations)) delete c[what];
    });
    for (const c of this.conversations.values()) await c.useBotDefault(what);
    this.statusChanged();
  }

  triggerMode(chat: ChatRef): TriggerMode {
    const s = this.state.state.triggers;
    const cs = this.cfg.conversation.channelSettings;
    for (const id of [chat.channelId, ...(chat.ancestors ?? [])]) {
      if (s[id]) return s[id];
      if (cs[id]?.trigger) return cs[id].trigger!;
    }
    return this.cfg.conversation.trigger;
  }

  // ── events ────────────────────────────────────────────────

  private onEvent(e: PlatformEvent): void {
    const run = async () => {
      switch (e.type) {
        case 'message':
          return this.onMessage(e.message);
        case 'edit':
          if (this.allowedChat(e.message.chat, e.message.author.id)) this.archiveMessage(e.message);
          return;
        case 'delete':
          // The bot's own deleted messages were transient (live progress); people's deletions stay as a mark.
          if (this.archive.getMessage(this.platform.name, e.messageId)?.isSelf) this.archive.deleteMessage(this.platform.name, e.messageId);
          else this.archive.markDeleted(this.platform.name, e.messageId);
          return;
        case 'reaction':
          return this.onReaction(e);
        case 'interaction':
          return this.onInteraction(e.interaction);
        case 'ready':
          this.statusChanged();
          return;
        case 'disconnected':
          this.log.warn(`disconnected from ${this.platform.name}: ${e.reason}`);
          return;
      }
    };
    run().catch((err) => this.log.error(`error handling ${e.type}:`, err));
  }

  private archiveMessage(m: ChatMessage, force = false): void {
    if (!force && this.cfg.memory.archive !== 'all' && !m.fromSelf && !m.mentionsSelf) return;
    const extra = [m.extra, m.attachments.length ? `[attachments: ${m.attachments.map((a) => a.name).join(', ')}]` : '']
      .filter(Boolean)
      .join('\n');
    this.archive.upsertMessage({
      platform: m.chat.platform,
      channelId: m.chat.channelId,
      channelName: m.chat.name,
      messageId: m.id,
      authorId: m.author.id,
      authorName: m.fromSelf ? this.platform.selfName : m.author.name,
      isSelf: m.fromSelf,
      kind: 'message',
      text: [m.text, extra].filter(Boolean).join('\n') || '(no text)',
      replyTo: m.replyToId,
      ts: m.ts,
    });
  }

  private async isTrigger(m: ChatMessage): Promise<boolean> {
    if (m.fromSelf) return false;
    if (m.author.isBot && !this.cfg.platform.respondToBots) return false;
    if (m.chat.isDM) return true;
    let mode = this.triggerMode(m.chat);
    // A thread started from one of the bot's messages is a conversation with the bot.
    if (mode === 'mentions' && m.chat.parentId && this.archive.getMessage(m.chat.platform, m.chat.channelId)?.isSelf) mode = 'all';
    if (mode === 'off') return false;
    if (mode === 'all' || m.mentionsSelf) return true;
    if (!m.replyToId) return false;
    const archived = this.archive.getMessage(m.chat.platform, m.replyToId);
    if (archived) return Boolean(archived.isSelf);
    const target = await this.platform.fetchMessage(m.chat.channelId, m.replyToId);
    return Boolean(target?.fromSelf);
  }

  private async onMessage(m: ChatMessage): Promise<void> {
    if (!this.allowedChat(m.chat, m.author.id)) return;
    const trigger = await this.isTrigger(m);
    this.archiveMessage(m, trigger);
    if (!trigger) return;
    const conv = this.conversationFor(m.chat);
    // Instant feedback; when the conversation is busy, enqueue() marks it as queued instead.
    if (!conv.busy) void this.marks.add(m.chat.channelId, m.id, this.cfg.feedback.reactions.received);
    this.recentTriggers.add(m.id);
    if (this.recentTriggers.size > 200) this.recentTriggers.delete(this.recentTriggers.values().next().value!);
    const input = await this.messageInput(m, conv);
    conv.enqueue(input);
  }

  private async messageInput(m: ChatMessage, conv: Conversation): Promise<PendingInput> {
    const ctx = this.envelope();
    let replyTo: ChatMessage | null = null;
    if (m.replyToId) {
      replyTo = await this.platform.fetchMessage(m.chat.channelId, m.replyToId);
      if (!replyTo) {
        const row = this.archive.getMessage(m.chat.platform, m.replyToId);
        if (row) replyTo = archivedToChat(row);
      }
    }
    const recent = await this.recentContext(m, conv, replyTo?.id);
    const images: AgentImage[] = [];
    const files = await this.saveAttachments(m, images);
    // The replied-to message's files come along too ("@bot look at these").
    const replyFiles = replyTo?.attachments.length ? await this.saveAttachments(replyTo, images) : undefined;
    const text = [channelContext(m.chat.name, recent, ctx), messageEnvelope(m, ctx, { replyTo, files, replyFiles })].filter(Boolean).join('\n\n');
    return {
      kind: 'message',
      text,
      images,
      trigger: { channelId: m.chat.channelId, messageId: m.id, userId: m.author.id, userName: m.author.name, kind: 'message' },
      ts: m.ts,
      seenTs: m.ts,
    };
  }

  /**
   * Recent messages before the trigger that the agent hasn't seen: at most `recentMessages`, none older than
   * `recentMinutes`. The agent can read further back itself (channel_messages, history_read).
   */
  private async recentContext(m: ChatMessage, conv: Conversation, skipId?: string): Promise<ChatMessage[]> {
    const own = this.cfg.conversation.channelSettings[m.chat.channelId];
    const n = own?.recentMessages ?? this.cfg.conversation.recentMessages;
    const minutes = own?.recentMinutes ?? this.cfg.conversation.recentMinutes;
    if (!n || m.chat.isDM) return [];
    const since = Math.max(conv.st.lastSeenTs ?? 0, minutes ? m.ts - minutes * 60_000 : 0);
    let msgs: ChatMessage[] = [];
    try {
      msgs = await this.platform.fetchHistory(m.chat.channelId, { before: m.id, limit: n });
    } catch (err) {
      this.log.debug('could not fetch recent history:', err);
      msgs = this.archive.read({ channelId: m.chat.channelId, until: m.ts - 1, limit: n }).map(archivedToChat);
    }
    for (const x of msgs) if (this.allowedChat(x.chat, x.author.id)) this.archiveMessage(x);
    return msgs.filter((x) => x.ts > since && !x.fromSelf && x.id !== skipId && x.id !== m.id && !this.recentTriggers.has(x.id));
  }

  /** Downloads a message's attachments to the inbox; up to 4 images per turn (in `images`) are shown to the agent. */
  private async saveAttachments(m: ChatMessage, images: AgentImage[]): Promise<SavedFile[]> {
    const files: SavedFile[] = [];
    for (const a of m.attachments) {
      const isImage = Boolean(a.contentType && IMAGE_TYPES.has(a.contentType.split(';')[0]));
      if (a.size > MAX_FILE) {
        files.push({ name: a.name, kind: isImage ? 'image' : 'file', included: false, note: `too big to download (${Math.round(a.size / 1048576)} MB): ${a.url}` });
        continue;
      }
      try {
        const res = await fetch(a.url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const safe = a.name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(-80);
        const file = path.join(this.paths.inbox, `${m.id}-${safe}`);
        fs.writeFileSync(file, buf);
        const include = isImage && a.size <= MAX_IMAGE && images.length < 4;
        if (include) images.push({ mediaType: a.contentType!.split(';')[0], base64: buf.toString('base64') });
        files.push({ name: a.name, path: file, kind: isImage ? 'image' : 'file', included: include });
      } catch (err) {
        files.push({ name: a.name, kind: isImage ? 'image' : 'file', included: false, note: `download failed: ${(err as Error).message}` });
      }
    }
    return files;
  }

  private async onReaction(e: Extract<PlatformEvent, { type: 'reaction' }>): Promise<void> {
    if (!e.added) return;
    if (e.user.isBot && !this.cfg.platform.respondToBots) return;
    if (!this.allowedChat(e.chat, e.user.id)) return;
    this.archive.upsertMessage({
      platform: e.chat.platform,
      channelId: e.chat.channelId,
      channelName: e.chat.name,
      messageId: `${e.messageId}:${e.user.id}:${e.emoji.value}`,
      authorId: e.user.id,
      authorName: e.user.name,
      kind: 'reaction',
      text: `${e.emoji.value} (${e.emoji.name}) on message ${e.messageId}`,
      replyTo: e.messageId,
      ts: Date.now(),
    });
    const conv = this.conversationFor(e.chat);
    const turn = conv.turn;
    if (STOP_EMOJI.has(e.emoji.value) && turn && turn.triggers.some((t) => t.messageId === e.messageId)) {
      if (this.owners.has(e.user.id) || turn.triggers.some((t) => t.userId === e.user.id)) {
        this.log.info(`${e.user.name} stopped the turn with ${e.emoji.value}`);
        await conv.interrupt();
      }
      return;
    }
    if (e.emoji.value === this.cfg.platform.summonEmoji && !e.onSelf) {
      const target = await this.platform.fetchMessage(e.chat.channelId, e.messageId);
      if (!target) return;
      if (!conv.busy) void this.marks.add(e.chat.channelId, e.messageId, this.cfg.feedback.reactions.received);
      const images: AgentImage[] = [];
      const files = target.attachments.length ? await this.saveAttachments(target, images) : undefined;
      conv.enqueue({
        kind: 'summon',
        text: summonEnvelope(e.user, e.emoji.value, target, this.envelope(), Date.now(), files),
        images,
        trigger: { channelId: e.chat.channelId, messageId: e.messageId, userId: e.user.id, userName: e.user.name, kind: 'summon' },
        ts: Date.now(),
        seenTs: target.ts,
      });
      return;
    }
    if (!e.onSelf) return;
    // Our own feedback marks are not answers.
    const r = this.cfg.feedback.reactions;
    if (Object.values(r).includes(e.emoji.value) && conv.busy) return;
    const key = conv.key;
    const buf = this.reactionBuffers.get(key) ?? { timer: undefined as never, items: [] };
    clearTimeout(buf.timer);
    buf.items.push({ emoji: e.emoji, user: e.user, messageId: e.messageId, chat: e.chat, ts: Date.now() });
    buf.timer = setTimeout(() => {
      this.reactionBuffers.delete(key);
      void this.flushReactions(conv, buf.items);
    }, REACTION_DEBOUNCE_MS);
    this.reactionBuffers.set(key, buf);
  }

  private async flushReactions(conv: Conversation, items: { emoji: EmojiRef; user: UserRef; messageId: string; chat: ChatRef; ts: number }[]): Promise<void> {
    const ctx = this.envelope();
    const targets = new Map<string, ChatMessage | null>();
    const parts: string[] = [];
    for (const it of items) {
      if (!targets.has(it.messageId)) {
        let target = await this.platform.fetchMessage(it.chat.channelId, it.messageId);
        if (!target) {
          const row = this.archive.getMessage(it.chat.platform, it.messageId);
          target = row ? archivedToChat(row) : null;
        }
        targets.set(it.messageId, target);
      }
      parts.push(reactionEnvelope({ emoji: it.emoji, user: it.user, ts: it.ts }, targets.get(it.messageId) ?? null, it.messageId, ctx));
    }
    const last = items.at(-1)!;
    conv.enqueue({
      kind: 'reaction',
      text: parts.join('\n\n'),
      trigger: { channelId: last.chat.channelId, messageId: last.messageId, userId: last.user.id, userName: last.user.name, kind: 'reaction' },
      ts: last.ts,
    });
  }

  private onSchedule(row: ScheduleRow): void {
    void (async () => {
      const chat = await this.platform.describeChat(row.channelId);
      if (!chat) {
        this.log.warn(`schedule ${row.id}: channel ${row.channelId} not reachable`);
        return;
      }
      const conv = this.conversationFor(chat);
      conv.enqueue({
        kind: 'schedule',
        text: scheduleEnvelope({ id: row.id, name: row.name, when: row.when, channelName: chat.name }, row.prompt, this.envelope(), Date.now()),
        ts: Date.now(),
        label: `⏰ ${row.name}`,
      });
    })().catch((err) => this.log.error(`schedule ${row.id} failed:`, err));
  }

  // ── interactions ──────────────────────────────────────────

  private async onInteraction(i: Interaction): Promise<void> {
    if (!this.allowedChat(i.chat, i.user.id) && !this.owners.has(i.user.id)) {
      if (i.kind !== 'autocomplete') await i.reply({ text: 'This bot is not set up for this channel.', private: true }).catch(() => {});
      return;
    }
    if (i.kind === 'command' || i.kind === 'autocomplete') return handleCommand(this, i);
    if (await this.prompts.handle(i)) return;
    const conv = this.conversationFor(i.chat);
    if (i.key.startsWith('stop:')) {
      const turn = conv.turn;
      const allowed = this.owners.has(i.user.id) || Boolean(turn?.triggers.some((t) => t.userId === i.user.id)) || !turn?.main;
      if (!allowed) {
        await i.reply({ text: 'Only the person who asked (or an owner) can stop this.', private: true });
        return;
      }
      await i.ack();
      await conv.interrupt();
      return;
    }
    if (i.key === 'ch:other' && i.kind === 'button') {
      await i.showModal({ id: 'chm', title: 'Your answer', fields: [{ id: 'answer', label: 'Answer', long: true }] });
      return;
    }
    if ((i.key.startsWith('ch:') && i.kind === 'button') || (i.key === 'chm' && i.kind === 'modal')) {
      const other = i.kind === 'modal' ? (i.fields?.answer ?? '').trim() : undefined;
      if (i.kind === 'modal' && !other) return i.ack();
      const label = other ?? i.label ?? i.key;
      await i.update({ buttons: [[{ id: 'chosen', label: truncate(`${label} · ${i.user.name}`, 80), emoji: '✔️', style: 'success', disabled: true }]] }).catch(() => i.ack());
      const target = i.messageId ? await this.platform.fetchMessage(i.chat.channelId, i.messageId) : null;
      conv.enqueue({
        kind: 'choice',
        text: choiceEnvelope(i.user, other !== undefined ? { other } : { label }, target, i.messageId ?? '', this.envelope(), Date.now()),
        trigger: i.messageId ? { channelId: i.chat.channelId, messageId: i.messageId, userId: i.user.id, userName: i.user.name, kind: 'choice' } : undefined,
        ts: Date.now(),
      });
      return;
    }
    if (i.key === 'sg' && i.kind === 'button') {
      const text = (i.messageId && conv.suggestionFor(i.messageId)) || i.label || '';
      await i.update({ buttons: [] }).catch(() => i.ack());
      if (!text) return;
      const ids = await this.platform.send(i.chat.channelId, { text: `💡 ${i.user.name}: ${text}`, silent: true });
      const fake: ChatMessage = {
        id: ids[0] ?? `sg-${Date.now()}`,
        chat: i.chat,
        author: i.user,
        text,
        ts: Date.now(),
        attachments: [],
        mentionsSelf: true,
        fromSelf: false,
      };
      conv.enqueue({
        kind: 'message',
        text: messageEnvelope(fake, this.envelope()),
        trigger: { channelId: i.chat.channelId, messageId: fake.id, userId: i.user.id, userName: i.user.name, kind: 'message' },
        ts: Date.now(),
      });
      return;
    }
    await i.ack().catch(() => {});
  }

  // ── status ────────────────────────────────────────────────

  label(): string {
    return this.cfg.status.label ?? this.cfg.name;
  }

  statusChanged(): void {
    this.pushStatus();
  }

  /** The conversation the presence describes: the busy one, else the most recent. */
  focus(): Conversation | undefined {
    const all = this.allConversations();
    return (
      all.find((c) => c.busy) ??
      all.sort((a, b) => (b.st.lastActiveAt ?? 0) - (a.st.lastActiveAt ?? 0))[0]
    );
  }

  /** Session info, falling back to the last numbers seen when the agent is asleep. */
  infoOf(c: Conversation): SessionInfo {
    const i = c.info();
    const last = c.st.last ?? {};
    if (i.alive) {
      const next = { model: i.model, modelLabel: i.modelLabel, contextWindow: i.contextWindow, ctxPercent: i.ctxPercent, ctxTokens: i.ctxTokens };
      if (JSON.stringify(next) !== JSON.stringify(last)) this.state.update(() => (c.st.last = next));
      return i;
    }
    return {
      ...i,
      model: i.model ?? last.model,
      modelLabel: last.modelLabel ?? modelLabel(i.model),
      contextWindow: last.contextWindow,
      ctxPercent: last.ctxPercent,
      ctxTokens: last.ctxTokens,
    };
  }

  presenceText(): { state: 'online' | 'busy' | 'idle'; text: string } {
    const focus = this.focus();
    const info = focus ? this.infoOf(focus) : undefined;
    const busy = this.allConversations().some((c) => c.busy);
    const alive = this.allConversations().some((c) => c.session?.alive);
    const queue = this.allConversations().reduce((n, c) => n + c.queued, 0);
    const rl = info?.rateLimits;
    const pct = (v?: number) => (v === undefined ? '?' : `${Math.round(v <= 1 ? v * 100 : v)}%`);
    const vars: Record<string, string> = {
      label: this.label(),
      model: info?.modelLabel ?? modelLabel(this.cfg.agent.model),
      // The model's window is known after the first answer; until then the context-usage window stands in.
      window: info?.contextWindow || info?.ctxMax ? windowLabel(info?.contextWindow || info?.ctxMax) : '',
      ctx: info?.ctxPercent !== undefined ? `${Math.round(info.ctxPercent)}%` : '—',
      effort: String(info?.effort ?? this.cfg.agent.effort ?? 'default'),
      state: busy ? 'working' : alive ? 'ready' : 'asleep',
      queue: String(queue),
      five_hour: `5h ${pct(rl?.fiveHour)}`,
      seven_day: `7d ${pct(rl?.sevenDay)}`,
    };
    let text = this.cfg.status.template;
    if (!vars.window) text = text.replace(/\s*\(\{window\}\)/, '');
    text = text.replace(/\{(\w+)\}/g, (s, k: string) => vars[k] ?? s);
    if (queue > 0) text += ` | ${queue} queued`;
    return { state: busy ? 'busy' : alive ? 'online' : 'idle', text };
  }

  status(): BotStatus {
    const p = this.stateName === 'running' ? this.presenceText() : undefined;
    const focus = this.focus();
    return {
      id: this.cfg.id,
      name: this.cfg.name,
      state: this.stateName,
      pid: process.pid,
      startedAt: this.startedAt,
      user: this.platform.selfId ? `${this.platform.selfName} (${this.platform.selfId})` : undefined,
      presence: p?.text,
      presenceState: p?.state,
      conversations: this.allConversations().map((c) => {
        const i = this.infoOf(c);
        return {
          key: c.key,
          channelId: c.channelId,
          busy: c.busy,
          alive: Boolean(c.session?.alive),
          queued: c.queued,
          model: i.model,
          modelLabel: i.modelLabel,
          effort: i.effort ? String(i.effort) : undefined,
          ctxPercent: i.ctxPercent,
          sessionId: i.sessionId,
          lastActiveAt: c.st.lastActiveAt,
        };
      }),
      error: this.lastError,
      inviteUrl: this.platform.inviteUrl?.(),
      rateLimits: focus?.info().rateLimits,
      updatedAt: Date.now(),
    };
  }

  private publishStatus(): void {
    if (this.stateName === 'running') {
      const p = this.presenceText();
      void this.platform.setPresence(p).catch((err) => this.log.debug('presence failed:', err));
    }
    const s = this.status();
    try {
      writeJsonAtomic(this.paths.status, s);
    } catch { /* best effort */ }
    this.report(s);
  }
}
