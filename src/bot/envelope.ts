import { attr, fence, formatTime, truncate } from '../core/text.js';
import type { ChatMessage, EmojiRef, UserRef } from '../platform/types.js';

/**
 * Builds the text the agent receives for each event. Everything the relay writes is wrapped in
 * tags (<message>, <reaction>...); user text inside them is fenced so it can't fake a tag.
 */

export interface EnvelopeContext {
  timezone: string;
  owners: Set<string>;
  selfId: string;
}

export interface SavedFile {
  name: string;
  path?: string;
  kind: 'image' | 'file';
  included: boolean;
  note?: string;
}

function role(user: UserRef, ctx: EnvelopeContext): string {
  if (user.id === ctx.selfId) return 'you';
  if (ctx.owners.has(user.id)) return 'owner';
  if (user.isBot) return 'bot';
  return 'member';
}

function who(user: UserRef, ctx: EnvelopeContext): string {
  return `from="${attr(user.name)}" user_id="${user.id}"${user.username && user.username !== user.name ? ` username="${attr(user.username)}"` : ''} role="${role(user, ctx)}"`;
}

/** The bot's answers end with a "-# model · time · tools" line; it's noise when quoted back. */
export function stripFooter(text: string): string {
  return text.replace(/\n-# [^\n]*·[^\n]*$/, '');
}

function body(m: Pick<ChatMessage, 'text' | 'extra' | 'attachments'> & { fromSelf?: boolean }, max: number): string {
  const parts = [fence(truncate(m.fromSelf ? stripFooter(m.text) : m.text, max))];
  if (m.extra) parts.push(fence(truncate(m.extra, Math.floor(max / 2))));
  if (m.attachments.length) parts.push(`[attachments: ${m.attachments.map((a) => a.name).join(', ')}]`);
  return parts.filter((p) => p.trim()).join('\n');
}

/** One line per message, for channel context. */
export function contextLine(m: ChatMessage, ctx: EnvelopeContext, max = 400): string {
  const time = formatTime(m.ts, ctx.timezone).slice(11);
  const name = m.fromSelf ? 'you' : m.author.name;
  const reply = m.replyToId ? ` (reply to ${m.replyToId})` : '';
  return `[${time}] ${name}${reply}: ${body(m, max).replace(/\n+/g, ' ⏎ ')} (id ${m.id})`;
}

export function channelContext(channelName: string | undefined, messages: ChatMessage[], ctx: EnvelopeContext): string {
  if (messages.length === 0) return '';
  const lines = messages.map((m) => contextLine(m, ctx));
  return `<channel_context channel="${attr(channelName ?? '')}" note="messages in this channel you have not seen yet, oldest first">\n${lines.join('\n')}\n</channel_context>`;
}

export function messageEnvelope(
  m: ChatMessage,
  ctx: EnvelopeContext,
  opts: { replyTo?: ChatMessage | null; files?: SavedFile[]; edited?: boolean } = {},
): string {
  const head = `<message id="${m.id}" channel="${attr(m.chat.name ?? (m.chat.isDM ? 'DM' : m.chat.channelId))}" ${who(m.author, ctx)} time="${formatTime(m.ts, ctx.timezone)}"${opts.edited ? ' edited="true"' : ''}>`;
  const parts = [head];
  if (opts.replyTo) {
    const r = opts.replyTo;
    const from = r.fromSelf ? 'you' : attr(r.author.name);
    parts.push(
      `<reply_to id="${r.id}" from="${from}" user_id="${r.author.id}" time="${formatTime(r.ts, ctx.timezone)}">\n${body(r, 3000)}\n</reply_to>`,
    );
  } else if (m.replyToId) {
    parts.push(`<reply_to id="${m.replyToId}" note="original message not available"/>`);
  }
  parts.push(body({ ...m, attachments: [] }, 12000) || '(no text)');
  if (opts.files?.length) {
    const lines = opts.files.map((f) => {
      if (f.kind === 'image' && f.included) return `- ${f.name} (image, shown to you)`;
      if (f.path) return `- ${f.name} → saved at ${f.path}`;
      return `- ${f.name} (${f.note ?? 'not downloaded'})`;
    });
    parts.push(`<attachments>\n${lines.join('\n')}\n</attachments>`);
  }
  parts.push('</message>');
  return parts.join('\n');
}

export function reactionEnvelope(
  r: { emoji: EmojiRef; user: UserRef; ts: number },
  target: ChatMessage | null,
  messageId: string,
  ctx: EnvelopeContext,
): string {
  const on = target ? (target.fromSelf ? 'your message' : `a message from ${attr(target.author.name)}`) : 'a message';
  const head = `<reaction emoji="${attr(r.emoji.value)}" name="${attr(r.emoji.name)}" ${who(r.user, ctx)} time="${formatTime(r.ts, ctx.timezone)}" on="${on}" message_id="${messageId}">`;
  const text = target ? body(target, 1500) : '(message not available)';
  return `${head}\n${text}\n</reaction>`;
}

export function summonEnvelope(user: UserRef, emoji: string, target: ChatMessage, ctx: EnvelopeContext, ts: number): string {
  return [
    `<summon ${who(user, ctx)} emoji="${attr(emoji)}" time="${formatTime(ts, ctx.timezone)}" message_id="${target.id}">`,
    `${user.name} reacted ${emoji} to this message from ${target.fromSelf ? 'you' : target.author.name} (${formatTime(target.ts, ctx.timezone)}) to bring you in:`,
    body(target, 6000),
    '</summon>',
  ].join('\n');
}

export function choiceEnvelope(
  user: UserRef,
  picked: { label?: string; other?: string },
  onMessage: ChatMessage | null,
  messageId: string,
  ctx: EnvelopeContext,
  ts: number,
): string {
  const pick = picked.other !== undefined ? `typed="${attr(picked.other)}"` : `picked="${attr(picked.label ?? '')}"`;
  const text = onMessage ? truncate(onMessage.text, 800) : '';
  return `<choice ${pick} ${who(user, ctx)} time="${formatTime(ts, ctx.timezone)}" on_message_id="${messageId}">\n${fence(text)}\n</choice>`;
}

export function scheduleEnvelope(
  s: { id: string; name: string; when: string; channelName?: string },
  prompt: string,
  ctx: EnvelopeContext,
  ts: number,
): string {
  return `<scheduled_task id="${attr(s.id)}" name="${attr(s.name)}" schedule="${attr(s.when)}" channel="${attr(s.channelName ?? '')}" time="${formatTime(ts, ctx.timezone)}">\n${prompt}\n</scheduled_task>`;
}

export function notebookBlock(file: string, content: string): string {
  const trimmed = content.trim();
  return `<notebook path="${attr(file)}" note="your own notes, loaded at the start of this session">\n${trimmed ? truncate(trimmed, 20000) : '(empty; nothing saved yet)'}\n</notebook>`;
}

export function relayNote(text: string): string {
  return `<relay>${text}</relay>`;
}
