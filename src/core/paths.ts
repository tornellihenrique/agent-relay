import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of all runtime data. Override with AGENT_RELAY_HOME. */
export const RELAY_HOME = process.env.AGENT_RELAY_HOME || path.join(os.homedir(), '.agent-relay');

export const paths = {
  home: RELAY_HOME,
  globalConfig: path.join(RELAY_HOME, 'relay.json'),
  run: path.join(RELAY_HOME, 'run'),
  supervisorInfo: path.join(RELAY_HOME, 'run', 'supervisor.json'),
  logs: path.join(RELAY_HOME, 'logs'),
  supervisorLog: path.join(RELAY_HOME, 'logs', 'supervisor.log'),
  bots: path.join(RELAY_HOME, 'bots'),
};

export interface BotPaths {
  dir: string;
  config: string;
  state: string;
  db: string;
  status: string;
  notebook: string;
  inbox: string;
  logs: string;
  log: string;
}

export function botPaths(botId: string, notebookOverride?: string): BotPaths {
  const dir = path.join(paths.bots, botId);
  return {
    dir,
    config: path.join(dir, 'bot.json'),
    state: path.join(dir, 'state.json'),
    db: path.join(dir, 'relay.db'),
    status: path.join(dir, 'status.json'),
    notebook: notebookOverride ? path.resolve(notebookOverride) : path.join(dir, 'notebook'),
    inbox: path.join(dir, 'inbox'),
    logs: path.join(dir, 'logs'),
    log: path.join(dir, 'logs', 'bot.log'),
  };
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The repository root (where package.json lives), resolved from the running bundle. */
export function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

/** Absolute path of the bundled entry (dist/relay.mjs), used to spawn supervisors and workers. */
export function entryScript(): string {
  return path.join(repoRoot(), 'dist', 'relay.mjs');
}

/**
 * Real path of the running node executable. Version managers like fnm run node from a per-shell
 * symlink that disappears with the shell, so autostart entries must use the resolved path.
 */
export function stableNodePath(): string {
  try {
    return fs.realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

/** Writes JSON atomically (temp file + rename). */
export function writeJsonAtomic(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
