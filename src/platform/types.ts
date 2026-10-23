/**
 * What the bot layer needs from a chat platform. Discord is the full implementation; another
 * platform (Telegram, Slack...) implements the same surface and reports what it can't do in
 * `capabilities`, and the bot degrades (no reactions → no reaction feedback, etc).
 */

export interface ChatRef {
  platform: string;
  channelId: string;
  /** For threads: the parent channel. */
  parentId?: string;
  /** Parent channel and category ids, nearest first (used to match configured channels). */
  ancestors?: string[];
  guildId?: string;
  isDM: boolean;
  name?: string;
}

export interface UserRef {
  id: string;
  /** Display name in that place (server nickname when there is one). */
  name: string;
  username?: string;
  isBot: boolean;
}

export interface Attachment {
  id: string;
  name: string;
  url: string;
  contentType?: string;
  size: number;
}

export interface ChatMessage {
  id: string;
  chat: ChatRef;
  author: UserRef;
  /** Text with mentions, channels and custom emoji made readable (<@123> → @Name). */
  text: string;
  ts: number;
  editedTs?: number;
  replyToId?: string;
  attachments: Attachment[];
  /** Embeds/stickers/forwards rendered as text, when the message carries no text of its own. */
  extra?: string;
  mentionsSelf: boolean;
  /** Written by this bot. */
  fromSelf: boolean;
  reactions?: { emoji: string; count: number; self: boolean }[];
  url?: string;
}

export interface EmojiRef {
  /** Unicode emoji, or the custom emoji's name. */
  value: string;
  /** Readable name (thumbsup, white_check_mark, or the custom name). */
  name: string;
  /** Custom emoji id, when it isn't a unicode emoji. */
  id?: string;
}

export type ButtonStyle = 'primary' | 'secondary' | 'success' | 'danger';

export interface ButtonSpec {
  id: string;
  label: string;
  emoji?: string;
  style?: ButtonStyle;
  url?: string;
  disabled?: boolean;
}

export interface SelectSpec {
  id: string;
  placeholder?: string;
  min?: number;
  max?: number;
  options: { label: string; value: string; description?: string; emoji?: string }[];
}

export interface OutgoingMessage {
  text?: string;
  replyTo?: string;
  /** Notify the author of the replied-to message. */
  ping?: boolean;
  /** Rows of buttons (attached to the last chunk). */
  buttons?: ButtonSpec[][];
  selects?: SelectSpec[];
  files?: { path: string; name?: string }[];
  /** Send without a notification. */
  silent?: boolean;
  suppressEmbeds?: boolean;
}

export interface ModalSpec {
  id: string;
  title: string;
  fields: { id: string; label: string; placeholder?: string; long?: boolean; required?: boolean; value?: string }[];
}

export interface InteractionReply {
  text?: string;
  buttons?: ButtonSpec[][];
  selects?: SelectSpec[];
  /** Only the clicking user sees it. */
  private?: boolean;
}

export interface Interaction {
  kind: 'button' | 'select' | 'modal' | 'command' | 'autocomplete';
  /** Component custom id / modal id / command name. */
  key: string;
  values?: string[];
  fields?: Record<string, string>;
  options?: Record<string, string | number | boolean | undefined>;
  /** The option being autocompleted, with what was typed. */
  focused?: { name: string; value: string };
  chat: ChatRef;
  user: UserRef;
  /** The message the component lives on. */
  messageId?: string;
  /** Label of the clicked button. */
  label?: string;
  reply(r: InteractionReply): Promise<void>;
  /** Acknowledges a component click without replying (must happen within 3s on Discord). */
  ack(): Promise<void>;
  /** Replaces the component's message content. */
  update(r: InteractionReply): Promise<void>;
  showModal(m: ModalSpec): Promise<void>;
  autocomplete(choices: { name: string; value: string }[]): Promise<void>;
}

export type PlatformEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'edit'; message: ChatMessage }
  | { type: 'delete'; chat: ChatRef; messageId: string }
  | {
      type: 'reaction';
      chat: ChatRef;
      messageId: string;
      emoji: EmojiRef;
      user: UserRef;
      added: boolean;
      /** The reacted message was written by this bot. */
      onSelf: boolean;
    }
  | { type: 'interaction'; interaction: Interaction }
  | { type: 'ready' }
  | { type: 'disconnected'; reason: string };

export interface CommandOption {
  name: string;
  description: string;
  type: 'string' | 'integer' | 'boolean';
  required?: boolean;
  choices?: { name: string; value: string }[];
  autocomplete?: boolean;
}

export interface CommandSpec {
  name: string;
  description: string;
  options?: CommandOption[];
}

export interface Presence {
  state: 'online' | 'busy' | 'idle';
  text: string;
}

export interface FetchOptions {
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
}

export interface PlatformCapabilities {
  reactions: boolean;
  edits: boolean;
  deletes: boolean;
  buttons: boolean;
  modals: boolean;
  presence: boolean;
  typing: boolean;
  maxMessageLength: number;
}

export interface Platform {
  readonly name: string;
  readonly capabilities: PlatformCapabilities;
  /** This bot's own user id (after start). */
  readonly selfId: string;
  readonly selfName: string;
  start(onEvent: (e: PlatformEvent) => void): Promise<void>;
  stop(): Promise<void>;
  send(channelId: string, msg: OutgoingMessage): Promise<string[]>;
  edit(channelId: string, messageId: string, msg: OutgoingMessage): Promise<void>;
  delete(channelId: string, messageId: string): Promise<void>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  unreact(channelId: string, messageId: string, emoji: string): Promise<void>;
  typing(channelId: string): Promise<void>;
  fetchMessage(channelId: string, messageId: string): Promise<ChatMessage | null>;
  fetchHistory(channelId: string, opts: FetchOptions): Promise<ChatMessage[]>;
  describeChat(channelId: string): Promise<ChatRef | null>;
  setPresence(p: Presence): Promise<void>;
  registerCommands(cmds: CommandSpec[]): Promise<void>;
  /** Readable name for a user id, from cache or the API. */
  userName(userId: string, guildId?: string): Promise<string | undefined>;
  /** Members matching a name (for @mentions). May be empty if the platform can't search. */
  findMembers(query: string, guildId?: string): Promise<UserRef[]>;
  inviteUrl?(): string;
}
