import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import path from 'node:path';
import { ensureDir } from './paths.js';

/**
 * The bot's long-term record: every message it sees (or everything in its channels, per config),
 * every turn it ran, its sessions, schedules and notable events. Survives compactions and resets,
 * and is what the agent searches with history_search / history_read.
 */

export type ArchiveKind = 'message' | 'reaction' | 'choice' | 'schedule' | 'system';

export interface ArchivedMessage {
  platform: string;
  channelId: string;
  channelName?: string;
  messageId: string;
  authorId?: string;
  authorName?: string;
  isSelf?: boolean;
  kind: ArchiveKind;
  text: string;
  replyTo?: string;
  ts: number;
  turnId?: string;
  meta?: Record<string, unknown>;
}

export interface ArchiveRow extends ArchivedMessage {
  rowid: number;
  snippet?: string;
}

export interface TurnRecord {
  id: string;
  conv: string;
  channelId: string;
  sessionId?: string;
  startedAt: number;
  endedAt?: number;
  status: string;
  model?: string;
  effort?: string;
  triggerIds?: string[];
  replyIds?: string[];
  tools?: { name: string; ok: boolean; summary?: string }[];
  costUsd?: number;
  ctxPercent?: number;
  ctxTokens?: number;
  durationMs?: number;
  error?: string;
  input?: string;
}

export interface ScheduleRow {
  id: string;
  name: string;
  when: string;
  timezone?: string;
  channelId: string;
  prompt: string;
  enabled: boolean;
  createdBy?: string;
  createdAt: number;
  lastRunAt?: number;
  source: 'config' | 'agent' | 'command';
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  rowid INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  message_id TEXT NOT NULL,
  author_id TEXT,
  author_name TEXT,
  is_self INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  reply_to TEXT,
  ts INTEGER NOT NULL,
  turn_id TEXT,
  meta TEXT,
  UNIQUE(platform, message_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages(channel_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, author_name, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, author_name) VALUES (new.rowid, new.text, new.author_name);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, author_name) VALUES ('delete', old.rowid, old.text, old.author_name);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, author_name) VALUES ('delete', old.rowid, old.text, old.author_name);
  INSERT INTO messages_fts(rowid, text, author_name) VALUES (new.rowid, new.text, new.author_name);
END;
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  conv TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  session_id TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  trigger_ids TEXT,
  reply_ids TEXT,
  tools TEXT,
  cost_usd REAL,
  ctx_percent REAL,
  ctx_tokens INTEGER,
  duration_ms INTEGER,
  error TEXT,
  input TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_conv ON turns(conv, started_at);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  conv TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  compactions INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  transcript TEXT
);
CREATE TABLE IF NOT EXISTS events (
  rowid INTEGER PRIMARY KEY,
  conv TEXT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT
);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  when_expr TEXT NOT NULL,
  timezone TEXT,
  channel_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  last_run_at INTEGER,
  source TEXT NOT NULL
);
`;

type Row = Record<string, SQLInputValue>;

function toMessage(r: Row): ArchiveRow {
  return {
    rowid: Number(r.rowid),
    platform: String(r.platform),
    channelId: String(r.channel_id),
    channelName: (r.channel_name as string) ?? undefined,
    messageId: String(r.message_id),
    authorId: (r.author_id as string) ?? undefined,
    authorName: (r.author_name as string) ?? undefined,
    isSelf: Number(r.is_self) === 1,
    kind: String(r.kind) as ArchiveKind,
    text: String(r.text),
    replyTo: (r.reply_to as string) ?? undefined,
    ts: Number(r.ts),
    turnId: (r.turn_id as string) ?? undefined,
    meta: r.meta ? JSON.parse(String(r.meta)) : undefined,
    snippet: (r.snippet as string) ?? undefined,
  };
}

/**
 * Turns free text into an FTS5 query: every word must match (prefix match on the last one),
 * quoted so punctuation can't break the syntax. Explicit OR between words is kept.
 */
export function toFtsQuery(input: string): string {
  const words = input
    .replace(/["']/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter(Boolean);
  if (words.length === 0) return '';
  const parts: string[] = [];
  words.forEach((w, i) => {
    if (w.toUpperCase() === 'OR' && parts.length > 0 && i < words.length - 1) {
      parts.push('OR');
      return;
    }
    const last = i === words.length - 1;
    parts.push(`"${w}"${last && w.length >= 3 ? '*' : ''}`);
  });
  return parts.join(' ');
}

export class Archive {
  private db: DatabaseSync;

  constructor(file: string) {
    ensureDir(path.dirname(file));
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    try {
      this.db.close();
    } catch { /* already closed */ }
  }

  // ── messages ──────────────────────────────────────────────

  /** Inserts or updates (on edit) a message. */
  upsertMessage(m: ArchivedMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (platform, channel_id, channel_name, message_id, author_id, author_name, is_self, kind, text, reply_to, ts, turn_id, meta)
         VALUES ($platform, $channel_id, $channel_name, $message_id, $author_id, $author_name, $is_self, $kind, $text, $reply_to, $ts, $turn_id, $meta)
         ON CONFLICT(platform, message_id, kind) DO UPDATE SET
           text = excluded.text,
           channel_name = COALESCE(excluded.channel_name, channel_name),
           turn_id = COALESCE(excluded.turn_id, turn_id),
           meta = COALESCE(excluded.meta, meta)`,
      )
      .run({
        $platform: m.platform,
        $channel_id: m.channelId,
        $channel_name: m.channelName ?? null,
        $message_id: m.messageId,
        $author_id: m.authorId ?? null,
        $author_name: m.authorName ?? null,
        $is_self: m.isSelf ? 1 : 0,
        $kind: m.kind,
        $text: m.text,
        $reply_to: m.replyTo ?? null,
        $ts: m.ts,
        $turn_id: m.turnId ?? null,
        $meta: m.meta ? JSON.stringify(m.meta) : null,
      });
  }

  markDeleted(platform: string, messageId: string): void {
    this.db
      .prepare(`UPDATE messages SET meta = json_set(COALESCE(meta, '{}'), '$.deleted', 1) WHERE platform = ? AND message_id = ?`)
      .run(platform, messageId);
  }

  getMessage(platform: string, messageId: string): ArchiveRow | undefined {
    const r = this.db
      .prepare(`SELECT * FROM messages WHERE platform = ? AND message_id = ? ORDER BY kind = 'message' DESC LIMIT 1`)
      .get(platform, messageId) as Row | undefined;
    return r ? toMessage(r) : undefined;
  }

  search(opts: {
    query: string;
    channelId?: string;
    author?: string;
    since?: number;
    until?: number;
    limit?: number;
  }): ArchiveRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const where: string[] = [];
    const params: Row = { $limit: limit };
    if (opts.channelId) {
      where.push('m.channel_id = $channel');
      params.$channel = opts.channelId;
    }
    if (opts.author) {
      where.push('(m.author_id = $author OR m.author_name LIKE $authorLike)');
      params.$author = opts.author;
      params.$authorLike = `%${opts.author}%`;
    }
    if (opts.since) {
      where.push('m.ts >= $since');
      params.$since = opts.since;
    }
    if (opts.until) {
      where.push('m.ts <= $until');
      params.$until = opts.until;
    }
    const fts = toFtsQuery(opts.query);
    const filter = where.length ? `AND ${where.join(' AND ')}` : '';
    if (fts) {
      try {
        params.$q = fts;
        const rows = this.db
          .prepare(
            `SELECT m.*, snippet(messages_fts, 0, '«', '»', '…', 24) AS snippet
             FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
             WHERE messages_fts MATCH $q ${filter}
             ORDER BY bm25(messages_fts) + (strftime('%s','now') * 1000 - m.ts) / 8.64e10 LIMIT $limit`,
          )
          .all(params) as Row[];
        return rows.map(toMessage);
      } catch {
        delete params.$q;
      }
    }
    params.$like = `%${opts.query}%`;
    const rows = this.db
      .prepare(`SELECT m.* FROM messages m WHERE m.text LIKE $like ${filter} ORDER BY m.ts DESC LIMIT $limit`)
      .all(params) as Row[];
    return rows.map(toMessage);
  }

  /** Messages in chronological order: around a message, or in a time window, or the latest ones. */
  read(opts: {
    channelId?: string;
    aroundMessageId?: string;
    since?: number;
    until?: number;
    limit?: number;
    platform?: string;
  }): ArchiveRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
    const where: string[] = [];
    const params: Row = {};
    if (opts.channelId) {
      where.push('channel_id = $channel');
      params.$channel = opts.channelId;
    }
    if (opts.aroundMessageId) {
      const anchor = this.getMessage(opts.platform ?? 'discord', opts.aroundMessageId);
      if (!anchor) return [];
      const half = Math.floor(limit / 2);
      const cond = where.length ? `AND ${where.join(' AND ')}` : '';
      const before = this.db
        .prepare(`SELECT * FROM messages WHERE ts <= $ts ${cond} ORDER BY ts DESC LIMIT $n`)
        .all({ ...params, $ts: anchor.ts, $n: half + 1 }) as Row[];
      const after = this.db
        .prepare(`SELECT * FROM messages WHERE ts > $ts ${cond} ORDER BY ts ASC LIMIT $n`)
        .all({ ...params, $ts: anchor.ts, $n: limit - half }) as Row[];
      return [...before.reverse(), ...after].map(toMessage);
    }
    if (opts.since) {
      where.push('ts >= $since');
      params.$since = opts.since;
    }
    if (opts.until) {
      where.push('ts <= $until');
      params.$until = opts.until;
    }
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const ascending = Boolean(opts.since) && !opts.until;
    const rows = this.db
      .prepare(`SELECT * FROM messages ${cond} ORDER BY ts ${ascending ? 'ASC' : 'DESC'} LIMIT $limit`)
      .all({ ...params, $limit: limit }) as Row[];
    const out = rows.map(toMessage);
    return ascending ? out : out.reverse();
  }

  messageCount(channelId?: string): number {
    const r = channelId
      ? (this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?').get(channelId) as Row)
      : (this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as Row);
    return Number(r.n);
  }

  // ── turns ─────────────────────────────────────────────────

  saveTurn(t: TurnRecord): void {
    this.db
      .prepare(
        `INSERT INTO turns (id, conv, channel_id, session_id, started_at, ended_at, status, model, effort, trigger_ids, reply_ids, tools, cost_usd, ctx_percent, ctx_tokens, duration_ms, error, input)
         VALUES ($id, $conv, $channel, $session, $started, $ended, $status, $model, $effort, $triggers, $replies, $tools, $cost, $ctxp, $ctxt, $dur, $error, $input)
         ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, ended_at = excluded.ended_at, status = excluded.status,
           model = excluded.model, effort = excluded.effort, reply_ids = excluded.reply_ids, tools = excluded.tools,
           cost_usd = excluded.cost_usd, ctx_percent = excluded.ctx_percent, ctx_tokens = excluded.ctx_tokens,
           duration_ms = excluded.duration_ms, error = excluded.error`,
      )
      .run({
        $id: t.id,
        $conv: t.conv,
        $channel: t.channelId,
        $session: t.sessionId ?? null,
        $started: t.startedAt,
        $ended: t.endedAt ?? null,
        $status: t.status,
        $model: t.model ?? null,
        $effort: t.effort ?? null,
        $triggers: t.triggerIds ? JSON.stringify(t.triggerIds) : null,
        $replies: t.replyIds ? JSON.stringify(t.replyIds) : null,
        $tools: t.tools ? JSON.stringify(t.tools) : null,
        $cost: t.costUsd ?? null,
        $ctxp: t.ctxPercent ?? null,
        $ctxt: t.ctxTokens ?? null,
        $dur: t.durationMs ?? null,
        $error: t.error ?? null,
        $input: t.input ?? null,
      });
  }

  turnStats(conv?: string): { turns: number; costUsd: number; lastAt?: number } {
    const r = (conv
      ? this.db.prepare('SELECT COUNT(*) AS n, SUM(cost_usd) AS c, MAX(started_at) AS l FROM turns WHERE conv = ?').get(conv)
      : this.db.prepare('SELECT COUNT(*) AS n, SUM(cost_usd) AS c, MAX(started_at) AS l FROM turns').get()) as Row;
    return { turns: Number(r.n), costUsd: Number(r.c ?? 0), lastAt: r.l ? Number(r.l) : undefined };
  }

  // ── sessions & events ─────────────────────────────────────

  touchSession(id: string, conv: string, model?: string, transcript?: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, conv, started_at, last_used_at, model, transcript) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_used_at = excluded.last_used_at, model = COALESCE(excluded.model, model),
           transcript = COALESCE(excluded.transcript, transcript)`,
      )
      .run(id, conv, now, now, model ?? null, transcript ?? null);
  }

  endSession(id: string, reason: string): void {
    this.db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL').run(Date.now(), reason, id);
  }

  countCompaction(id: string): void {
    this.db.prepare('UPDATE sessions SET compactions = compactions + 1 WHERE id = ?').run(id);
  }

  sessionInfo(id: string): { compactions: number; startedAt: number; transcript?: string } | undefined {
    const r = this.db.prepare('SELECT compactions, started_at, transcript FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return r
      ? { compactions: Number(r.compactions), startedAt: Number(r.started_at), transcript: (r.transcript as string) ?? undefined }
      : undefined;
  }

  addEvent(conv: string | undefined, type: string, data?: unknown): void {
    this.db
      .prepare('INSERT INTO events (conv, ts, type, data) VALUES (?, ?, ?, ?)')
      .run(conv ?? null, Date.now(), type, data === undefined ? null : JSON.stringify(data));
  }

  // ── schedules ─────────────────────────────────────────────

  listSchedules(): ScheduleRow[] {
    const rows = this.db.prepare('SELECT * FROM schedules ORDER BY created_at').all() as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      when: String(r.when_expr),
      timezone: (r.timezone as string) ?? undefined,
      channelId: String(r.channel_id),
      prompt: String(r.prompt),
      enabled: Number(r.enabled) === 1,
      createdBy: (r.created_by as string) ?? undefined,
      createdAt: Number(r.created_at),
      lastRunAt: r.last_run_at ? Number(r.last_run_at) : undefined,
      source: String(r.source) as ScheduleRow['source'],
    }));
  }

  saveSchedule(s: ScheduleRow): void {
    this.db
      .prepare(
        `INSERT INTO schedules (id, name, when_expr, timezone, channel_id, prompt, enabled, created_by, created_at, last_run_at, source)
         VALUES ($id, $name, $when, $tz, $channel, $prompt, $enabled, $by, $at, $last, $source)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, when_expr = excluded.when_expr, timezone = excluded.timezone,
           channel_id = excluded.channel_id, prompt = excluded.prompt, enabled = excluded.enabled, source = excluded.source`,
      )
      .run({
        $id: s.id,
        $name: s.name,
        $when: s.when,
        $tz: s.timezone ?? null,
        $channel: s.channelId,
        $prompt: s.prompt,
        $enabled: s.enabled ? 1 : 0,
        $by: s.createdBy ?? null,
        $at: s.createdAt,
        $last: s.lastRunAt ?? null,
        $source: s.source,
      });
  }

  markScheduleRun(id: string, at: number): void {
    this.db.prepare('UPDATE schedules SET last_run_at = ? WHERE id = ?').run(at, id);
  }

  deleteSchedule(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes) > 0;
  }
}
