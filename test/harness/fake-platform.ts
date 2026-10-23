import { prepareForChat } from '../../src/platform/markdown.js';
import type {
  ChatMessage,
  ChatRef,
  CommandSpec,
  FetchOptions,
  Interaction,
  InteractionReply,
  ModalSpec,
  OutgoingMessage,
  Platform,
  PlatformEvent,
  Presence,
  UserRef,
} from '../../src/platform/types.js';

/** An in-memory Discord stand-in that records what the bot does. For end-to-end tests. */
export class FakePlatform implements Platform {
  readonly name = 'discord';
  readonly capabilities = { reactions: true, edits: true, deletes: true, buttons: true, modals: true, presence: true, typing: true, maxMessageLength: 2000 };
  readonly selfId = 'bot-1';
  readonly selfName = 'TestBot';
  readonly actions: string[] = [];
  readonly messages = new Map<string, ChatMessage & { buttons?: OutgoingMessage['buttons'] }>();
  private onEvent: (e: PlatformEvent) => void = () => {};
  private seq = 1000;
  presence: Presence | undefined;
  commands: CommandSpec[] = [];
  private t0 = Date.now();

  constructor(private chat: ChatRef = { platform: 'discord', channelId: 'chan-1', isDM: false, name: '#test', ancestors: [] }) {}

  private note(s: string): void {
    const line = `${((Date.now() - this.t0) / 1000).toFixed(1).padStart(6)}s  ${s}`;
    this.actions.push(line);
    console.log(line);
  }

  async start(onEvent: (e: PlatformEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    onEvent({ type: 'ready' });
  }
  async stop(): Promise<void> {}

  async send(channelId: string, msg: OutgoingMessage): Promise<string[]> {
    const chunks = msg.text ? prepareForChat(msg.text, 2000) : [''];
    const ids: string[] = [];
    chunks.forEach((text, i) => {
      const id = String(this.seq++);
      const last = i === chunks.length - 1;
      this.messages.set(id, {
        id,
        chat: { ...this.chat, channelId },
        author: { id: this.selfId, name: this.selfName, isBot: true },
        text,
        ts: Date.now(),
        replyToId: i === 0 ? msg.replyTo : undefined,
        attachments: [],
        mentionsSelf: false,
        fromSelf: true,
        buttons: last ? msg.buttons : undefined,
      });
      ids.push(id);
      const btns = last && msg.buttons?.length ? ` [buttons: ${msg.buttons.flat().map((b) => `${b.id}=${b.label}`).join(', ')}]` : '';
      this.note(`SEND #${id}${msg.replyTo && i === 0 ? ` ↩${msg.replyTo}` : ''}${msg.ping ? ' (ping)' : ''}${msg.silent ? ' (silent)' : ''}: ${text.replace(/\n/g, ' ⏎ ').slice(0, 300)}${btns}${msg.files?.length ? ` [files: ${msg.files.map((f) => f.name ?? f.path).join(', ')}]` : ''}`);
    });
    return ids;
  }

  async edit(channelId: string, messageId: string, msg: OutgoingMessage): Promise<void> {
    const m = this.messages.get(messageId);
    if (m && msg.text !== undefined) m.text = msg.text;
    if (m) m.buttons = msg.buttons;
    this.note(`EDIT #${messageId}: ${(msg.text ?? '(text kept)').replace(/\n/g, ' ⏎ ').slice(0, 220)}`);
  }

  async delete(_c: string, messageId: string): Promise<void> {
    this.messages.delete(messageId);
    this.note(`DELETE #${messageId}`);
  }

  async react(_c: string, messageId: string, emoji: string): Promise<void> {
    this.note(`REACT #${messageId} +${emoji}`);
  }

  async unreact(_c: string, messageId: string, emoji: string): Promise<void> {
    this.note(`REACT #${messageId} -${emoji}`);
  }

  async typing(): Promise<void> {}

  async fetchMessage(_c: string, id: string): Promise<ChatMessage | null> {
    return this.messages.get(id) ?? null;
  }

  async fetchHistory(channelId: string, opts: FetchOptions): Promise<ChatMessage[]> {
    const all = [...this.messages.values()].filter((m) => m.chat.channelId === channelId).sort((a, b) => a.ts - b.ts);
    const before = opts.before ? this.messages.get(opts.before)?.ts : undefined;
    return all.filter((m) => (before === undefined ? true : m.ts < before)).slice(-(opts.limit ?? 30));
  }

  async describeChat(channelId: string): Promise<ChatRef | null> {
    return { ...this.chat, channelId };
  }

  async setPresence(p: Presence): Promise<void> {
    if (this.presence?.text !== p.text || this.presence?.state !== p.state) this.note(`PRESENCE [${p.state}] ${p.text}`);
    this.presence = p;
  }

  async registerCommands(cmds: CommandSpec[]): Promise<void> {
    this.commands = cmds;
  }

  async userName(): Promise<string | undefined> {
    return undefined;
  }

  async findMembers(): Promise<UserRef[]> {
    return [];
  }

  // ── test drivers ──────────────────────────────────────────

  say(user: UserRef, text: string, opts: { replyTo?: string; mention?: boolean } = {}): ChatMessage {
    const id = String(this.seq++);
    const m: ChatMessage = {
      id,
      chat: this.chat,
      author: user,
      text: opts.mention ? `@${this.selfName} ${text}` : text,
      ts: Date.now(),
      replyToId: opts.replyTo,
      attachments: [],
      mentionsSelf: Boolean(opts.mention),
      fromSelf: false,
    };
    this.messages.set(id, m);
    this.note(`USER ${user.name} #${id}${opts.replyTo ? ` ↩${opts.replyTo}` : ''}: ${m.text}`);
    this.onEvent({ type: 'message', message: m });
    return m;
  }

  reactAs(user: UserRef, messageId: string, emoji: string, name: string): void {
    const m = this.messages.get(messageId);
    this.note(`USER ${user.name} reacts ${emoji} on #${messageId}`);
    this.onEvent({ type: 'reaction', chat: this.chat, messageId, emoji: { value: emoji, name }, user, added: true, onSelf: Boolean(m?.fromSelf) });
  }

  interact(user: UserRef, kind: Interaction['kind'], key: string, extra: Partial<Interaction> = {}): Promise<string> {
    return new Promise((resolve) => {
      const done = (what: string) => (r: InteractionReply | ModalSpec) => {
        const text = 'text' in r ? r.text : 'title' in r ? `modal ${r.title}` : '';
        this.note(`INTERACTION ${key} → ${what}: ${(text ?? '').replace(/\n/g, ' ⏎ ').slice(0, 600)}`);
        resolve(text ?? '');
        return Promise.resolve();
      };
      const i: Interaction = {
        kind,
        key,
        chat: this.chat,
        user,
        reply: done('reply'),
        ack: async () => {
          this.note(`INTERACTION ${key} → ack`);
          resolve('');
        },
        update: done('update'),
        showModal: done('modal') as never,
        autocomplete: async (c) => {
          this.note(`AUTOCOMPLETE ${c.map((x) => x.value).join(', ')}`);
          resolve('');
        },
        ...extra,
      };
      this.note(`USER ${user.name} ${kind} ${key}`);
      this.onEvent({ type: 'interaction', interaction: i });
    });
  }

  lastBotMessage(): (ChatMessage & { buttons?: OutgoingMessage['buttons'] }) | undefined {
    return [...this.messages.values()].filter((m) => m.fromSelf).sort((a, b) => b.ts - a.ts)[0];
  }
}
