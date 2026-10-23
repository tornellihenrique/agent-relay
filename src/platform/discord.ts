import path from 'node:path';
import {
  ActionRowBuilder,
  ActivityType,
  ApplicationCommandOptionType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  Partials,
  PermissionsBitField,
  Routes,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AnyThreadChannel,
  type Channel,
  type ChatInputCommandInteraction,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type User,
  type Interaction as DjsInteraction,
  type MessageCreateOptions,
  type MessageEditOptions,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
} from 'discord.js';
import type { BotConfig } from '../core/config.js';
import { resolveSecret } from '../core/config.js';
import type { Logger } from '../core/log.js';
import { truncate } from '../core/text.js';
import { emojiName } from './emoji.js';
import { prepareForChat } from './markdown.js';
import type {
  ButtonSpec,
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
  SelectSpec,
  UserRef,
} from './types.js';

type DiscordConfig = Extract<BotConfig['platform'], { type: 'discord' }>;

const LIMIT = 2000;

const STYLE: Record<NonNullable<ButtonSpec['style']>, ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

/** Permissions the bot needs in its channels. */
export const BOT_PERMISSIONS = new PermissionsBitField([
  'ViewChannel',
  'SendMessages',
  'SendMessagesInThreads',
  'ReadMessageHistory',
  'AddReactions',
  'EmbedLinks',
  'AttachFiles',
  'UseExternalEmojis',
  'CreatePublicThreads',
]);

type Sendable = Extract<Channel, { send: unknown; messages: unknown }>;

export class DiscordPlatform implements Platform {
  readonly name = 'discord';
  readonly capabilities = {
    reactions: true,
    edits: true,
    deletes: true,
    buttons: true,
    modals: true,
    presence: true,
    typing: true,
    maxMessageLength: LIMIT,
  };

  private client: Client;
  private onEvent: (e: PlatformEvent) => void = () => {};
  private lastPresence = '';

  constructor(
    private cfg: DiscordConfig,
    private log: Logger,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User, Partials.GuildMember],
      allowedMentions: { parse: [], repliedUser: false },
    });
  }

  get selfId(): string {
    return this.client.user?.id ?? '';
  }

  get selfName(): string {
    return this.client.user?.displayName ?? this.client.user?.username ?? 'bot';
  }

  inviteUrl(): string {
    const id = this.client.application?.id ?? this.selfId;
    return `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS.bitfield}`;
  }

  // ── lifecycle ─────────────────────────────────────────────

  async start(onEvent: (e: PlatformEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    const c = this.client;
    c.on(Events.MessageCreate, (m) => this.safe('messageCreate', () => this.onMessage(m)));
    c.on(Events.MessageUpdate, (_old, m) => this.safe('messageUpdate', () => this.onEdit(m)));
    c.on(Events.MessageDelete, (m) =>
      this.safe('messageDelete', async () => {
        const chat = await this.chatOf(m.channel);
        if (chat) this.onEvent({ type: 'delete', chat, messageId: m.id });
      }),
    );
    c.on(Events.MessageReactionAdd, (r, u) => this.safe('reactionAdd', () => this.onReaction(r, u, true)));
    c.on(Events.MessageReactionRemove, (r, u) => this.safe('reactionRemove', () => this.onReaction(r, u, false)));
    c.on(Events.InteractionCreate, (i) => this.safe('interaction', () => this.onInteraction(i)));
    c.on(Events.ShardDisconnect, (ev) => this.onEvent({ type: 'disconnected', reason: `code ${ev.code}` }));
    c.on(Events.ShardResume, () => this.onEvent({ type: 'ready' }));
    c.on(Events.Error, (err) => this.log.error('discord client error:', err));
    c.on(Events.Warn, (w) => this.log.warn('discord:', w));

    const ready = new Promise<void>((resolve) => c.once(Events.ClientReady, () => resolve()));
    const token = resolveSecret(this.cfg.token);
    if (!token) throw new Error('Discord token is empty (check platform.token)');
    await c.login(token);
    await ready;
    await c.application?.fetch().catch(() => undefined);
    this.log.info(`discord ready as ${c.user?.tag} (${this.selfId})`);
    this.onEvent({ type: 'ready' });
  }

  async stop(): Promise<void> {
    try {
      await this.client.destroy();
    } catch { /* ignore */ }
  }

  private safe(what: string, fn: () => unknown): void {
    Promise.resolve()
      .then(fn)
      .catch((err) => this.log.error(`discord ${what} handler failed:`, err));
  }

  // ── inbound ───────────────────────────────────────────────

  private async onMessage(m: Message): Promise<void> {
    if (m.partial) m = await m.fetch();
    if (m.system) return;
    const msg = await this.toChatMessage(m);
    if (msg) this.onEvent({ type: 'message', message: msg });
  }

  private async onEdit(m: Message | PartialMessage): Promise<void> {
    if (m.partial) {
      try {
        m = await m.fetch();
      } catch {
        return;
      }
    }
    const msg = await this.toChatMessage(m as Message);
    if (msg) this.onEvent({ type: 'edit', message: msg });
  }

  private async onReaction(r: MessageReaction | PartialMessageReaction, u: User | PartialUser, added: boolean): Promise<void> {
    if (u.id === this.selfId) return;
    if (r.partial) {
      try {
        r = await r.fetch();
      } catch {
        return;
      }
    }
    let message = r.message;
    if (message.partial) {
      try {
        message = await message.fetch();
      } catch {
        return;
      }
    }
    const chat = await this.chatOf(message.channel);
    if (!chat) return;
    const user = u.partial ? await u.fetch() : u;
    const member = message.guild ? await message.guild.members.fetch(user.id).catch(() => null) : null;
    const value = r.emoji.id ? `<${r.emoji.animated ? 'a' : ''}:${r.emoji.name}:${r.emoji.id}>` : (r.emoji.name ?? '?');
    this.onEvent({
      type: 'reaction',
      chat,
      messageId: message.id,
      emoji: { value, name: r.emoji.id ? (r.emoji.name ?? 'custom') : emojiName(r.emoji.name ?? '?'), id: r.emoji.id ?? undefined },
      user: { id: user.id, name: member?.displayName ?? user.globalName ?? user.username, username: user.username, isBot: user.bot },
      added,
      onSelf: message.author?.id === this.selfId,
    });
  }

  private async chatOf(channel: Channel | null | undefined): Promise<ChatRef | null> {
    if (!channel) return null;
    if (channel.partial) {
      try {
        channel = await channel.fetch();
      } catch {
        return null;
      }
    }
    if (channel.type === ChannelType.DM) {
      return { platform: 'discord', channelId: channel.id, isDM: true, name: `DM ${channel.recipient?.username ?? ''}`.trim(), ancestors: [] };
    }
    if (!('guildId' in channel)) return null;
    const ancestors: string[] = [];
    let parentId: string | undefined;
    if (channel.isThread()) {
      parentId = channel.parentId ?? undefined;
      if (parentId) ancestors.push(parentId);
      const parent = channel.parent;
      if (parent?.parentId) ancestors.push(parent.parentId);
    } else if ('parentId' in channel && channel.parentId) {
      ancestors.push(channel.parentId);
    }
    const name = 'name' in channel && channel.name ? `#${channel.name}` : undefined;
    return { platform: 'discord', channelId: channel.id, parentId, ancestors, guildId: channel.guildId, isDM: false, name };
  }

  private userRef(m: Message): UserRef {
    return {
      id: m.author.id,
      name: m.member?.displayName ?? m.author.globalName ?? m.author.username,
      username: m.author.username,
      isBot: m.author.bot,
    };
  }

  /** Replaces raw mention syntax with readable names. */
  private readable(m: Message, content: string): string {
    let text = content;
    text = text.replace(/<@!?(\d+)>/g, (_s, id: string) => {
      if (id === this.selfId) return `@${this.selfName}`;
      const member = m.mentions.members?.get(id);
      const user = m.mentions.users.get(id) ?? this.client.users.cache.get(id);
      return `@${member?.displayName ?? user?.globalName ?? user?.username ?? id}`;
    });
    text = text.replace(/<@&(\d+)>/g, (_s, id: string) => `@${m.mentions.roles.get(id)?.name ?? m.guild?.roles.cache.get(id)?.name ?? 'role'}`);
    text = text.replace(/<#(\d+)>/g, (_s, id: string) => {
      const ch = this.client.channels.cache.get(id);
      return ch && 'name' in ch && ch.name ? `#${ch.name}` : `#${id}`;
    });
    text = text.replace(/<a?:(\w+):\d+>/g, ':$1:');
    text = text.replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_s, t: string) => new Date(Number(t) * 1000).toISOString());
    return text;
  }

  private mentionsSelf(m: Message): boolean {
    if (!this.selfId) return false;
    if (m.mentions.users.has(this.selfId)) return true;
    const me = m.guild?.members.me;
    if (me && m.mentions.roles.some((r) => me.roles.cache.has(r.id) && r.managed)) return true;
    return m.content.includes(`<@${this.selfId}>`) || m.content.includes(`<@!${this.selfId}>`);
  }

  private async toChatMessage(m: Message): Promise<ChatMessage | null> {
    const chat = await this.chatOf(m.channel);
    if (!chat) return null;
    const extras: string[] = [];
    for (const e of m.embeds) {
      const bits = [e.author?.name, e.title, e.description, ...e.fields.map((f) => `${f.name}: ${f.value}`)].filter(Boolean);
      if (bits.length) extras.push(`[embed] ${truncate(bits.join(' — '), 600)}`);
    }
    for (const s of m.stickers.values()) extras.push(`[sticker: ${s.name}]`);
    const snapshots = (m as Message & { messageSnapshots?: Map<string, { content?: string }> }).messageSnapshots;
    if (snapshots) {
      for (const snap of snapshots.values()) if (snap.content) extras.push(`[forwarded] ${truncate(snap.content, 1500)}`);
    }
    if (m.poll) extras.push(`[poll] ${m.poll.question.text}: ${m.poll.answers.map((a) => a.text).join(' / ')}`);
    return {
      id: m.id,
      chat,
      author: this.userRef(m),
      text: this.readable(m, m.content ?? ''),
      ts: m.createdTimestamp,
      editedTs: m.editedTimestamp ?? undefined,
      replyToId: m.reference?.messageId && m.reference.type !== 1 ? m.reference.messageId : undefined,
      attachments: [...m.attachments.values()].map((a) => ({
        id: a.id,
        name: a.name,
        url: a.url,
        contentType: a.contentType ?? undefined,
        size: a.size,
      })),
      extra: extras.length ? extras.join('\n') : undefined,
      mentionsSelf: this.mentionsSelf(m),
      fromSelf: m.author.id === this.selfId,
      reactions: [...m.reactions.cache.values()].map((r) => ({
        emoji: r.emoji.id ? `:${r.emoji.name}:` : (r.emoji.name ?? '?'),
        count: r.count ?? 0,
        self: r.me,
      })),
      url: m.url,
    };
  }

  // ── interactions ──────────────────────────────────────────

  private async onInteraction(i: DjsInteraction): Promise<void> {
    const chat = await this.chatOf(i.channel ?? (i.channelId ? await this.client.channels.fetch(i.channelId).catch(() => null) : null));
    if (!chat) return;
    const member = i.member && 'displayName' in i.member ? i.member.displayName : undefined;
    const user: UserRef = { id: i.user.id, name: member ?? i.user.globalName ?? i.user.username, username: i.user.username, isBot: i.user.bot };
    let state: 'fresh' | 'deferred' | 'replied' = 'fresh';
    const anyI = i as unknown as {
      reply(o: unknown): Promise<unknown>;
      followUp(o: unknown): Promise<unknown>;
      editReply(o: unknown): Promise<unknown>;
      deferReply(o: unknown): Promise<unknown>;
      deferUpdate(): Promise<unknown>;
      update(o: unknown): Promise<unknown>;
      showModal(m: unknown): Promise<unknown>;
      respond(c: unknown): Promise<unknown>;
      message?: Message;
    };
    const payload = (r: InteractionReply) => ({
      content: r.text ? truncate(r.text, LIMIT) : undefined,
      components: this.components(r.buttons, r.selects),
      flags: r.private ? MessageFlags.Ephemeral : undefined,
      allowedMentions: { parse: [] },
    });
    const base = {
      chat,
      user,
      messageId: anyI.message?.id,
      async reply(r: InteractionReply) {
        if (state === 'fresh') {
          state = 'replied';
          await anyI.reply(payload(r));
        } else if (state === 'deferred') {
          state = 'replied';
          await anyI.editReply({ ...payload(r), flags: undefined });
        } else {
          await anyI.followUp(payload(r));
        }
      },
      async ack() {
        if (state !== 'fresh') return;
        state = 'deferred';
        if (i.isChatInputCommand()) await anyI.deferReply({ flags: MessageFlags.Ephemeral });
        else await anyI.deferUpdate();
      },
      async update(r: InteractionReply) {
        const p = { ...payload(r), flags: undefined };
        if (state === 'fresh' && !i.isChatInputCommand()) {
          state = 'replied';
          await anyI.update(p);
        } else {
          state = 'replied';
          await anyI.editReply(p);
        }
      },
      async showModal(m: ModalSpec) {
        state = 'replied';
        const modal = new ModalBuilder().setCustomId(m.id).setTitle(truncate(m.title, 45));
        for (const f of m.fields) {
          const input = new TextInputBuilder()
            .setCustomId(f.id)
            .setLabel(truncate(f.label, 45))
            .setStyle(f.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setRequired(f.required ?? true);
          if (f.placeholder) input.setPlaceholder(truncate(f.placeholder, 100));
          if (f.value) input.setValue(f.value);
          modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
        }
        await anyI.showModal(modal);
      },
      async autocomplete(choices: { name: string; value: string }[]) {
        await anyI.respond(choices.slice(0, 25).map((c) => ({ name: truncate(c.name, 100), value: truncate(c.value, 100) })));
      },
    };
    let interaction: Interaction | undefined;
    if (i.isButton()) interaction = { kind: 'button', key: i.customId, label: ('label' in i.component ? i.component.label : undefined) ?? undefined, ...base };
    else if (i.isStringSelectMenu()) interaction = { kind: 'select', key: i.customId, values: i.values, ...base };
    else if (i.isModalSubmit()) {
      const fields: Record<string, string> = {};
      for (const [id, f] of i.fields.fields) if ('value' in f && typeof f.value === 'string') fields[id] = f.value;
      interaction = { kind: 'modal', key: i.customId, fields, ...base, messageId: i.message?.id };
    } else if (i.isChatInputCommand()) {
      interaction = { kind: 'command', key: i.commandName, options: commandOptions(i), ...base };
    } else if (i.isAutocomplete()) {
      const focused = i.options.getFocused(true);
      interaction = { kind: 'autocomplete', key: i.commandName, focused: { name: focused.name, value: String(focused.value) }, ...base };
    }
    if (interaction) this.onEvent({ type: 'interaction', interaction });
  }

  // ── outbound ──────────────────────────────────────────────

  private async channel(channelId: string): Promise<Sendable> {
    const ch = this.client.channels.cache.get(channelId) ?? (await this.client.channels.fetch(channelId));
    if (!ch || !('send' in ch) || !('messages' in ch)) throw new Error(`channel ${channelId} is not a text channel`);
    return ch as Sendable;
  }

  private components(buttons?: ButtonSpec[][], selects?: SelectSpec[]): APIActionRowComponent<APIComponentInMessageActionRow>[] {
    const rows: APIActionRowComponent<APIComponentInMessageActionRow>[] = [];
    for (const row of buttons ?? []) {
      if (!row.length) continue;
      const r = new ActionRowBuilder<ButtonBuilder>();
      for (const b of row.slice(0, 5)) {
        const btn = new ButtonBuilder().setLabel(truncate(b.label, 80)).setDisabled(Boolean(b.disabled));
        if (b.url) btn.setStyle(ButtonStyle.Link).setURL(b.url);
        else btn.setStyle(STYLE[b.style ?? 'secondary']).setCustomId(b.id);
        if (b.emoji) btn.setEmoji(b.emoji);
        r.addComponents(btn);
      }
      rows.push(r.toJSON());
    }
    for (const s of selects ?? []) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(s.id)
        .setMinValues(s.min ?? 1)
        .setMaxValues(Math.min(s.max ?? 1, s.options.length))
        .addOptions(
          s.options.slice(0, 25).map((o) => ({
            label: truncate(o.label, 100),
            value: truncate(o.value, 100),
            description: o.description ? truncate(o.description, 100) : undefined,
            emoji: o.emoji,
          })),
        );
      if (s.placeholder) menu.setPlaceholder(truncate(s.placeholder, 150));
      rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu).toJSON());
    }
    return rows.slice(0, 5);
  }

  private mentionParse(): ('users' | 'roles' | 'everyone')[] {
    return this.cfg.allowMentions;
  }

  async send(channelId: string, msg: OutgoingMessage): Promise<string[]> {
    const ch = await this.channel(channelId);
    const chunks = msg.text ? prepareForChat(msg.text, LIMIT) : [];
    if (chunks.length === 0) chunks.push('');
    const ids: string[] = [];
    let flags = 0;
    if (msg.suppressEmbeds ?? this.cfg.suppressEmbeds) flags |= MessageFlags.SuppressEmbeds;
    if (msg.silent) flags |= MessageFlags.SuppressNotifications;
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      const files = last ? (msg.files ?? []).map((f) => new AttachmentBuilder(f.path, { name: f.name ?? path.basename(f.path) })) : [];
      const components = last ? this.components(msg.buttons, msg.selects) : [];
      if (!chunks[i] && files.length === 0 && components.length === 0) continue;
      const opts: MessageCreateOptions = {
        content: chunks[i] || undefined,
        files,
        components,
        allowedMentions: { parse: this.mentionParse(), repliedUser: Boolean(msg.ping) },
        flags: flags as never,
      };
      if (i === 0 && msg.replyTo) opts.reply = { messageReference: msg.replyTo, failIfNotExists: false };
      const sent = await ch.send(opts);
      ids.push(sent.id);
    }
    return ids;
  }

  async edit(channelId: string, messageId: string, msg: OutgoingMessage): Promise<void> {
    const ch = await this.channel(channelId);
    const opts: MessageEditOptions = {
      content: msg.text !== undefined ? truncate(msg.text, LIMIT) || '…' : undefined,
      components: msg.buttons || msg.selects ? this.components(msg.buttons, msg.selects) : [],
      allowedMentions: { parse: this.mentionParse(), repliedUser: false },
    };
    await ch.messages.edit(messageId, opts);
  }

  async delete(channelId: string, messageId: string): Promise<void> {
    const ch = await this.channel(channelId);
    await ch.messages.delete(messageId);
  }

  private emojiPath(emoji: string): string {
    const custom = emoji.match(/^<a?:(\w+):(\d+)>$/);
    return encodeURIComponent(custom ? `${custom[1]}:${custom[2]}` : emoji);
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.client.rest.put(Routes.channelMessageOwnReaction(channelId, messageId, this.emojiPath(emoji)));
  }

  async unreact(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.client.rest.delete(Routes.channelMessageOwnReaction(channelId, messageId, this.emojiPath(emoji)));
  }

  async typing(channelId: string): Promise<void> {
    const ch = await this.channel(channelId);
    if ('sendTyping' in ch) await ch.sendTyping();
  }

  async fetchMessage(channelId: string, messageId: string): Promise<ChatMessage | null> {
    try {
      const ch = await this.channel(channelId);
      const m = await ch.messages.fetch(messageId);
      return await this.toChatMessage(m);
    } catch {
      return null;
    }
  }

  async fetchHistory(channelId: string, opts: FetchOptions): Promise<ChatMessage[]> {
    const ch = await this.channel(channelId);
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const q: { limit: number; before?: string; after?: string; around?: string } = { limit };
    if (opts.before) q.before = opts.before;
    else if (opts.after) q.after = opts.after;
    else if (opts.around) q.around = opts.around;
    const msgs = await ch.messages.fetch(q);
    const out: ChatMessage[] = [];
    for (const m of [...msgs.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)) {
      if (m.system) continue;
      const cm = await this.toChatMessage(m);
      if (cm) out.push(cm);
    }
    return out;
  }

  async describeChat(channelId: string): Promise<ChatRef | null> {
    try {
      const ch = this.client.channels.cache.get(channelId) ?? (await this.client.channels.fetch(channelId));
      return await this.chatOf(ch);
    } catch {
      return null;
    }
  }

  async setPresence(p: Presence): Promise<void> {
    const key = `${p.state}|${p.text}`;
    if (key === this.lastPresence || !this.client.user) return;
    this.lastPresence = key;
    this.client.user.setPresence({
      status: p.state === 'busy' ? 'dnd' : p.state === 'idle' ? 'idle' : 'online',
      activities: [{ type: ActivityType.Custom, name: 'Custom Status', state: truncate(p.text, 128) }],
    });
  }

  async registerCommands(cmds: CommandSpec[]): Promise<void> {
    if (!this.client.application) return;
    const typeOf = { string: ApplicationCommandOptionType.String, integer: ApplicationCommandOptionType.Integer, boolean: ApplicationCommandOptionType.Boolean };
    await this.client.application.commands.set(
      cmds.map((c) => ({
        name: c.name,
        description: truncate(c.description, 100),
        options: (c.options ?? []).map((o) => ({
          name: o.name,
          description: truncate(o.description, 100),
          type: typeOf[o.type],
          required: o.required ?? false,
          ...(o.choices ? { choices: o.choices } : {}),
          ...(o.autocomplete ? { autocomplete: true } : {}),
        })) as never,
      })),
    );
    this.log.info(`registered ${cmds.length} slash commands`);
  }

  async userName(userId: string, guildId?: string): Promise<string | undefined> {
    try {
      if (guildId) {
        const guild = this.client.guilds.cache.get(guildId);
        const member = await guild?.members.fetch(userId);
        if (member) return member.displayName;
      }
      const user = await this.client.users.fetch(userId);
      return user.globalName ?? user.username;
    } catch {
      return undefined;
    }
  }

  async findMembers(query: string, guildId?: string): Promise<UserRef[]> {
    const guilds = guildId ? [this.client.guilds.cache.get(guildId)].filter(Boolean) : [...this.client.guilds.cache.values()];
    const out = new Map<string, UserRef>();
    for (const g of guilds) {
      try {
        const found = await g!.members.search({ query, limit: 10 });
        for (const m of found.values()) {
          out.set(m.id, { id: m.id, name: m.displayName, username: m.user.username, isBot: m.user.bot });
        }
      } catch (err) {
        this.log.debug('member search failed:', err);
        for (const m of g!.members.cache.values()) {
          const hay = `${m.displayName} ${m.user.username}`.toLowerCase();
          if (hay.includes(query.toLowerCase())) out.set(m.id, { id: m.id, name: m.displayName, username: m.user.username, isBot: m.user.bot });
        }
      }
    }
    return [...out.values()];
  }

  /** Thread or channel name, for prompts. */
  threadName(channelId: string): string | undefined {
    const ch = this.client.channels.cache.get(channelId) as AnyThreadChannel | undefined;
    return ch && 'name' in ch ? ch.name : undefined;
  }
}

function commandOptions(i: ChatInputCommandInteraction): Record<string, string | number | boolean | undefined> {
  const out: Record<string, string | number | boolean | undefined> = {};
  const walk = (opts: readonly { name: string; value?: string | number | boolean; options?: readonly unknown[] }[]) => {
    for (const o of opts) {
      if (o.options) {
        out._sub = o.name;
        walk(o.options as never);
      } else out[o.name] = o.value;
    }
  };
  walk(i.options.data as never);
  return out;
}
