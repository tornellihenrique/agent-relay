/** Text helpers shared by the bot and the platforms. */

export function truncate(text: string, max: number, ellipsis = '…'): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - ellipsis.length)).trimEnd() + ellipsis;
}

/** Keeps the end of a text (for live "latest reasoning" views). */
export function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const nl = cut.indexOf('\n');
  return '…' + (nl >= 0 && nl < 200 ? cut.slice(nl + 1) : cut);
}

export function oneLine(text: string, max = 200): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

/** Escapes characters that would break an XML-ish attribute value. */
export function attr(value: string | number | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/\n/g, ' ');
}

/** Neutralizes envelope tags inside user text so a message can't fake a relay event. */
export function fence(text: string): string {
  return text.replace(/<(\/?)(message|reaction|choice|scheduled_task|relay|channel_context|reply_to|notebook|attachments)\b/gi, '‹$1$2');
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

/** "2026-10-22 20:13" in the given timezone. */
export function formatTime(ts: number, timeZone: string, withSeconds = false): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: withSeconds ? '2-digit' : undefined,
    hourCycle: 'h23',
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}${withSeconds ? `:${get('second')}` : ''}`;
}

/** Short relative age: "5m ago", "3h ago", "2d ago". */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Parses "2026-10-22", "2026-10-22T10:00", "3d", "12h", "90m" into a timestamp. */
export function parseWhen(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const rel = value.trim().match(/^(\d+)\s*([mhdw])$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2].toLowerCase() as 'm'];
    return now - n * unit;
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}
