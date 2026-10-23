import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './paths.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

let file: string | undefined;
let stream: fs.WriteStream | undefined;
let written = 0;
let toConsole = true;
let minLevel: Level = (process.env.RELAY_LOG_LEVEL as Level) || 'info';

/** Sends log lines to a rotating file (and optionally the console). */
export function setLogFile(target: string, opts: { console?: boolean } = {}): void {
  file = target;
  toConsole = opts.console ?? false;
  ensureDir(path.dirname(target));
  try {
    written = fs.statSync(target).size;
  } catch {
    written = 0;
  }
  stream?.end();
  stream = fs.createWriteStream(target, { flags: 'a' });
}

export function setLogLevel(level: Level): void {
  minLevel = level;
}

function rotate(): void {
  if (!file) return;
  stream?.end();
  for (let i = KEEP - 1; i >= 1; i--) {
    try {
      fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch { /* missing */ }
  }
  try {
    fs.renameSync(file, `${file}.1`);
  } catch { /* missing */ }
  stream = fs.createWriteStream(file, { flags: 'a' });
  written = 0;
}

function fmt(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level: Level, scope: string, parts: unknown[]): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${parts.map(fmt).join(' ')}\n`;
  if (stream) {
    if (written + line.length > MAX_BYTES) rotate();
    stream.write(line);
    written += line.length;
  }
  if (toConsole || !stream) {
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line);
  }
}

export interface Logger {
  debug(...parts: unknown[]): void;
  info(...parts: unknown[]): void;
  warn(...parts: unknown[]): void;
  error(...parts: unknown[]): void;
  child(scope: string): Logger;
}

export function logger(scope: string): Logger {
  return {
    debug: (...p) => write('debug', scope, p),
    info: (...p) => write('info', scope, p),
    warn: (...p) => write('warn', scope, p),
    error: (...p) => write('error', scope, p),
    child: (sub) => logger(`${scope}:${sub}`),
  };
}

/** Reads the last `lines` lines of a log file. */
export function tailFile(target: string, lines: number): string {
  try {
    const stat = fs.statSync(target);
    const size = Math.min(stat.size, Math.max(64 * 1024, lines * 400));
    const fd = fs.openSync(target, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size);
    fs.closeSync(fd);
    const all = buf.toString('utf8').split('\n');
    if (all.at(-1) === '') all.pop();
    return all.slice(-lines).join('\n');
  } catch {
    return '';
  }
}
