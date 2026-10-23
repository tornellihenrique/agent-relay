import crypto from 'node:crypto';
import { Cron } from 'croner';
import type { Archive, ScheduleRow } from '../core/archive.js';
import type { BotConfig } from '../core/config.js';
import type { Logger } from '../core/log.js';

/**
 * Timers that start agent turns: cron expressions ("0 18 * * 1-5") or one-off ISO times.
 * Config schedules are synced into the archive at start; the agent and owners add more at runtime.
 */
export class Scheduler {
  private jobs = new Map<string, Cron>();

  constructor(
    private archive: Archive,
    private cfg: BotConfig,
    private fire: (row: ScheduleRow) => void,
    private log: Logger,
  ) {}

  start(): void {
    const fromConfig = new Set(this.cfg.schedules.map((s) => s.id));
    for (const row of this.archive.listSchedules()) {
      if (row.source === 'config' && !fromConfig.has(row.id)) this.archive.deleteSchedule(row.id);
    }
    for (const s of this.cfg.schedules) {
      const existing = this.archive.listSchedules().find((r) => r.id === s.id);
      this.archive.saveSchedule({
        id: s.id,
        name: s.id,
        when: s.when,
        timezone: s.timezone,
        channelId: s.channel,
        prompt: s.prompt,
        enabled: s.enabled,
        createdAt: existing?.createdAt ?? Date.now(),
        lastRunAt: existing?.lastRunAt,
        source: 'config',
      });
    }
    for (const row of this.archive.listSchedules()) if (row.enabled) this.arm(row);
    this.log.info(`scheduler: ${this.jobs.size} active schedule(s)`);
  }

  stop(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  /** Throws if the expression is invalid; returns the next run. */
  validate(when: string, timezone?: string): Date | null {
    const probe = new Cron(isoOrCron(when), { timezone: timezone ?? this.cfg.timezone, paused: true });
    const next = probe.nextRun();
    probe.stop();
    return next;
  }

  private arm(row: ScheduleRow): void {
    this.jobs.get(row.id)?.stop();
    try {
      const job = new Cron(
        isoOrCron(row.when),
        { timezone: row.timezone ?? this.cfg.timezone, name: row.id, protect: true, catch: (err) => this.log.error(`schedule ${row.id}:`, err) },
        () => {
          const now = Date.now();
          this.archive.markScheduleRun(row.id, now);
          if (isIso(row.when)) {
            this.archive.saveSchedule({ ...row, enabled: false, lastRunAt: now });
            this.jobs.delete(row.id);
          }
          this.log.info(`schedule fired: ${row.id}`);
          this.fire({ ...row, lastRunAt: now });
        },
      );
      if (!job.nextRun()) {
        job.stop();
        return;
      }
      this.jobs.set(row.id, job);
    } catch (err) {
      this.log.error(`invalid schedule ${row.id} (${row.when}):`, err);
    }
  }

  create(input: { name: string; when: string; prompt: string; channelId: string; timezone?: string; createdBy?: string; source: ScheduleRow['source'] }): {
    row: ScheduleRow;
    next: Date | null;
  } {
    const when = resolveRelative(input.when) ?? input.when;
    const next = this.validate(when, input.timezone);
    if (!next) throw new Error(`"${input.when}" never runs (a past date? it is ${new Date().toISOString()} now)`);
    input = { ...input, when };
    const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'task';
    const row: ScheduleRow = {
      id: `${slug}-${crypto.randomBytes(2).toString('hex')}`,
      name: input.name,
      when: input.when,
      timezone: input.timezone,
      channelId: input.channelId,
      prompt: input.prompt,
      enabled: true,
      createdBy: input.createdBy,
      createdAt: Date.now(),
      source: input.source,
    };
    this.archive.saveSchedule(row);
    this.arm(row);
    return { row, next };
  }

  remove(id: string): boolean {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    return this.archive.deleteSchedule(id);
  }

  list(): (ScheduleRow & { next: Date | null })[] {
    return this.archive.listSchedules().map((r) => ({ ...r, next: this.jobs.get(r.id)?.nextRun() ?? null }));
  }
}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** "in 10m", "+2h", "30 min", "1 day" → an absolute ISO time (one-off). */
export function resolveRelative(when: string, now = Date.now()): string | undefined {
  const m = when.trim().match(/^(?:in\s+|\+)?(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)$/i);
  if (!m) return undefined;
  const unit = m[2].toLowerCase()[0];
  return new Date(now + Number(m[1]) * UNITS[unit]).toISOString();
}

function isIso(when: string): boolean {
  return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/.test(when.trim());
}

function isoOrCron(when: string): string {
  const w = when.trim();
  return isIso(w) ? w.replace(' ', 'T') : w;
}
