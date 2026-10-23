import { fork, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BotStatus } from '../bot/bot.js';
import { listBotIds, loadBotConfig, loadGlobalConfig, patchBotConfig, type BotConfig } from '../core/config.js';
import { logger, setLogFile, tailFile } from '../core/log.js';
import { botPaths, entryScript, paths, readJson, writeJsonAtomic } from '../core/paths.js';
import { dashboardHtml } from './dashboard.js';

export interface SupervisorInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
  version: string;
}

export interface BotEntry {
  id: string;
  name?: string;
  enabled: boolean;
  running: boolean;
  pid?: number;
  status?: BotStatus;
  restarts: number;
  lastExit?: { code: number | null; signal: string | null; at: number };
  configError?: string;
  startedAt?: number;
  context?: string;
}

const VERSION = '0.1.0';
const log = logger('supervisor');

/** The environment workers inherit: without variables a parent Claude Code session leaks. */
function workerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC_|MCP_|CCD_)/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

export function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readSupervisorInfo(): SupervisorInfo | undefined {
  const info = readJson<SupervisorInfo>(paths.supervisorInfo);
  return info && pidAlive(info.pid) ? info : undefined;
}

class Managed {
  child: ChildProcess | undefined;
  status: BotStatus | undefined;
  restarts = 0;
  backoff = 0;
  wanted = false;
  lastExit: BotEntry['lastExit'];
  timer: NodeJS.Timeout | undefined;
  stableTimer: NodeJS.Timeout | undefined;
  config: BotConfig | undefined;
  configError: string | undefined;
  startedAt: number | undefined;
  constructor(readonly id: string) {}
}

export class Supervisor {
  private bots = new Map<string, Managed>();
  private server: http.Server | undefined;
  private info: SupervisorInfo | undefined;
  private backoffs = loadGlobalConfig().restartBackoffSeconds;
  private shuttingDown = false;

  async run(opts: { foreground?: boolean } = {}): Promise<void> {
    setLogFile(paths.supervisorLog, { console: Boolean(opts.foreground) });
    const existing = readSupervisorInfo();
    if (existing && existing.pid !== process.pid) {
      log.warn(`another supervisor is running (pid ${existing.pid}); exiting`);
      process.exit(0);
    }
    const token = crypto.randomBytes(18).toString('base64url');
    const port = await this.listen(token, loadGlobalConfig().dashboardPort);
    this.info = { pid: process.pid, port, token, startedAt: Date.now(), version: VERSION };
    writeJsonAtomic(paths.supervisorInfo, this.info);
    log.info(`supervisor up (pid ${process.pid}, control http://127.0.0.1:${port})`);

    process.on('SIGINT', () => void this.shutdown('SIGINT'));
    process.on('SIGTERM', () => void this.shutdown('SIGTERM'));
    process.on('unhandledRejection', (r) => log.error('unhandled rejection:', r));
    this.reload();
  }

  private listen(token: string, preferred: number): Promise<number> {
    const server = http.createServer((req, res) => {
      this.handle(req, res, token).catch((err) => {
        log.error('control request failed:', err);
        res.writeHead(500).end(String(err));
      });
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && preferred !== 0) {
          log.warn(`port ${preferred} busy; using a random port`);
          server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
        } else reject(err);
      });
      server.listen(preferred, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
  }

  /** Picks up new, changed and removed bot configs. */
  reload(): void {
    const ids = new Set(listBotIds());
    for (const id of ids) {
      const m = this.bots.get(id) ?? new Managed(id);
      this.bots.set(id, m);
      try {
        m.config = loadBotConfig(id);
        m.configError = undefined;
        if (m.config.enabled && !m.child) this.start(id);
      } catch (err) {
        m.configError = (err as Error).message;
        log.error(m.configError);
      }
    }
    for (const [id, m] of this.bots) {
      if (!ids.has(id)) {
        this.stop(id);
        this.bots.delete(id);
      }
    }
  }

  start(id: string): void {
    const m = this.bots.get(id);
    if (!m || m.child) return;
    m.wanted = true;
    clearTimeout(m.timer);
    log.info(`starting bot ${id}`);
    const child = fork(entryScript(), ['worker', id], {
      env: workerEnv(),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    m.child = child;
    m.startedAt = Date.now();
    m.status = undefined;
    const errLog = botPaths(id).log;
    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().trim();
      if (text) {
        log.warn(`[${id}] ${text.slice(0, 2000)}`);
        try {
          fs.appendFileSync(errLog, `${new Date().toISOString()} STDERR [${id}] ${text}\n`);
        } catch { /* ignore */ }
      }
    });
    child.stdout?.resume();
    child.on('message', (msg: { type?: string; status?: BotStatus }) => {
      if (msg?.type === 'status' && msg.status) m.status = msg.status;
    });
    child.on('exit', (code, signal) => {
      m.child = undefined;
      clearTimeout(m.stableTimer);
      m.lastExit = { code, signal, at: Date.now() };
      if (m.status) m.status = { ...m.status, state: code === 0 ? 'stopping' : 'error' };
      log.info(`bot ${id} exited (code ${code}, signal ${signal})`);
      if (m.wanted && !this.shuttingDown) {
        const delay = this.backoffs[Math.min(m.backoff, this.backoffs.length - 1)] ?? 30;
        m.backoff++;
        m.restarts++;
        log.info(`restarting ${id} in ${delay}s`);
        m.timer = setTimeout(() => this.start(id), delay * 1000);
      }
    });
    // A bot that stays up for 5 minutes gets its backoff reset.
    m.stableTimer = setTimeout(() => (m.backoff = 0), 5 * 60_000);
  }

  stop(id: string): Promise<void> {
    const m = this.bots.get(id);
    if (!m) return Promise.resolve();
    m.wanted = false;
    clearTimeout(m.timer);
    const child = m.child;
    if (!child) return Promise.resolve();
    log.info(`stopping bot ${id}`);
    return new Promise((resolve) => {
      const kill = setTimeout(() => {
        log.warn(`bot ${id} did not stop in time; killing it`);
        child.kill();
      }, 20_000);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      try {
        child.send({ type: 'shutdown' });
      } catch {
        child.kill();
      }
    });
  }

  async restart(id: string): Promise<void> {
    await this.stop(id);
    const m = this.bots.get(id);
    if (m) m.backoff = 0;
    try {
      if (m) m.config = loadBotConfig(id);
    } catch (err) {
      if (m) m.configError = (err as Error).message;
      return;
    }
    this.start(id);
  }

  async shutdown(why: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log.info(`supervisor shutting down (${why})`);
    await Promise.all([...this.bots.keys()].map((id) => this.stop(id)));
    this.server?.close();
    try {
      const info = readJson<SupervisorInfo>(paths.supervisorInfo);
      if (info?.pid === process.pid) fs.unlinkSync(paths.supervisorInfo);
    } catch { /* ignore */ }
    process.exit(0);
  }

  entries(): BotEntry[] {
    return [...this.bots.values()].map((m) => ({
      id: m.id,
      name: m.config?.name,
      enabled: Boolean(m.config?.enabled),
      running: Boolean(m.child),
      pid: m.child?.pid,
      status: m.status,
      restarts: m.restarts,
      lastExit: m.lastExit,
      configError: m.configError,
      startedAt: m.startedAt,
      context: m.config?.context,
    }));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, token: string): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/' && req.method === 'GET') {
      if (url.searchParams.get('t') !== token) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('Open the dashboard with `relay dashboard`.');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(dashboardHtml(token));
      return;
    }
    if (req.headers['x-relay-token'] !== token) return json(401, { error: 'bad token' });

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api') return json(404, { error: 'not found' });
    if (parts[1] === 'status' && req.method === 'GET') {
      return json(200, { supervisor: this.info && { ...this.info, token: undefined }, bots: this.entries() });
    }
    if (parts[1] === 'reload' && req.method === 'POST') {
      this.reload();
      return json(200, { ok: true });
    }
    if (parts[1] === 'shutdown' && req.method === 'POST') {
      json(200, { ok: true });
      setTimeout(() => void this.shutdown('control request'), 50);
      return;
    }
    if (parts[1] === 'bots' && parts[2]) {
      const id = parts[2];
      if (!this.bots.has(id)) this.reload();
      const m = this.bots.get(id);
      if (!m) return json(404, { error: `no bot ${id}` });
      const action = parts[3];
      if (action === 'logs' && req.method === 'GET') {
        const n = Number(url.searchParams.get('n') ?? 200);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(tailFile(botPaths(id).log, n));
        return;
      }
      if (req.method !== 'POST') return json(405, { error: 'use POST' });
      if (action === 'start') {
        if (m.config && !m.config.enabled) patchBotConfig(id, (raw) => (raw.enabled = true));
        this.reload();
        this.start(id);
        return json(200, { ok: true });
      }
      if (action === 'stop') {
        if (m.config?.enabled) patchBotConfig(id, (raw) => (raw.enabled = false));
        await this.stop(id);
        this.reload();
        return json(200, { ok: true });
      }
      if (action === 'restart') {
        await this.restart(id);
        return json(200, { ok: true });
      }
    }
    return json(404, { error: 'not found' });
  }
}
