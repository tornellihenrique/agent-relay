import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { BOT_PERMISSIONS } from '../platform/discord.js';
import { listBotIds, parseBotConfig, type BotConfigInput } from '../core/config.js';
import { botPaths, readJson, writeJsonAtomic } from '../core/paths.js';
import { checkDiscordChannel, checkDiscordToken } from './checks.js';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

/** `relay new`: asks the few things a bot needs and writes ~/.agent-relay/bots/<id>/bot.json. */
export async function newBotWizard(): Promise<string | undefined> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def?: string) => {
    const a = (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim();
    return a || def || '';
  };
  try {
    console.log('\nNew bot. Press Enter to accept the value in [brackets].\n');
    const context = path.resolve(await ask('Folder the agent works in (its context)', process.cwd()));
    if (!fs.existsSync(context)) throw new Error(`folder does not exist: ${context}`);

    console.log('\nDiscord: create an application at https://discord.com/developers/applications → Bot → Reset Token,');
    console.log('and turn on "Message Content Intent" on the same page.');
    let token = '';
    let identity: Awaited<ReturnType<typeof checkDiscordToken>> | undefined;
    while (!identity) {
      token = await ask('Bot token (or env:VARIABLE)');
      try {
        identity = await checkDiscordToken(token);
        console.log(`  ✓ bot "${identity.username}" (${identity.id})${identity.messageContentIntent === false ? '  ⚠ Message Content Intent is OFF: turn it on or the bot cannot read messages' : ''}`);
      } catch (err) {
        console.log(`  ✗ ${(err as Error).message}`);
      }
    }
    const name = await ask('Name the agent uses for itself', identity.username);
    let id = slug(await ask('Bot id (folder name, lowercase)', slug(name) || slug(path.basename(context))));
    while (listBotIds().includes(id)) id = slug(await ask(`"${id}" exists; another id`));

    const invite = `https://discord.com/oauth2/authorize?client_id=${identity.appId ?? identity.id}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS.bitfield}`;
    console.log(`\nInvite the bot to your server (if not yet): ${invite}`);
    console.log('Ids: Discord Settings → Advanced → Developer Mode, then right-click a channel or user → Copy ID.\n');
    const channels = list(await ask('Channel ids where it listens (comma separated; threads inside them count)'));
    for (const ch of channels) {
      try {
        console.log(`  ✓ ${ch}: ${await checkDiscordChannel(token, ch)}`);
      } catch (err) {
        console.log(`  ✗ ${ch}: ${(err as Error).message}`);
      }
    }
    const owners = list(await ask('Owner user ids (can change settings and approve tools)'));
    const users = list(await ask('Extra user ids allowed anywhere, DMs included (optional)', ''));
    const trigger = (await ask('Answer "mentions" (mentions and replies) or "all" messages', 'mentions')) === 'all' ? 'all' : 'mentions';
    const model = await ask('Model (opus, sonnet, haiku, fable, or a full id; empty = CLI default)', 'opus');
    const effort = await ask('Effort (low, medium, high, xhigh, max; empty = model default)', 'high');
    const label = await ask('Short label for the status line', name.split(/\s+/).at(-1));
    const mcpAllow = list(await ask('MCP servers it may use (comma separated; empty = all configured)', ''));

    const cfg: BotConfigInput = {
      id,
      name,
      enabled: true,
      context,
      owners,
      platform: { type: 'discord', token, channels, users },
      agent: {
        ...(model ? { model } : {}),
        ...(effort ? { effort: effort as never } : {}),
        ...(mcpAllow.length ? { mcp: { allow: mcpAllow } } : {}),
      },
      conversation: { trigger },
      status: { label },
    };
    parseBotConfig(cfg, 'wizard');
    writeJsonAtomic(botPaths(id).config, cfg);
    console.log(`\n✓ Saved ${botPaths(id).config}`);
    console.log('  Everything else (feedback, reactions, schedules, instructions) has defaults; see the README to tune it.');
    return id;
  } finally {
    rl.close();
  }
}

/** `relay import-cti`: turns a Claude-to-IM (~/.claude-to-im/config.env) setup into a bot. */
export async function importClaudeToIm(file: string): Promise<string> {
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const token = env.CTI_DISCORD_BOT_TOKEN;
  if (!token) throw new Error('no CTI_DISCORD_BOT_TOKEN in that file (only Discord is imported)');
  const context = env.CTI_DEFAULT_WORKDIR || process.cwd();
  const identity = await checkDiscordToken(token);
  let id = slug(path.basename(context)) || slug(identity.username);
  while (listBotIds().includes(id)) id = `${id}-2`;
  const mentions = env.CTI_DISCORD_REQUIRE_MENTION !== 'false' || env.CTI_DISCORD_GROUP_POLICY === 'mention';
  const cfg: BotConfigInput = {
    id,
    name: identity.username,
    enabled: false,
    context,
    owners: list(env.CTI_DISCORD_ALLOWED_USERS ?? ''),
    platform: {
      type: 'discord',
      token,
      channels: list(env.CTI_DISCORD_ALLOWED_CHANNELS ?? ''),
      users: list(env.CTI_DISCORD_ALLOWED_USERS ?? ''),
    },
    agent: {
      ...(env.CTI_DEFAULT_MODEL ? { model: env.CTI_DEFAULT_MODEL } : {}),
      permissionMode: env.CTI_DEFAULT_MODE === 'plan' ? 'plan' : env.CTI_AUTO_APPROVE === 'true' ? 'bypassPermissions' : 'acceptEdits',
    },
    conversation: { trigger: mentions ? 'mentions' : 'all' },
  };
  parseBotConfig(cfg, file);
  writeJsonAtomic(botPaths(id).config, cfg);
  const existing = readJson(botPaths(id).config);
  return `Imported "${identity.username}" as bot "${id}" (${existing ? botPaths(id).config : ''}). It is disabled until you review it and run: relay start ${id}`;
}
