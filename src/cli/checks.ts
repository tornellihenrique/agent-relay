import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildAgentEnv, deniedServers } from '../agent/claude.js';
import { AsyncQueue } from '../core/async.js';
import { resolveSecret, type BotConfig } from '../core/config.js';

/** Checks shared by `relay doctor` and the setup wizard. */

const API = 'https://discord.com/api/v10';

export interface DiscordIdentity {
  id: string;
  username: string;
  appId?: string;
  messageContentIntent?: boolean;
}

async function discord<T>(token: string, path: string): Promise<{ ok: boolean; status: number; body: T }> {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bot ${token}` }, signal: AbortSignal.timeout(15_000) });
  const body = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, body };
}

export async function checkDiscordToken(rawToken: string): Promise<DiscordIdentity> {
  const token = resolveSecret(rawToken);
  if (!token) throw new Error('token is empty');
  const me = await discord<{ id: string; username: string; message?: string }>(token, '/users/@me');
  if (!me.ok) throw new Error(me.status === 401 ? 'Discord rejected the token (401)' : `Discord answered ${me.status}`);
  const app = await discord<{ id: string; flags?: number }>(token, '/applications/@me');
  const flags = app.body.flags ?? 0;
  return {
    id: me.body.id,
    username: me.body.username,
    appId: app.body.id,
    messageContentIntent: app.ok ? Boolean(flags & ((1 << 18) | (1 << 19))) : undefined,
  };
}

export async function checkDiscordChannel(rawToken: string, channelId: string): Promise<string> {
  const token = resolveSecret(rawToken)!;
  const ch = await discord<{ name?: string; guild_id?: string; type?: number; message?: string }>(token, `/channels/${channelId}`);
  if (!ch.ok) throw new Error(ch.status === 403 || ch.status === 404 ? 'the bot cannot see this channel (not invited, or no View Channel permission)' : `Discord answered ${ch.status}`);
  let guild = '';
  if (ch.body.guild_id) {
    const g = await discord<{ name?: string }>(token, `/guilds/${ch.body.guild_id}`);
    if (g.ok) guild = ` in "${g.body.name}"`;
  }
  return `#${ch.body.name ?? channelId}${guild}`;
}

export interface ClaudeCheck {
  account?: string;
  subscription?: string;
  mcp: { name: string; status: string; hidden: boolean; error?: string }[];
  error?: string;
}

/** Starts the agent in the bot's folder without sending a prompt (no tokens used) and asks who it is. */
export async function checkClaude(cfg: BotConfig, timeoutMs = 60_000): Promise<ClaudeCheck> {
  const input = new AsyncQueue<SDKUserMessage>();
  const q = query({
    prompt: input,
    options: {
      cwd: cfg.context,
      env: buildAgentEnv(cfg.agent),
      settingSources: cfg.agent.settingSources,
      pathToClaudeCodeExecutable: cfg.agent.executable,
      stderr: () => {},
    },
  });
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out')), timeoutMs));
  try {
    const account = await Promise.race([q.accountInfo(), timeout]);
    let statuses = await Promise.race([q.mcpServerStatus(), timeout]);
    // claude.ai connectors start as "pending"; give them a moment.
    for (let i = 0; i < 10 && statuses.some((s) => s.status === 'pending'); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      statuses = await Promise.race([q.mcpServerStatus(), timeout]);
    }
    const hidden = new Set(deniedServers(statuses.map((s) => s.name), cfg.agent.mcp));
    return {
      account: account.email ?? account.apiKeySource ?? account.apiProvider,
      subscription: account.subscriptionType,
      mcp: statuses.map((s) => ({ name: s.name, status: s.status, hidden: hidden.has(s.name), error: s.error })),
    };
  } catch (err) {
    return { mcp: [], error: (err as Error).message };
  } finally {
    input.close();
    q.close();
  }
}
