import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { botPaths, paths, readJson, writeJsonAtomic } from './paths.js';

const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const TriggerMode = z.enum(['mentions', 'all', 'off']);
export type TriggerMode = z.infer<typeof TriggerMode>;

const ChannelSettings = z.object({
  trigger: TriggerMode.optional(),
  recentMessages: z.number().int().min(0).max(100).optional(),
});

const DiscordPlatform = z.object({
  type: z.literal('discord'),
  /** Bot token. May be "env:VAR" or "file:path" to keep it out of this file. */
  token: z.string().min(1),
  /** Channels (or threads, or forum/category parents) the bot listens in. */
  channels: z.array(z.string()).default([]),
  /** Users who may talk to the bot anywhere it can see them, DMs included. */
  users: z.array(z.string()).default([]),
  blockedUsers: z.array(z.string()).default([]),
  /** Reacting with this emoji on any message asks the bot to look at it. */
  summonEmoji: z.string().default('🤖'),
  respondToBots: z.boolean().default(false),
  /** Hide link previews on the bot's messages (Jira/GitHub links otherwise fill the channel). */
  suppressEmbeds: z.boolean().default(true),
  /** What the bot's messages may ping. */
  allowMentions: z.array(z.enum(['users', 'roles', 'everyone'])).default(['users']),
  /** Register slash commands (/status, /model, /compact...). */
  slashCommands: z.boolean().default(true),
});

const Platform = z.discriminatedUnion('type', [DiscordPlatform]);

const Agent = z.object({
  runtime: z.enum(['claude']).default('claude'),
  /** Model id or alias (opus, sonnet, haiku, fable, claude-opus-5-5...). Empty = the CLI default. */
  model: z.string().optional(),
  fallbackModel: z.string().optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  /** Whether reasoning text is returned (needed for the live "thinking" message). */
  thinking: z.enum(['summarized', 'omitted']).default('summarized'),
  /** subscription = the Claude login on this machine; apiKey = ANTHROPIC_API_KEY below. */
  auth: z.enum(['subscription', 'apiKey']).default('subscription'),
  apiKey: z.string().optional(),
  /** Use a different Claude account/config for this bot (sets CLAUDE_CONFIG_DIR). */
  claudeConfigDir: z.string().optional(),
  /** Path to a claude executable. Empty = the one bundled with the SDK. */
  executable: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']).default('acceptEdits'),
  allowedTools: z.array(z.string()).default([]),
  disallowedTools: z.array(z.string()).default([]),
  /**
   * MCP servers the bot may use, by name as Claude Code shows them ("jira-pm", "claude.ai Google Drive").
   * allow: only these (plus the relay's own). deny: never these. Unset allow = everything configured.
   */
  mcp: z
    .object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).default([]),
    })
    .prefault({}),
  settingSources: z.array(z.enum(['user', 'project', 'local'])).default(['user', 'project', 'local']),
  additionalDirectories: z.array(z.string()).default([]),
  /** Extra instructions appended to the system prompt. */
  instructions: z.string().default(''),
  instructionsFile: z.string().optional(),
  /** Close the agent process after this many idle minutes (0 = keep it warm forever). */
  idleMinutes: z.number().min(0).default(60),
  /** Start the agent when the bot starts, so the first answer is fast. */
  warmStart: z.boolean().default(true),
  turnTimeoutMinutes: z.number().min(1).default(45),
  /** At this context %, save notes and compact before Claude Code's own auto-compact kicks in. */
  compactAtPercent: z.number().min(10).max(100).default(85),
  /** Ask the agent to update its notebook before any compaction or reset. */
  saveBeforeCompact: z.boolean().default(true),
});

const Conversation = z.object({
  /** channel = one agent session per channel/thread/DM; bot = one session for everything. */
  scope: z.enum(['channel', 'bot']).default('channel'),
  /** mentions = answer @mentions and replies to the bot; all = every message; off = commands only. */
  trigger: TriggerMode.default('mentions'),
  /** Unseen channel messages included as context with each trigger. */
  recentMessages: z.number().int().min(0).max(100).default(12),
  channelSettings: z.record(z.string(), ChannelSettings).default({}),
});

const Reactions = z.object({
  received: z.string().default('👀'),
  queued: z.string().default('⏳'),
  thinking: z.string().default('🤔'),
  writing: z.string().default('✍️'),
  done: z.string().default('✅'),
  error: z.string().default('⚠️'),
  stopped: z.string().default('⏹️'),
  waiting: z.string().default('🙋'),
});

const Feedback = z.object({
  /** Turns running longer than this get a live "working" message. */
  liveAfterSeconds: z.number().min(0).default(6),
  /** Add a small footer (model, time, tools, ctx) to answers. auto = only for long or tool-heavy turns. */
  footer: z.enum(['auto', 'always', 'never']).default('auto'),
  /** Ping the asker in the reply when the turn took longer than this (they may have moved on). */
  pingAfterSeconds: z.number().min(0).default(45),
  /** Show tool-specific emoji (🔎 📖 ✏️ 💻 🌐 🔌) on the triggering message while working. */
  toolReactions: z.boolean().default(true),
  reactions: Reactions.prefault({}),
  /** Offer Claude Code's predicted next prompt as a button under answers. */
  promptSuggestions: z.boolean().default(false),
});

const Status = z.object({
  /** Placeholders: {label} {model} {window} {ctx} {effort} {state} {queue} {five_hour} {seven_day} */
  template: z.string().default('{label} | {model} ({window}) | ctx {ctx}'),
  label: z.string().optional(),
});

const Memory = z.object({
  /** Folder for the bot's own notes. Default: <bot home>/notebook. */
  notebook: z.string().optional(),
  /** all = archive every message in the bot's channels; interactions = only what involves the bot. */
  archive: z.enum(['all', 'interactions']).default('all'),
});

export const ScheduleSpec = z.object({
  id: z.string(),
  /** Cron expression ("0 18 * * 1-5") or an ISO date for a one-off. */
  when: z.string(),
  timezone: z.string().optional(),
  channel: z.string(),
  prompt: z.string(),
  enabled: z.boolean().default(true),
});
export type ScheduleSpec = z.infer<typeof ScheduleSpec>;

export const BotConfig = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase letters, digits, - and _'),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  /** The folder the agent works in (its cwd). Several bots may share one. */
  context: z.string().min(1),
  timezone: z.string().default(systemTimezone),
  /** Platform user ids who can change settings, approve tool permissions and reset the bot. */
  owners: z.array(z.string()).default([]),
  platform: Platform,
  agent: Agent.prefault({}),
  conversation: Conversation.prefault({}),
  feedback: Feedback.prefault({}),
  status: Status.prefault({}),
  memory: Memory.prefault({}),
  schedules: z.array(ScheduleSpec).default([]),
});

export type BotConfig = z.infer<typeof BotConfig>;
export type BotConfigInput = z.input<typeof BotConfig>;

export const GlobalConfig = z.object({
  dashboardPort: z.number().int().min(0).default(7717),
  restartBackoffSeconds: z.array(z.number()).default([2, 5, 15, 30, 60]),
});
export type GlobalConfig = z.infer<typeof GlobalConfig>;

export function loadGlobalConfig(): GlobalConfig {
  return GlobalConfig.parse(readJson(paths.globalConfig) ?? {});
}

export class ConfigError extends Error {}

function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

export function parseBotConfig(raw: unknown, source: string): BotConfig {
  const res = BotConfig.safeParse(raw);
  if (!res.success) throw new ConfigError(`Invalid bot config ${source}:\n${formatIssues(res.error)}`);
  const cfg = res.data;
  cfg.context = path.resolve(cfg.context);
  return cfg;
}

export function loadBotConfig(botId: string): BotConfig {
  const file = botPaths(botId).config;
  if (!fs.existsSync(file)) throw new ConfigError(`No bot "${botId}" (expected ${file})`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Cannot parse ${file}: ${(err as Error).message}`);
  }
  const cfg = parseBotConfig(raw, file);
  if (cfg.id !== botId) throw new ConfigError(`${file}: id "${cfg.id}" does not match its folder "${botId}"`);
  return cfg;
}

export function listBotIds(): string[] {
  try {
    return fs
      .readdirSync(paths.bots, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(paths.bots, d.name, 'bot.json')))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Reads the raw JSON (keeps the user's formatting choices and unknown keys) and patches it. */
export function patchBotConfig(botId: string, patch: (raw: Record<string, any>) => void): void {
  const file = botPaths(botId).config;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
  patch(raw);
  parseBotConfig(raw, file);
  writeJsonAtomic(file, raw);
}

/** Resolves "env:NAME" and "file:path" indirections used for secrets. */
export function resolveSecret(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value.startsWith('env:')) return process.env[value.slice(4)];
  if (value.startsWith('file:')) {
    try {
      return fs.readFileSync(value.slice(5), 'utf8').trim();
    } catch {
      return undefined;
    }
  }
  return value;
}
