import fs from 'node:fs';
import path from 'node:path';
import { tokensLabel, windowLabel } from '../agent/models.js';
import { EFFORT_LEVELS, type Effort, type TriggerMode } from '../core/config.js';
import { ago, formatTime, oneLine, parseWhen, truncate } from '../core/text.js';
import type { CommandSpec, Interaction } from '../platform/types.js';
import type { Bot } from './bot.js';

export const COMMANDS: CommandSpec[] = [
  { name: 'status', description: 'Model, effort, context use, session and memory of this channel' },
  {
    name: 'model',
    description: 'Show or change the model, for every channel or only this one (owners)',
    options: [
      { name: 'name', description: 'Model or alias (opus, sonnet, haiku, fable…); "default" = the CLI default', type: 'string', autocomplete: true },
      { name: 'only_here', description: 'Change only this channel (default: every channel)', type: 'boolean' },
    ],
  },
  {
    name: 'effort',
    description: 'Show or change the reasoning effort, for every channel or only this one (owners)',
    options: [
      { name: 'level', description: 'Effort level', type: 'string', choices: [...EFFORT_LEVELS, 'default'].map((v) => ({ name: v, value: v })) },
      { name: 'only_here', description: 'Change only this channel (default: every channel)', type: 'boolean' },
    ],
  },
  {
    name: 'compact',
    description: 'Save notes, then compact the conversation (frees context; history stays searchable)',
    options: [{ name: 'focus', description: 'What the summary should keep', type: 'string' }],
  },
  { name: 'new', description: 'Save notes and start a fresh session in this channel (owners)' },
  { name: 'stop', description: 'Stop what the bot is doing in this channel' },
  { name: 'context', description: 'What fills the context window right now' },
  { name: 'memory', description: "The bot's notebook index and where its memory lives" },
  {
    name: 'history',
    description: 'Search everything said in the bot channels',
    options: [
      { name: 'query', description: 'Words to find (accents ignored)', type: 'string', required: true },
      { name: 'since', description: 'e.g. 7d, 12h, 2026-10-01', type: 'string' },
    ],
  },
  {
    name: 'listen',
    description: 'When the bot answers in this channel (owners)',
    options: [
      {
        name: 'mode',
        description: 'mentions = @mentions and replies; all = every message; off = only commands',
        type: 'string',
        required: true,
        choices: [
          { name: 'mentions and replies', value: 'mentions' },
          { name: 'every message', value: 'all' },
          { name: 'off', value: 'off' },
          { name: 'bot default', value: 'default' },
        ],
      },
    ],
  },
  {
    name: 'schedules',
    description: 'List scheduled tasks, or remove one',
    options: [{ name: 'remove', description: 'Id of a schedule to remove (owners)', type: 'string' }],
  },
  { name: 'usage', description: 'Plan usage (5-hour and weekly limits) and session cost' },
  { name: 'restart', description: 'Restart the agent process; the session resumes (owners)' },
  { name: 'help', description: 'What the bot can do and how to talk to it' },
];

const OWNER_ONLY = new Set(['new', 'restart']);

export async function handleCommand(bot: Bot, i: Interaction): Promise<void> {
  const conv = bot.conversationFor(i.chat);
  const owner = bot.owners.has(i.user.id);
  const say = (text: string) => i.reply({ text: truncate(text, 1990), private: true });

  if (i.kind === 'autocomplete') {
    if (i.key === 'model') {
      const typed = (i.focused?.value ?? '').toLowerCase();
      let models: { value: string; label: string }[] = [];
      try {
        models = await Promise.race([
          conv.ensureSession().models(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('slow')), 2500)),
        ]);
      } catch { /* fall back to aliases */ }
      if (!models.length) models = ['opus', 'sonnet', 'haiku', 'fable'].map((v) => ({ value: v, label: v }));
      const rows = [{ value: 'default', label: 'default (the CLI default)' }, ...models];
      await i.autocomplete(
        rows
          .filter((m) => !typed || m.value.toLowerCase().includes(typed) || m.label.toLowerCase().includes(typed))
          .map((m) => ({ name: m.value === m.label ? m.value : `${m.label} — ${m.value}`, value: m.value })),
      );
    }
    return;
  }

  if (OWNER_ONLY.has(i.key) && !owner) return say('Only the bot owners can do that.');

  switch (i.key) {
    case 'help':
      return say(helpText(bot));

    case 'status': {
      const info = bot.infoOf(conv);
      const rl = info.rateLimits;
      const pct = (v?: number) => (v === undefined ? '?' : `${Math.round(v <= 1 ? v * 100 : v)}%`);
      const lines = [
        `**${bot.cfg.name}** · ${conv.busy ? '⚙️ working' : info.alive ? '🟢 ready' : '💤 asleep (wakes on the next message)'}${conv.queued ? ` · ${conv.queued} queued` : ''}`,
        `**Model** ${info.modelLabel ?? '?'}${info.contextWindow ? ` (${windowLabel(info.contextWindow)})` : ''} · effort **${info.effort ?? 'default'}**`,
        `**Context** ${tokensLabel(info.ctxTokens)} / ${tokensLabel(info.ctxMax)}${info.ctxPercent !== undefined ? ` (**${info.ctxPercent}%**)` : ''} · auto-compacts at ${bot.cfg.agent.compactAtPercent}%`,
        `**Session** \`${info.sessionId ?? 'none yet'}\`${conv.st.lastActiveAt ? ` · last turn ${ago(conv.st.lastActiveAt)}` : ''}`,
        rl ? `**Plan usage** 5h ${pct(rl.fiveHour)} · 7d ${pct(rl.sevenDay)}` : '',
        `**Listening** ${bot.triggerMode(i.chat)} · **Folder** \`${bot.cfg.context}\``,
        `-# Notebook ${bot.paths.notebook} · archive ${bot.archive.messageCount()} messages · claude ${info.cliVersion ?? '?'}`,
      ];
      return say(lines.filter(Boolean).join('\n'));
    }

    case 'model':
    case 'effort': {
      const what = i.key as 'model' | 'effort';
      const value = (what === 'model' ? i.options?.name : i.options?.level) as string | undefined;
      const here = conv.st[what];
      const botDefault = bot.cfg.agent[what];
      if (!value) {
        const info = bot.infoOf(conv);
        const current = what === 'model' ? `**${info.modelLabel ?? 'default'}** (${info.model ?? 'CLI default'})` : `**${info.effort ?? 'default'}**`;
        const source = here ? `set for this channel only; the bot default is ${botDefault ?? 'the CLI default'}` : 'the bot default for every channel';
        return say(`${what === 'model' ? 'Model' : 'Effort'}: ${current}, ${source}.`);
      }
      if (!owner) return say(`Only the bot owners can change the ${what}.`);
      await i.ack();
      const v = value === 'default' ? undefined : value;
      if (i.options?.only_here) {
        if (what === 'model') await conv.setModel(v);
        else await conv.setEffort(v as Effort | undefined);
        return i.reply({ text: `${what === 'model' ? 'Model' : 'Effort'} for this channel only: **${value}**. It applies from the next message.`, private: true });
      }
      await bot.setBotDefault(what, v);
      return i.reply({ text: `${what === 'model' ? 'Model' : 'Effort'} for every channel: **${value}** (saved in the bot config). It applies from the next message.`, private: true });
    }

    case 'compact': {
      await i.ack();
      conv.compact({
        focus: i.options?.focus as string | undefined,
        trigger: 'manual',
        by: i.user.name,
        channelId: i.chat.channelId,
        onDone: (msg) => void i.reply({ text: msg, private: true }).catch(() => {}),
      });
      return;
    }

    case 'new': {
      await i.ack();
      conv.reset({ by: i.user.name, channelId: i.chat.channelId, onDone: (msg) => void i.reply({ text: msg, private: true }).catch(() => {}) });
      return;
    }

    case 'stop': {
      const stopped = await conv.interrupt();
      return say(stopped ? '⏹️ Stopping.' : 'Nothing is running here.');
    }

    case 'restart': {
      await i.ack();
      await conv.interrupt();
      conv.close('restart');
      return i.reply({ text: '🔄 The agent process was stopped; it starts again (resuming the session) on the next message.', private: true });
    }

    case 'context': {
      await i.ack();
      const session = conv.ensureSession();
      await session.start();
      await session.refreshContext();
      const cats = await session.contextBreakdown();
      const info = session.info();
      const lines = [`**Context** ${tokensLabel(info.ctxTokens)} / ${tokensLabel(info.ctxMax)} (${info.ctxPercent ?? '?'}%)`];
      for (const c of (cats ?? []).sort((a, b) => b.tokens - a.tokens)) lines.push(`- ${c.name}: ${tokensLabel(c.tokens)}${c.kind !== 'used' ? ` (${c.kind})` : ''}`);
      lines.push(
        '-# When it fills up, the conversation is compacted into a summary (notes are saved to the notebook first). Every message stays in the archive and in the Claude Code transcript' +
          (info.transcriptPath ? ` (${info.transcriptPath})` : '') +
          '.',
      );
      return i.reply({ text: truncate(lines.join('\n'), 1990), private: true });
    }

    case 'memory': {
      const index = path.join(bot.paths.notebook, 'NOTEBOOK.md');
      let notes = '';
      try {
        notes = fs.readFileSync(index, 'utf8');
      } catch { /* none */ }
      const files = fs.existsSync(bot.paths.notebook) ? fs.readdirSync(bot.paths.notebook) : [];
      return say(
        [
          `**Notebook** \`${bot.paths.notebook}\` (${files.length} file${files.length === 1 ? '' : 's'})`,
          '```md',
          truncate(notes.trim() || '(empty)', 1300),
          '```',
          `**Archive** \`${bot.paths.db}\` · ${bot.archive.messageCount()} messages · ${bot.archive.turnStats().turns} turns`,
          `-# The agent reads the notebook at the start of every session and after each compaction, and searches the archive with history_search.`,
        ].join('\n'),
      );
    }

    case 'history': {
      const rows = bot.archive.search({
        query: String(i.options?.query ?? ''),
        since: parseWhen(i.options?.since as string | undefined),
        limit: 12,
      });
      if (!rows.length) return say('Nothing found.');
      return say(
        rows
          .map((r) => `\`${formatTime(r.ts, bot.cfg.timezone)}\` **${r.isSelf ? bot.cfg.name : (r.authorName ?? '?')}**: ${oneLine(r.snippet ?? r.text, 160)}`)
          .join('\n'),
      );
    }

    case 'listen': {
      if (!owner) return say('Only the bot owners can change when the bot answers.');
      const mode = String(i.options?.mode ?? '');
      bot.state.update((s) => {
        if (mode === 'default') delete s.triggers[i.chat.channelId];
        else s.triggers[i.chat.channelId] = mode as TriggerMode;
      });
      const now = bot.triggerMode(i.chat);
      const what = { mentions: 'when @mentioned or replied to', all: 'to every message', off: 'only to slash commands' }[now];
      return say(`In this channel the bot now answers ${what}.`);
    }

    case 'schedules': {
      const remove = i.options?.remove as string | undefined;
      if (remove) {
        if (!owner) return say('Only the bot owners can remove schedules.');
        const row = bot.scheduler.list().find((r) => r.id === remove);
        if (row?.source === 'config') return say('That schedule comes from the bot config file; remove it there.');
        return say(bot.scheduler.remove(remove) ? `Removed ${remove}.` : 'No such schedule.');
      }
      const rows = bot.scheduler.list();
      if (!rows.length) return say('No scheduled tasks. Ask the bot to schedule one ("every weekday at 18h, remind…").');
      return say(
        rows
          .map(
            (r) =>
              `\`${r.id}\` **${r.name}** · ${r.when} · <#${r.channelId}> · ${r.enabled && r.next ? `next ${formatTime(r.next.getTime(), r.timezone ?? bot.cfg.timezone)}` : 'off'}\n-# ${oneLine(r.prompt, 150)}`,
          )
          .join('\n'),
      );
    }

    case 'usage': {
      const info = bot.infoOf(conv);
      const rl = info.rateLimits;
      const pct = (v?: number) => (v === undefined ? '?' : `${Math.round(v <= 1 ? v * 100 : v)}%`);
      const reset = (t?: number) => (t ? ` (resets ${formatTime(t * 1000, bot.cfg.timezone)})` : '');
      const stats = bot.archive.turnStats();
      return say(
        [
          rl ? `**5-hour** ${pct(rl.fiveHour)}${reset(rl.fiveHourResetsAt)}\n**7-day** ${pct(rl.sevenDay)}${reset(rl.sevenDayResetsAt)}` : 'Plan usage shows up after the first answer.',
          `**Turns** ${stats.turns} · API-equivalent cost $${stats.costUsd.toFixed(2)}${bot.cfg.agent.auth === 'subscription' ? ' (covered by the subscription)' : ''}`,
        ].join('\n'),
      );
    }

    default:
      return say('Unknown command.');
  }
}

function helpText(bot: Bot): string {
  const mode = bot.cfg.conversation.trigger;
  return [
    `**${bot.cfg.name}** — an agent working in \`${path.basename(bot.cfg.context)}\`.`,
    mode === 'all' ? '• I read every message in my channels.' : '• Mention me or reply to one of my messages to talk to me. Replying to any message while mentioning me brings that message along.',
    `• React ${bot.cfg.platform.summonEmoji} on any message to pull me in. React on my messages to answer me: 👍 yes, 👎 no, ❓ explain, 🔁 redo.`,
    '• While I work you see a live message with my reasoning and tools; ⏹️ Stop (or a 🛑 reaction) interrupts me.',
    '• I remember: every message is archived and searchable, and I keep my own notebook.',
    '• Commands: /status /model /effort /compact /new /stop /context /memory /history /listen /schedules /usage /restart',
  ].join('\n');
}
