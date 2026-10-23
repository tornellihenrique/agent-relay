import crypto from 'node:crypto';
import type { PermissionDecision, PermissionRequest, QuestionAnswer, QuestionRequest } from '../agent/types.js';
import { deferred } from '../core/async.js';
import type { Logger } from '../core/log.js';
import { oneLine, truncate } from '../core/text.js';
import type { ButtonSpec, Interaction, Platform, SelectSpec } from '../platform/types.js';
import { serverLabel } from './tool-labels.js';

/**
 * Blocking prompts the agent raises mid-turn: tool permission requests (owners answer) and
 * AskUserQuestion (the person who asked, or an owner, answers). Rendered as buttons; the turn
 * waits until someone clicks or the prompt times out.
 */

interface PendingPermission {
  kind: 'permission';
  channelId: string;
  messageId?: string;
  req: PermissionRequest;
  approvers: Set<string>;
  done: (d: PermissionDecision) => void;
  timer: NodeJS.Timeout;
}

interface PendingQuestion {
  kind: 'question';
  channelId: string;
  messageId?: string;
  req: QuestionRequest;
  answerers: Set<string> | null;
  answers: Record<string, string>;
  answeredBy: string[];
  done: (a: QuestionAnswer) => void;
  timer: NodeJS.Timeout;
}

type Pending = PendingPermission | PendingQuestion;

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** "Google Drive · search files" plus the few arguments that say what it will touch. */
function describeMcp(req: PermissionRequest): string | undefined {
  const m = req.toolName.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return undefined;
  const args = Object.entries(req.input)
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && typeof v !== 'boolean')
    .slice(0, 3)
    .map(([k, v]) => {
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}: \`${truncate(text, 80).replace(/`/g, "'")}\``;
    });
  return `**${serverLabel(m[1])}** · ${m[2].replace(/_/g, ' ')}${args.length ? `\n> ${args.join(' · ')}` : ''}`;
}

function describeTool(req: PermissionRequest): string {
  const mcp = describeMcp(req);
  if (mcp) return mcp;
  if (req.title) return req.title;
  const input = req.input;
  const detail =
    (typeof input.command === 'string' && input.command) ||
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.url === 'string' && input.url) ||
    (typeof input.pattern === 'string' && input.pattern) ||
    oneLine(JSON.stringify(input), 300);
  return `${req.displayName ?? req.toolName}: \`${truncate(String(detail), 300).replace(/`/g, "'")}\``;
}

export class Prompts {
  private pending = new Map<string, Pending>();

  constructor(
    private platform: Platform,
    private log: Logger,
    private opts: { permissionTimeoutMs: number; questionTimeoutMs: number },
  ) {}

  get waiting(): number {
    return this.pending.size;
  }

  async permission(channelId: string, replyTo: string | undefined, req: PermissionRequest, approvers: Set<string>): Promise<PermissionDecision> {
    if (approvers.size === 0) {
      return { allow: false, message: `${req.toolName} needs approval, but this bot has no owners to approve it. Ask an owner to allow the tool in the bot config or the folder settings.` };
    }
    const id = crypto.randomBytes(5).toString('hex');
    const d = deferred<PermissionDecision>();
    const entry: PendingPermission = {
      kind: 'permission',
      channelId,
      req,
      approvers,
      done: d.resolve,
      timer: setTimeout(() => this.settlePermission(id, { allow: false, message: 'Nobody approved this in time.' }, '⌛ Timed out'), this.opts.permissionTimeoutMs),
    };
    this.pending.set(id, entry);
    const who = [...approvers].map((u) => `<@${u}>`).join(' ');
    const lines = [
      `🔐 **Permission needed** — ${describeTool(req)}`,
      req.description ? `-# ${oneLine(req.description, 300)}` : '',
      req.reason ? `-# why: ${oneLine(req.reason, 300)}` : '',
      `-# Approve: ${who}`,
    ].filter(Boolean);
    const buttons: ButtonSpec[] = [
      { id: `p:${id}:allow`, label: 'Allow once', emoji: '✅', style: 'success' },
      ...(req.canAlwaysAllow ? [{ id: `p:${id}:always`, label: 'Allow for this session', emoji: '♾️', style: 'primary' as const }] : []),
      { id: `p:${id}:deny`, label: 'Deny', emoji: '✖️', style: 'danger' },
    ];
    try {
      const [mid] = await this.platform.send(channelId, { text: lines.join('\n'), replyTo, buttons: [buttons] });
      entry.messageId = mid;
    } catch (err) {
      this.log.error('could not post a permission prompt:', err);
      this.settlePermission(id, { allow: false, message: 'Could not ask for permission in Discord.' });
    }
    return d.promise;
  }

  private settlePermission(id: string, decision: PermissionDecision, note?: string): void {
    const p = this.pending.get(id);
    if (!p || p.kind !== 'permission') return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.done(decision);
    if (p.messageId && note) {
      void this.platform.edit(p.channelId, p.messageId, { text: `🔐 ${describeTool(p.req)}\n-# ${note}` }).catch(() => {});
    }
  }

  async question(channelId: string, replyTo: string | undefined, req: QuestionRequest, answerers: Set<string> | null): Promise<QuestionAnswer> {
    const id = crypto.randomBytes(5).toString('hex');
    const d = deferred<QuestionAnswer>();
    const entry: PendingQuestion = {
      kind: 'question',
      channelId,
      req,
      answerers,
      answers: {},
      answeredBy: [],
      done: d.resolve,
      timer: setTimeout(() => this.settleQuestion(id, true), this.opts.questionTimeoutMs),
    };
    this.pending.set(id, entry);
    try {
      const [mid] = await this.platform.send(channelId, { ...this.renderQuestion(id, entry), replyTo });
      entry.messageId = mid;
    } catch (err) {
      this.log.error('could not post a question:', err);
      this.settleQuestion(id, true);
    }
    return d.promise;
  }

  private renderQuestion(id: string, q: PendingQuestion): { text: string; buttons: ButtonSpec[][]; selects: SelectSpec[] } {
    const lines: string[] = ['🙋 **A question before I go on**'];
    const buttons: ButtonSpec[][] = [];
    const selects: SelectSpec[] = [];
    const many = q.req.questions.length > 1;
    q.req.questions.forEach((question, qi) => {
      const answered = q.answers[question.question];
      lines.push(`${many ? `**${qi + 1} · ${question.header}** — ` : ''}${question.question}${answered ? ` → **${answered}**` : ''}`);
      if (!answered) {
        question.options.forEach((o, oi) => lines.push(`> **${LETTERS[oi]}.** ${o.label}${o.description ? ` — ${oneLine(o.description, 160)}` : ''}`));
      }
      if (answered) return;
      if (question.multiSelect) {
        selects.push({
          id: `qs:${id}:${qi}`,
          placeholder: truncate(`${many ? `${qi + 1}. ` : ''}Pick one or more`, 100),
          min: 1,
          max: question.options.length,
          options: question.options.map((o, oi) => ({ label: `${LETTERS[oi]}. ${o.label}`, value: String(oi), description: o.description ? oneLine(o.description, 100) : undefined })),
        });
      } else {
        buttons.push([
          ...question.options.map((o, oi) => ({ id: `q:${id}:${qi}:${oi}`, label: `${many ? `${qi + 1}${LETTERS[oi]}` : LETTERS[oi]} · ${o.label}`, style: 'primary' as const })),
          { id: `q:${id}:${qi}:other`, label: 'Other…', emoji: '✏️', style: 'secondary' },
        ]);
      }
    });
    if (q.answerers?.size) lines.push(`-# For ${[...q.answerers].map((u) => `<@${u}>`).join(' ')}`);
    return { text: lines.join('\n'), buttons, selects };
  }

  private settleQuestion(id: string, timedOut: boolean): void {
    const q = this.pending.get(id);
    if (!q || q.kind !== 'question') return;
    this.pending.delete(id);
    clearTimeout(q.timer);
    const complete = q.req.questions.every((x) => q.answers[x.question]);
    q.done(complete ? { answers: q.answers } : timedOut && Object.keys(q.answers).length === 0 ? null : { answers: q.answers });
    if (q.messageId) {
      const summary = q.req.questions.map((x, i) => `${q.req.questions.length > 1 ? `${i + 1}. ` : ''}${x.question} → **${q.answers[x.question] ?? '—'}**`).join('\n');
      const by = q.answeredBy.length ? `answered by ${[...new Set(q.answeredBy)].join(', ')}` : '⌛ no answer, continued without it';
      void this.platform.edit(q.channelId, q.messageId, { text: `🙋 ${summary}\n-# ${by}` }).catch(() => {});
    }
  }

  /** Cancels everything (bot stopping, turn interrupted). */
  cancelAll(reason: string): void {
    for (const [id, p] of this.pending) {
      if (p.kind === 'permission') this.settlePermission(id, { allow: false, message: reason }, reason);
      else this.settleQuestion(id, true);
    }
  }

  /** Handles prompt buttons, selects and modals. Returns false if the interaction isn't ours. */
  async handle(i: Interaction): Promise<boolean> {
    const parts = i.key.split(':');
    const [tag, id] = parts;
    if (!['p', 'q', 'qs', 'qm'].includes(tag)) return false;
    const entry = this.pending.get(id);
    if (!entry) {
      await i.reply({ text: 'This prompt has expired.', private: true }).catch(() => {});
      return true;
    }
    if (entry.kind === 'permission' && tag === 'p') {
      if (!entry.approvers.has(i.user.id)) {
        await i.reply({ text: 'Only the bot owners can approve this.', private: true });
        return true;
      }
      const action = parts[2];
      await i.ack();
      if (action === 'deny') {
        this.settlePermission(id, { allow: false, message: `Denied by ${i.user.name}.` }, `✖️ Denied by ${i.user.name}`);
      } else {
        const always = action === 'always';
        this.settlePermission(id, { allow: true, always }, `✅ Allowed${always ? ' for this session' : ''} by ${i.user.name}`);
      }
      return true;
    }
    if (entry.kind !== 'question') return true;
    if (entry.answerers && entry.answerers.size && !entry.answerers.has(i.user.id)) {
      await i.reply({ text: 'This question is for someone else.', private: true });
      return true;
    }
    const qi = Number(parts[2]);
    const question = entry.req.questions[qi];
    if (!question) return true;
    if (tag === 'q' && parts[3] === 'other') {
      await i.showModal({ id: `qm:${id}:${qi}`, title: truncate(question.header || 'Your answer', 45), fields: [{ id: 'answer', label: truncate(question.question, 45), long: true }] });
      return true;
    }
    let answer = '';
    if (tag === 'q') answer = question.options[Number(parts[3])]?.label ?? '';
    else if (tag === 'qs') answer = (i.values ?? []).map((v) => question.options[Number(v)]?.label).filter(Boolean).join(', ');
    else if (tag === 'qm') answer = i.fields?.answer?.trim() ?? '';
    if (!answer) {
      await i.ack();
      return true;
    }
    entry.answers[question.question] = answer;
    entry.answeredBy.push(i.user.name);
    const complete = entry.req.questions.every((x) => entry.answers[x.question]);
    if (complete) {
      await i.ack();
      this.settleQuestion(id, false);
    } else {
      await i.update(this.renderQuestion(id, entry)).catch(async () => {
        await i.ack().catch(() => {});
        if (entry.messageId) await this.platform.edit(entry.channelId, entry.messageId, this.renderQuestion(id, entry)).catch(() => {});
      });
    }
    return true;
  }
}
