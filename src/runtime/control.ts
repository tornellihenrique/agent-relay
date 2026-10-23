import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { sleep } from '../core/async.js';
import { ensureDir, entryScript, paths, stableNodePath } from '../core/paths.js';
import { readSupervisorInfo, type BotEntry, type SupervisorInfo } from './supervisor.js';

/** Client for the supervisor's local control API. */
export class Control {
  constructor(readonly info: SupervisorInfo) {}

  static current(): Control | undefined {
    const info = readSupervisorInfo();
    return info ? new Control(info) : undefined;
  }

  get dashboardUrl(): string {
    return `http://127.0.0.1:${this.info.port}/?t=${this.info.token}`;
  }

  async request<T>(method: string, path: string): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${this.info.port}${path}`, {
      method,
      headers: { 'x-relay-token': this.info.token },
      signal: AbortSignal.timeout(30_000),
    });
    const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(typeof body === 'string' ? body : JSON.stringify(body));
    return body as T;
  }

  status(): Promise<{ supervisor: Omit<SupervisorInfo, 'token'>; bots: BotEntry[] }> {
    return this.request('GET', '/api/status');
  }
}

/** Starts the supervisor detached from this terminal (no window) and waits until it answers. */
export async function startSupervisorDetached(): Promise<Control> {
  const running = Control.current();
  if (running) return running;
  if (!fs.existsSync(entryScript())) throw new Error(`build missing: ${entryScript()} (run npm run build)`);
  ensureDir(paths.logs);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC_|MCP_|CCD_)/i.test(k)) env[k] = v;
  const child = spawn(stableNodePath(), [entryScript(), 'supervisor'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const c = Control.current();
    if (c) {
      try {
        await c.status();
        return c;
      } catch { /* not listening yet */ }
    }
  }
  throw new Error(`the supervisor did not come up; see ${paths.supervisorLog}`);
}
