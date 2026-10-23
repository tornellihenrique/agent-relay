import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  query,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { BotConfig, Effort } from '../core/config.js';
import { resolveSecret } from '../core/config.js';
import { AsyncQueue, deferred } from '../core/async.js';
import type { Logger } from '../core/log.js';
import { modelLabel, type ModelCatalogRow } from './models.js';
import type {
  AgentInput,
  AgentSession,
  ContextCategory,
  ModelOption,
  RateLimits,
  SessionCallbacks,
  SessionInfo,
  TurnOutcome,
  TurnSink,
} from './types.js';

const CLIENT_APP = 'agent-relay/0.1.0';

/** Tools that make sense only in Claude Code's own UIs, or that the relay replaces. */
const DEFAULT_DISALLOWED = [
  'PushNotification',
  'SendUserMessage',
  'SendUserFile',
  'ShowOnboardingRolePicker',
  'ShareOnboardingGuide',
  'OfferChromeSetup',
  'EnterWorktree',
  'ExitWorktree',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
];

/** Relay tools that decorate the answer; calling them doesn't split "narration" from "answer". */
const COSMETIC_TOOLS = new Set(['mcp__relay__react', 'mcp__relay__offer_choices']);

/** Inherited variables that would point the agent at the parent's session, proxy or account. */
const INHERITED_PREFIXES = ['CLAUDE', 'ANTHROPIC_', 'MCP_', 'CCD_'];

export function mcpToolPrefix(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/** The MCP servers to hide, given what the session knows about and the bot's allow/deny lists. */
/** Whether the bot's MCP allow/deny lists let it call this tool (non-MCP tools always pass). */
export function mcpToolAllowed(toolName: string, mcp: BotConfig['agent']['mcp']): boolean {
  if (!toolName.startsWith('mcp__')) return true;
  const from = (server: string) => toolName.startsWith(`${mcpToolPrefix(server)}__`);
  if (from('relay')) return true;
  if (mcp.deny.some(from)) return false;
  return mcp.allow ? mcp.allow.some(from) : true;
}

export function deniedServers(known: string[], mcp: BotConfig['agent']['mcp']): string[] {
  const deny = new Set(mcp.deny);
  if (mcp.allow) {
    const allow = new Set([...mcp.allow, 'relay']);
    for (const name of known) if (!allow.has(name)) deny.add(name);
  }
  deny.delete('relay');
  return [...deny];
}

export function buildAgentEnv(agent: BotConfig['agent']): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (INHERITED_PREFIXES.some((p) => k.toUpperCase().startsWith(p))) continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(agent.env)) env[k] = resolveSecret(v);
  if (agent.auth === 'apiKey') {
    const key = resolveSecret(agent.apiKey) ?? process.env.ANTHROPIC_API_KEY;
    if (key) env.ANTHROPIC_API_KEY = key;
  } else {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  if (agent.claudeConfigDir) env.CLAUDE_CONFIG_DIR = path.resolve(agent.claudeConfigDir);
  env.CLAUDE_AGENT_SDK_CLIENT_APP = CLIENT_APP;
  return env;
}

/** Where Claude Code keeps the transcript of a session started in `cwd`. */
export function transcriptPath(cwd: string, sessionId: string, configDir?: string): string {
  const base = configDir ? path.resolve(configDir) : path.join(os.homedir(), '.claude');
  return path.join(base, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

export interface ClaudeSessionOptions {
  conv: string;
  cwd: string;
  agent: BotConfig['agent'];
  resumeId?: string;
  model?: string;
  effort?: Effort;
  systemAppend: string;
  mcpServers: Record<string, McpServerConfig>;
  directories: string[];
  knownMcpServers: string[];
  callbacks: SessionCallbacks;
  onMcpServers?: (names: string[]) => void;
  log: Logger;
}

type Block = { kind: 'text'; text: string } | { kind: 'tool'; name: string };

interface ActiveTurn {
  sink: TurnSink;
  startedAt: number;
  blocks: Block[];
  interrupted: boolean;
  costBefore: number;
  done: (o: TurnOutcome) => void;
  timeout?: NodeJS.Timeout;
  background: boolean;
}

const QUIET_SINK: TurnSink = {
  thinking() {},
  text() {},
  toolStart() {},
  toolEnd() {},
  compacted() {},
  status() {},
};

export class ClaudeSession implements AgentSession {
  private q: Query | undefined;
  private input: AsyncQueue<SDKUserMessage> | undefined;
  private starting: Promise<void> | undefined;
  private turn: ActiveTurn | undefined;
  private stderrTail = '';
  private catalog: ModelCatalogRow[] | undefined;
  private sessionId: string | undefined;
  private resumeId: string | undefined;
  private model: string | undefined;
  private effort: Effort | undefined;
  private data: Partial<SessionInfo> = {};
  private totalCost = 0;
  private denied: string[] = [];
  private resumeFailed = false;
  private readonly log: Logger;

  onBackgroundTurn?: AgentSession['onBackgroundTurn'];
  onInfoChanged?: () => void;

  constructor(private opts: ClaudeSessionOptions) {
    this.log = opts.log;
    this.resumeId = opts.resumeId;
    this.sessionId = opts.resumeId;
    this.model = opts.model ?? opts.agent.model;
    this.effort = opts.effort ?? opts.agent.effort;
  }

  get alive(): boolean {
    return Boolean(this.q);
  }

  get busy(): boolean {
    return Boolean(this.turn);
  }

  info(): SessionInfo {
    return {
      runtime: 'claude',
      sessionId: this.sessionId,
      alive: this.alive,
      busy: this.busy,
      effort: this.effort,
      ...this.data,
      model: this.data.model ?? this.model,
      modelLabel: modelLabel(this.data.model ?? this.model, this.catalog),
      totalCostUsd: this.totalCost || undefined,
      transcriptPath: this.sessionId
        ? transcriptPath(this.opts.cwd, this.sessionId, this.opts.agent.claudeConfigDir)
        : undefined,
    };
  }

  // ── lifecycle ─────────────────────────────────────────────

  start(): Promise<void> {
    if (this.q) return Promise.resolve();
    this.starting ??= this.spawn().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private buildOptions(): Options {
    const { agent } = this.opts;
    const known = this.opts.knownMcpServers;
    this.denied = deniedServers(known, agent.mcp);
    const options: Options = {
      cwd: this.opts.cwd,
      env: buildAgentEnv(agent),
      includePartialMessages: true,
      thinking: { type: 'adaptive', display: agent.thinking },
      permissionMode: agent.permissionMode,
      allowDangerouslySkipPermissions: agent.permissionMode === 'bypassPermissions' || undefined,
      settingSources: agent.settingSources,
      additionalDirectories: [...this.opts.directories, ...agent.additionalDirectories.map((d) => path.resolve(d))],
      // canUseTool approves the relay's tools; 'dontAsk' never calls it, so pre-approve them there.
      allowedTools: agent.permissionMode === 'dontAsk' ? ['mcp__relay', ...agent.allowedTools] : agent.allowedTools,
      disallowedTools: [...DEFAULT_DISALLOWED, ...agent.disallowedTools, ...this.denied.map(mcpToolPrefix)],
      mcpServers: this.opts.mcpServers,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.opts.systemAppend, snapshot: false },
      promptSuggestions: false,
      canUseTool: (name, input, o) => this.canUseTool(name, input, o),
      // Hiding servers is best effort (claude.ai connectors can appear after the session starts); this hook
      // refuses their tools whatever the permission rules or timing.
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                const name = 'tool_name' in input ? input.tool_name : '';
                if (mcpToolAllowed(name, agent.mcp)) return {};
                this.log.warn(`blocked ${name}: its MCP server is not allowed for this bot`);
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse' as const,
                    permissionDecision: 'deny' as const,
                    permissionDecisionReason: 'That MCP server is not available to this bot.',
                  },
                };
              },
            ],
          },
        ],
      },
      stderr: (data) => {
        this.stderrTail = (this.stderrTail + data).slice(-4000);
        this.log.debug('cli stderr:', data.trim());
      },
    };
    if (this.model) options.model = this.model;
    if (this.effort) options.effort = this.effort;
    if (agent.fallbackModel) options.fallbackModel = agent.fallbackModel;
    if (agent.executable) options.pathToClaudeCodeExecutable = agent.executable;
    if (this.resumeId) options.resume = this.resumeId;
    return options;
  }

  private async spawn(): Promise<void> {
    const input = new AsyncQueue<SDKUserMessage>();
    const options = this.buildOptions();
    this.log.info(
      `starting claude session (resume=${this.resumeId ?? 'new'}, model=${this.model ?? 'default'}, effort=${this.effort ?? 'default'})`,
    );
    this.stderrTail = '';
    const q = query({ prompt: input, options });
    this.q = q;
    this.input = input;
    this.data.startedAt = Date.now();
    void this.readLoop(q);
    try {
      const statuses = await withTimeout(q.mcpServerStatus(), 30_000, 'MCP status');
      const names = statuses.map((s) => s.name);
      this.data.mcpServers = statuses.map((s) => ({ name: s.name, status: s.status }));
      this.opts.onMcpServers?.(names);
      await this.enforceMcpPolicy(names);
    } catch (err) {
      this.log.warn('could not read MCP server status:', err);
    }
    this.onInfoChanged?.();
  }

  /** Hides servers that are not allowed, when new ones appear after start. */
  private async enforceMcpPolicy(names: string[]): Promise<void> {
    const want = deniedServers(names, this.opts.agent.mcp);
    const missing = want.filter((n) => !this.denied.includes(n));
    if (missing.length === 0 || !this.q) return;
    this.denied = [...new Set([...this.denied, ...want])];
    await this.q.applyFlagSettings({
      permissions: { deny: this.denied.map(mcpToolPrefix) },
    } as never);
    this.log.info('hid MCP servers:', missing.join(', '));
  }

  close(reason: string): void {
    if (!this.q) return;
    this.log.info(`closing claude session (${reason})`);
    const q = this.q;
    this.q = undefined;
    this.input?.close();
    this.input = undefined;
    try {
      q.close();
    } catch { /* already gone */ }
    if (this.turn) this.finish({ status: 'error', error: `session closed: ${reason}` });
    this.onInfoChanged?.();
  }

  // ── turns ─────────────────────────────────────────────────

  async run(input: AgentInput, sink: TurnSink): Promise<TurnOutcome> {
    const outcome = await this.runOnce(input, sink);
    if (outcome.status === 'error' && this.resumeFailed) {
      this.log.warn(`session ${this.resumeId} could not be resumed; starting a new one`);
      this.resumeFailed = false;
      this.resumeId = undefined;
      this.sessionId = undefined;
      const retry = await this.runOnce(input, sink);
      return { ...retry, freshSession: true };
    }
    return outcome;
  }

  command(command: string, sink: TurnSink): Promise<TurnOutcome> {
    return this.runOnce({ text: command }, sink);
  }

  private async runOnce(input: AgentInput, sink: TurnSink): Promise<TurnOutcome> {
    if (this.turn) throw new Error('a turn is already running in this session');
    await this.start();
    if (!this.q || !this.input) {
      return { status: 'error', text: '', fullText: '', error: this.lastError('agent did not start'), durationMs: 0 };
    }
    const d = deferred<TurnOutcome>();
    const turn: ActiveTurn = {
      sink,
      startedAt: Date.now(),
      blocks: [],
      interrupted: false,
      costBefore: this.totalCost,
      done: d.resolve,
      background: false,
    };
    turn.timeout = setTimeout(() => {
      this.log.warn('turn timed out; interrupting');
      void this.interrupt();
    }, this.opts.agent.turnTimeoutMinutes * 60_000);
    this.turn = turn;
    this.onInfoChanged?.();
    this.input.push(toUserMessage(input));
    return d.promise;
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn || !this.q) return;
    turn.interrupted = true;
    try {
      await withTimeout(this.q.interrupt(), 10_000, 'interrupt');
    } catch (err) {
      this.log.warn('interrupt failed, closing the session:', err);
      this.close('interrupt failed');
      return;
    }
    // The CLI answers an interrupt with a result; if it doesn't, stop waiting.
    setTimeout(() => {
      if (this.turn === turn) this.finish({ status: 'interrupted' });
    }, 15_000);
  }

  private finish(partial: Partial<TurnOutcome> & { status: TurnOutcome['status'] }): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    clearTimeout(turn.timeout);
    const texts = turn.blocks;
    let lastTool = -1;
    texts.forEach((b, i) => {
      if (b.kind === 'tool' && !COSMETIC_TOOLS.has(b.name)) lastTool = i;
    });
    const join = (bs: Block[]) =>
      bs
        .filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text')
        .map((b) => b.text.trim())
        .filter(Boolean)
        .join('\n\n');
    let answer = join(texts.slice(lastTool + 1));
    if (!answer) {
      const lastText = [...texts].reverse().find((b) => b.kind === 'text' && b.text.trim());
      answer = lastText?.kind === 'text' ? lastText.text.trim() : '';
    }
    const outcome: TurnOutcome = {
      text: answer,
      fullText: join(texts),
      durationMs: Date.now() - turn.startedAt,
      costUsd: this.totalCost > turn.costBefore ? this.totalCost - turn.costBefore : undefined,
      sessionId: this.sessionId,
      ...partial,
    };
    if (turn.interrupted && outcome.status !== 'ok') outcome.status = 'interrupted';
    this.data.lastTurnAt = Date.now();
    turn.done(outcome);
    this.onInfoChanged?.();
  }

  // ── stream handling ───────────────────────────────────────

  private async readLoop(q: Query): Promise<void> {
    let sawInit = false;
    try {
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') sawInit = true;
        try {
          this.handle(m);
        } catch (err) {
          this.log.error('error handling SDK message', m.type, err);
        }
      }
      this.log.info('claude session ended');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.resumeId && !sawInit && /no conversation found|not found|resume/i.test(this.stderrTail + msg)) {
        this.resumeFailed = true;
      }
      if (this.q !== q) this.log.debug('claude session closed:', msg);
      else this.log.error('claude session crashed:', msg, this.stderrTail ? `\nstderr: ${this.stderrTail.slice(-1500)}` : '');
    } finally {
      if (this.q === q) {
        this.q = undefined;
        this.input?.close();
        this.input = undefined;
      }
      if (this.turn) this.finish({ status: 'error', error: this.lastError('the agent process ended unexpectedly') });
      this.onInfoChanged?.();
    }
  }

  private lastError(fallback: string): string {
    const tail = this.stderrTail.trim().split('\n').slice(-6).join('\n');
    return tail ? `${fallback}\n${tail}` : fallback;
  }

  private ensureTurn(): ActiveTurn | undefined {
    if (this.turn) return this.turn;
    // The agent started a turn on its own (a background task finished, a scheduled wakeup...).
    const handler = this.onBackgroundTurn?.();
    const turn: ActiveTurn = {
      sink: handler?.sink ?? QUIET_SINK,
      startedAt: Date.now(),
      blocks: [],
      interrupted: false,
      costBefore: this.totalCost,
      done: handler?.done ?? (() => {}),
      background: true,
    };
    this.turn = turn;
    this.onInfoChanged?.();
    return turn;
  }

  private handle(m: SDKMessage): void {
    switch (m.type) {
      case 'system': {
        if (m.subtype === 'init') {
          this.setSessionId(m.session_id);
          this.data.model = m.model;
          this.data.permissionMode = m.permissionMode;
          this.data.cliVersion = m.claude_code_version;
          if (m.effort !== undefined && m.effort !== null) this.data.effort = m.effort;
          this.data.mcpServers = m.mcp_servers.map((s) => ({ name: s.name, status: s.status }));
          const names = m.mcp_servers.map((s) => s.name);
          this.opts.onMcpServers?.(names);
          void this.enforceMcpPolicy(names).catch((err) => this.log.warn('MCP policy:', err));
          this.onInfoChanged?.();
        } else if (m.subtype === 'compact_boundary') {
          const meta = m.compact_metadata;
          this.turn?.sink.compacted({ trigger: meta.trigger, preTokens: meta.pre_tokens, postTokens: meta.post_tokens });
        } else if (m.subtype === 'status') {
          if (m.status === 'compacting') this.turn?.sink.status('compacting');
        } else if (m.subtype === 'api_retry') {
          this.turn?.sink.status('retrying', `attempt ${m.attempt}/${m.max_retries}: ${m.error}`);
        }
        return;
      }
      case 'stream_event': {
        if (m.parent_tool_use_id) return;
        const ev = m.event;
        if (ev.type === 'content_block_delta') {
          const turn = this.ensureTurn();
          if (ev.delta.type === 'thinking_delta') turn?.sink.thinking(ev.delta.thinking);
          else if (ev.delta.type === 'text_delta') turn?.sink.text(ev.delta.text);
        }
        return;
      }
      case 'assistant': {
        const turn = this.ensureTurn();
        if (!turn) return;
        const sub = Boolean(m.parent_tool_use_id);
        for (const block of m.message.content) {
          if (block.type === 'text' && !sub) {
            turn.blocks.push({ kind: 'text', text: block.text });
          } else if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
            const b = block as { id: string; name: string; input: unknown; server_name?: string };
            const name = block.type === 'mcp_tool_use' && b.server_name ? `mcp__${b.server_name}__${b.name}` : b.name;
            if (!sub) turn.blocks.push({ kind: 'tool', name });
            turn.sink.toolStart({ id: b.id, name, input: (b.input ?? {}) as Record<string, unknown>, parentId: m.parent_tool_use_id });
          }
        }
        return;
      }
      case 'user': {
        const content = m.message.content;
        if (!Array.isArray(content) || !this.turn) return;
        for (const block of content) {
          if (typeof block === 'object' && block && block.type === 'tool_result') {
            const text =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
                  : '';
            this.turn.sink.toolEnd(block.tool_use_id, !block.is_error, text);
          }
        }
        return;
      }
      case 'result': {
        this.setSessionId(m.session_id);
        this.totalCost = m.total_cost_usd ?? this.totalCost;
        const usage = Object.entries(m.modelUsage ?? {});
        const main = usage.find(([id]) => id === this.data.model) ?? usage[0];
        if (main) this.data.contextWindow = main[1].contextWindow;
        if (!this.turn) return;
        if (m.subtype === 'success' && !m.is_error) {
          this.finish({ status: 'ok' });
        } else {
          const errors = 'errors' in m && Array.isArray(m.errors) ? m.errors.join('; ') : '';
          const result = 'result' in m && typeof m.result === 'string' ? m.result : '';
          this.finish({ status: 'error', error: errors || result || m.subtype });
        }
        void this.refreshContext();
        return;
      }
      case 'rate_limit_event': {
        const info = m.rate_limit_info as typeof m.rate_limit_info & {
          unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
        };
        const rl: RateLimits = { ...(this.data.rateLimits ?? {}), status: info.status };
        const windows = info.unifiedWindows ?? {};
        if (windows.five_hour) {
          rl.fiveHour = windows.five_hour.utilization;
          rl.fiveHourResetsAt = windows.five_hour.resetsAt;
        }
        if (windows.seven_day) {
          rl.sevenDay = windows.seven_day.utilization;
          rl.sevenDayResetsAt = windows.seven_day.resetsAt;
        }
        if (!info.unifiedWindows && info.utilization !== undefined) {
          if (info.rateLimitType === 'five_hour') rl.fiveHour = info.utilization;
          if (info.rateLimitType === 'seven_day') rl.sevenDay = info.utilization;
        }
        this.data.rateLimits = rl;
        this.onInfoChanged?.();
        return;
      }
      case 'prompt_suggestion': {
        this.opts.callbacks.onSuggestion?.(m.suggestion);
        return;
      }
      case 'conversation_reset': {
        this.setSessionId(m.new_conversation_id);
        return;
      }
      default:
        return;
    }
  }

  private setSessionId(id: string | undefined): void {
    if (!id || id === this.sessionId) return;
    this.sessionId = id;
    this.resumeId = id;
    this.opts.callbacks.onSessionId(id);
  }

  // ── permissions & questions ───────────────────────────────

  private async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    o: Parameters<NonNullable<Options['canUseTool']>>[2],
  ): Promise<PermissionResult> {
    // The relay's own tools (in-process, registered by this host) never need a prompt.
    if (toolName.startsWith('mcp__relay__') && (!o.mcpServer || o.mcpServer.source === 'sdk')) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (toolName === 'AskUserQuestion') {
      const questions = Array.isArray(input.questions) ? (input.questions as never[]) : [];
      const answer = await this.opts.callbacks.onQuestion({ toolUseId: o.toolUseID, questions });
      if (!answer) {
        return {
          behavior: 'deny',
          message: 'Nobody answered the question in time. Continue with your best judgment and say what you assumed, or ask again in your reply.',
        };
      }
      return { behavior: 'allow', updatedInput: { ...input, answers: answer.answers, ...(answer.response ? { response: answer.response } : {}) } };
    }
    const decision = await this.opts.callbacks.onPermission({
      toolName,
      input,
      toolUseId: o.toolUseID,
      title: o.title,
      description: o.description,
      displayName: o.displayName,
      reason: o.decisionReason,
      blockedPath: o.blockedPath,
      canAlwaysAllow: !o.suppressAlwaysAllowRule && Boolean(o.suggestions?.length),
    });
    if (decision.allow) {
      return {
        behavior: 'allow',
        updatedInput: input,
        updatedPermissions: decision.always ? o.suggestions : undefined,
      };
    }
    return { behavior: 'deny', message: decision.message };
  }

  // ── controls ──────────────────────────────────────────────

  async setModel(model: string | undefined): Promise<void> {
    this.model = model;
    if (this.q) await this.q.setModel(model);
    this.data.model = undefined;
    this.data.contextWindow = undefined;
    this.onInfoChanged?.();
  }

  async setEffort(effort: Effort | undefined): Promise<void> {
    this.effort = effort;
    this.data.effort = effort;
    if (this.q) await this.q.applyFlagSettings({ effortLevel: effort ?? null });
    this.onInfoChanged?.();
  }

  async refreshContext(): Promise<void> {
    if (!this.q) return;
    try {
      const cu = await withTimeout(this.q.getContextUsage({ detail: 'summary' }), 15_000, 'context usage');
      this.data.ctxTokens = cu.totalTokens;
      this.data.ctxMax = cu.rawMaxTokens || cu.maxTokens;
      this.data.ctxPercent = cu.percentage;
      if (cu.model) this.data.model = cu.model;
      this.onInfoChanged?.();
    } catch (err) {
      this.log.debug('context usage unavailable:', err);
    }
  }

  async contextBreakdown(): Promise<ContextCategory[] | null> {
    if (!this.q) return null;
    try {
      const cu = await withTimeout(this.q.getContextUsage({ detail: 'summary' }), 20_000, 'context usage');
      return cu.categories.filter((c) => c.tokens > 0).map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind }));
    } catch {
      return null;
    }
  }

  async models(): Promise<ModelOption[]> {
    await this.start();
    if (!this.q) return [];
    if (!this.catalog) {
      const rows = await withTimeout(this.q.supportedModels(), 20_000, 'models');
      this.catalog = rows.map((r) => ({ value: r.value, displayName: r.displayName, resolvedModel: r.resolvedModel }));
      this.cachedModels = rows.map((r) => ({
        value: r.value,
        label: r.displayName,
        description: r.description,
        efforts: r.supportedEffortLevels,
      }));
      this.onInfoChanged?.();
    }
    return this.cachedModels;
  }

  private cachedModels: ModelOption[] = [];
}

function toUserMessage(input: AgentInput): SDKUserMessage {
  const images = input.images ?? [];
  const content =
    images.length === 0
      ? input.text
      : [
          ...images.map((img) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: img.mediaType as 'image/png', data: img.base64 },
          })),
          { type: 'text' as const, text: input.text },
        ];
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    origin: { kind: 'human' },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Removes a stale transcript reference when its file is gone (so we don't try to resume it). */
export function transcriptExists(cwd: string, sessionId: string, configDir?: string): boolean {
  return fs.existsSync(transcriptPath(cwd, sessionId, configDir));
}
