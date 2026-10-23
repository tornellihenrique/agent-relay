import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SessionInfo } from '../agent/types.js';
import { tokensLabel, windowLabel } from '../agent/models.js';
import type { Archive, ArchiveRow } from '../core/archive.js';
import type { BotConfig } from '../core/config.js';
import { formatTime, oneLine, parseWhen, truncate } from '../core/text.js';
import type { Platform } from '../platform/types.js';
import { contextLine, type EnvelopeContext } from './envelope.js';
import type { Scheduler } from './scheduler.js';
import type { TurnContext } from './turn.js';

export interface ToolDeps {
  cfg: BotConfig;
  platform: Platform;
  archive: Archive;
  scheduler: Scheduler;
  envelope: () => EnvelopeContext;
  convKey: string;
  defaultChannel: () => string;
  currentTurn: () => TurnContext | undefined;
  info: () => SessionInfo;
  inScope: (channelId: string) => Promise<boolean>;
  recordSent: (channelId: string, ids: string[], text: string, turnId?: string) => void;
  paths: { notebook: string; inbox: string; db: string };
  sessionStats: () => { compactions: number; archived: number; turns: number };
}

/** Relay tools are small and used often: load their schemas up front instead of through tool search. */
const loaded: typeof tool = (name, description, schema, handler, extras) => tool(name, description, schema, handler, { alwaysLoad: true, ...extras });

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

function row(r: ArchiveRow, tz: string): string {
  const who = r.isSelf ? 'you' : (r.authorName ?? r.authorId ?? '?');
  const kind = r.kind === 'message' ? '' : ` [${r.kind}]`;
  const text = r.snippet ?? truncate(r.text.replace(/\n+/g, ' ⏎ '), 500);
  return `[${formatTime(r.ts, tz)}] ${r.channelName ?? r.channelId} · ${who}${kind}: ${text} (id ${r.messageId})`;
}

/** The "relay" MCP server: Discord and memory tools bound to one conversation. */
export function relayTools(d: ToolDeps) {
  const tz = d.cfg.timezone;
  const channelArg = z.string().optional().describe('Channel or thread id. Defaults to the current conversation.');

  async function channelOf(id: string | undefined): Promise<string> {
    const ch = id || d.defaultChannel();
    if (!(await d.inScope(ch))) throw new Error(`channel ${ch} is not one of this bot's channels`);
    return ch;
  }

  return createSdkMcpServer({
    name: 'relay',
    version: '0.1.0',
    tools: [
      loaded(
        'react',
        'Add an emoji reaction to the message that triggered you (default) or to any message by id. Use final=true on the triggering message to make this emoji the "finished" mark instead of ✅.',
        {
          emoji: z.string().describe('A unicode emoji, or a custom one as <:name:id>'),
          message_id: z.string().optional(),
          channel_id: channelArg,
          final: z.boolean().optional(),
        },
        async (a) => {
          const turn = d.currentTurn();
          const target = a.message_id ?? turn?.main?.messageId;
          if (!target) return fail('No message to react to: pass message_id.');
          const channel = a.channel_id ?? (a.message_id ? d.defaultChannel() : (turn?.main?.channelId ?? d.defaultChannel()));
          try {
            await channelOf(channel);
            if (a.final && turn?.main && target === turn.main.messageId) {
              turn.finalReaction = a.emoji;
              return ok(`${a.emoji} will mark the message when you finish.`);
            }
            await d.platform.react(channel, target, a.emoji);
            if (turn?.main && target === turn.main.messageId) turn.agentReacted = true;
            return ok(`Reacted ${a.emoji}.`);
          } catch (err) {
            return fail(`Could not react: ${(err as Error).message}`);
          }
        },
      ),
      loaded(
        'offer_choices',
        'Attach buttons to your answer so people can reply with one click. Call it before you write your final answer. Their pick comes back later as a <choice> event. Use 2-8 short options and give each a description of what happens if it is picked: the descriptions are listed with the buttons, so nobody has to guess. allow_other adds a button that opens a text box.',
        {
          question: z.string().optional().describe('Short question shown above the buttons, if your answer does not already end with it.'),
          options: z
            .union([
              z.array(
                z.union([
                  z.string(),
                  z.object({
                    label: z.string().describe('1-5 words'),
                    description: z.string().optional().describe('What you will do if this is picked, in one short line'),
                    emoji: z.string().optional(),
                    style: z.enum(['primary', 'secondary', 'success', 'danger']).optional(),
                  }),
                ]),
              ),
              z.string(),
            ])
            .optional()
            .describe('The buttons, e.g. [{"label":"Approve","emoji":"✅","style":"success"},{"label":"Not now"}]'),
          choices: z.unknown().optional().describe('Alias of options'),
          allow_other: z.boolean().optional(),
        },
        async (a) => {
          const turn = d.currentTurn();
          if (!turn || turn.quiet) return fail('There is no answer to attach buttons to right now.');
          const options = normalizeOptions(a.options ?? a.choices);
          if (options.length === 0) return fail('Give at least one option in "options".');
          turn.choices = { question: a.question, options: options.slice(0, 12), allowOther: Boolean(a.allow_other) };
          return ok('The buttons will appear under your answer. Finish your answer normally.');
        },
      ),
      loaded(
        'send_message',
        'Post a message right away: a progress note during long work, or a post in another of your channels. Your final answer is posted automatically; do not repeat it here.',
        {
          text: z.string(),
          channel_id: channelArg,
          reply_to: z.string().optional().describe('Message id to reply to'),
          silent: z.boolean().optional().describe('No notification'),
        },
        async (a) => {
          try {
            const ch = await channelOf(a.channel_id);
            const ids = await d.platform.send(ch, { text: a.text, replyTo: a.reply_to, silent: a.silent });
            d.recordSent(ch, ids, a.text, d.currentTurn()?.id);
            return ok(`Sent (id ${ids.join(', ')}).`);
          } catch (err) {
            return fail(`Could not send: ${(err as Error).message}`);
          }
        },
      ),
      loaded(
        'upload_file',
        'Send a local file (image, report, log...) to a channel, with an optional message.',
        { path: z.string(), channel_id: channelArg, text: z.string().optional() },
        async (a) => {
          try {
            const file = path.resolve(d.cfg.context, a.path);
            const stat = fs.statSync(file);
            if (stat.size > 25 * 1024 * 1024) return fail('File is larger than 25 MB.');
            const ch = await channelOf(a.channel_id);
            const ids = await d.platform.send(ch, { text: a.text, files: [{ path: file }] });
            d.recordSent(ch, ids, `${a.text ?? ''} [file: ${path.basename(file)}]`, d.currentTurn()?.id);
            return ok(`Uploaded ${path.basename(file)}.`);
          } catch (err) {
            return fail(`Could not upload: ${(err as Error).message}`);
          }
        },
      ),
      loaded(
        'channel_messages',
        'Read messages straight from Discord, including ones that did not mention you. Newest-first windows: give before/after/around a message id, or nothing for the latest.',
        {
          channel_id: channelArg,
          before: z.string().optional(),
          after: z.string().optional(),
          around: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
        async (a) => {
          try {
            const ch = await channelOf(a.channel_id);
            const msgs = await d.platform.fetchHistory(ch, { before: a.before, after: a.after, around: a.around, limit: a.limit ?? 30 });
            if (!msgs.length) return ok('No messages.');
            const ctx = d.envelope();
            return ok(msgs.map((m) => contextLine(m, ctx, 1500)).join('\n'));
          } catch (err) {
            return fail(`Could not read the channel: ${(err as Error).message}`);
          }
        },
      ),
      loaded(
        'get_message',
        'Read one message in full: author, time, text, attachments (with URLs), reactions and what it replies to.',
        { message_id: z.string(), channel_id: channelArg },
        async (a) => {
          try {
            const ch = await channelOf(a.channel_id);
            const m = await d.platform.fetchMessage(ch, a.message_id);
            if (!m) {
              const archived = d.archive.getMessage(d.platform.name, a.message_id);
              return archived ? ok(`(from the archive; deleted or not reachable)\n${row(archived, tz)}\n${archived.text}`) : fail('Message not found.');
            }
            const lines = [
              `id ${m.id} · ${m.chat.name ?? m.chat.channelId} · ${formatTime(m.ts, tz)}${m.editedTs ? ' (edited)' : ''}`,
              `from ${m.fromSelf ? 'you' : `${m.author.name} (user_id ${m.author.id})`}`,
              m.replyToId ? `reply to ${m.replyToId}` : '',
              '',
              m.text || '(no text)',
              m.extra ?? '',
              ...m.attachments.map((x) => `attachment: ${x.name} (${x.contentType ?? '?'}, ${Math.round(x.size / 1024)} KB) ${x.url}`),
              m.reactions?.length ? `reactions: ${m.reactions.map((r) => `${r.emoji}×${r.count}${r.self ? ' (incl. you)' : ''}`).join(' ')}` : '',
              m.url ? `link: ${m.url}` : '',
            ];
            return ok(lines.filter((l, i) => l || i === 3).join('\n'));
          } catch (err) {
            return fail(`Could not read the message: ${(err as Error).message}`);
          }
        },
      ),
      loaded(
        'history_search',
        'Full-text search over the archive of every message in your channels (accent-insensitive; all words must match; the last word matches as a prefix). Use it to recall anything said before, also from before compactions and resets.',
        {
          query: z.string(),
          channel_id: z.string().optional().describe('Only this channel. Default: all your channels.'),
          author: z.string().optional().describe('User id or (part of) a name'),
          since: z.string().optional().describe('ISO date/time or relative like 7d, 12h'),
          until: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
        async (a) => {
          const rows = d.archive.search({
            query: a.query,
            channelId: a.channel_id,
            author: a.author,
            since: parseWhen(a.since),
            until: parseWhen(a.until),
            limit: a.limit ?? 20,
          });
          if (!rows.length) return ok('Nothing found. Try fewer or different words, or history_read for a time window.');
          return ok(rows.map((r) => row(r, tz)).join('\n'));
        },
      ),
      loaded(
        'history_read',
        'Read the archive in order: around a message id, in a time window, or the latest messages of a channel.',
        {
          channel_id: z.string().optional(),
          around_message_id: z.string().optional(),
          since: z.string().optional().describe('ISO date/time or relative like 2d'),
          until: z.string().optional(),
          limit: z.number().int().min(1).max(200).optional(),
        },
        async (a) => {
          const rows = d.archive.read({
            channelId: a.channel_id ?? (a.around_message_id ? undefined : d.defaultChannel()),
            aroundMessageId: a.around_message_id,
            since: parseWhen(a.since),
            until: parseWhen(a.until),
            limit: a.limit ?? 40,
            platform: d.platform.name,
          });
          if (!rows.length) return ok('No archived messages for that.');
          return ok(rows.map((r) => row(r, tz)).join('\n'));
        },
      ),
      loaded(
        'find_member',
        'Find people on the server by name, to get the user id for a <@id> mention.',
        { query: z.string() },
        async (a) => {
          const found = await d.platform.findMembers(a.query);
          if (found.length) return ok(found.map((u) => `${u.name} (@${u.username ?? '?'}) user_id ${u.id}${u.isBot ? ' [bot]' : ''}`).join('\n'));
          const seen = d.archive.search({ query: a.query, limit: 50 }).filter((r) => r.authorName?.toLowerCase().includes(a.query.toLowerCase()));
          const uniq = new Map(seen.map((r) => [r.authorId, r.authorName]));
          if (uniq.size) return ok([...uniq].map(([id, name]) => `${name} user_id ${id} (from the archive)`).join('\n'));
          return ok('Nobody found.');
        },
      ),
      loaded(
        'schedule_create',
        'Create a timer that starts a turn for you later with the given prompt: a cron expression in the bot timezone ("0 18 * * 1-5" = weekdays 18:00), an ISO date-time for a one-off ("2026-10-30T09:00"), or a delay ("in 10m", "+2h", "1 day"). Confirm with the person before creating recurring tasks they did not ask for.',
        {
          name: z.string(),
          when: z.string(),
          prompt: z.string().describe('What to do when it fires, written as instructions to yourself'),
          channel_id: channelArg,
          timezone: z.string().optional(),
        },
        async (a) => {
          try {
            const ch = await channelOf(a.channel_id);
            const turn = d.currentTurn();
            const { row: r, next } = d.scheduler.create({
              name: a.name,
              when: a.when,
              prompt: a.prompt,
              channelId: ch,
              timezone: a.timezone,
              createdBy: turn?.main?.userId,
              source: 'agent',
            });
            return ok(`Created ${r.id}. Next run: ${next ? formatTime(next.getTime(), a.timezone ?? tz) : 'never'}.`);
          } catch (err) {
            return fail(`Could not create the schedule: ${(err as Error).message}`);
          }
        },
      ),
      loaded('schedule_list', 'List scheduled tasks with their next run.', {}, async () => {
        const rows = d.scheduler.list();
        if (!rows.length) return ok('No scheduled tasks.');
        return ok(
          rows
            .map(
              (r) =>
                `${r.id} · "${r.name}" · ${r.when}${r.timezone ? ` (${r.timezone})` : ''} · channel ${r.channelId} · ${r.enabled ? `next ${r.next ? formatTime(r.next.getTime(), r.timezone ?? tz) : '—'}` : 'disabled'} · from ${r.source}\n  ${oneLine(r.prompt, 200)}`,
            )
            .join('\n'),
        );
      }),
      loaded('schedule_delete', 'Delete a scheduled task by id.', { id: z.string() }, async (a) => {
        const row = d.scheduler.list().find((r) => r.id === a.id);
        if (row?.source === 'config') return fail('That schedule comes from the bot config; an owner has to remove it there.');
        return d.scheduler.remove(a.id) ? ok(`Deleted ${a.id}.`) : fail('No such schedule.');
      }),
      loaded('bot_status', 'Your own status: model, effort, context use, session, cost and where your memory lives.', {}, async () => {
        const i = d.info();
        const s = d.sessionStats();
        const rl = i.rateLimits;
        const lines = [
          `model: ${i.modelLabel ?? '?'} (${i.model ?? 'default'}), context window ${windowLabel(i.contextWindow)}, effort ${i.effort ?? 'default'}`,
          `context: ${tokensLabel(i.ctxTokens)} of ${tokensLabel(i.ctxMax)} (${i.ctxPercent ?? '?'}%), compacted ${s.compactions}× in this session`,
          `session: ${i.sessionId ?? 'not started'}${i.transcriptPath ? `, transcript ${i.transcriptPath}` : ''}`,
          rl ? `plan usage: 5h ${pct(rl.fiveHour)}, 7d ${pct(rl.sevenDay)}` : '',
          i.totalCostUsd ? `cost this process: $${i.totalCostUsd.toFixed(2)} (API-equivalent)` : '',
          `notebook: ${d.paths.notebook}`,
          `archive: ${d.paths.db} (${s.archived} messages, ${s.turns} turns)`,
          `inbox: ${d.paths.inbox}`,
          `claude code ${i.cliVersion ?? '?'}, permission mode ${i.permissionMode ?? '?'}`,
          `MCP: ${(i.mcpServers ?? []).map((m) => `${m.name} (${m.status})`).join(', ') || '?'}`,
        ];
        return ok(lines.filter(Boolean).join('\n'));
      }),
    ],
  });
}

type Option = { label: string; description?: string; emoji?: string; style?: 'primary' | 'secondary' | 'success' | 'danger' };

/** Models sometimes send the options as a JSON string or as plain labels; accept all of them. */
function normalizeOptions(raw: unknown): Option[] {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw.split(/\n|,|\|/).map((s) => s.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((o): Option | undefined => {
      if (typeof o === 'string') return { label: o };
      if (o && typeof o === 'object' && typeof (o as Option).label === 'string') {
        const { label, description, emoji, style } = o as Option;
        return {
          label,
          description: typeof description === 'string' && description.trim() ? description.trim() : undefined,
          emoji,
          style: ['primary', 'secondary', 'success', 'danger'].includes(style ?? '') ? style : undefined,
        };
      }
      return undefined;
    })
    .filter((o): o is Option => Boolean(o?.label.trim()));
}

function pct(v: number | undefined): string {
  if (v === undefined) return '?';
  return `${Math.round(v <= 1 ? v * 100 : v)}%`;
}
