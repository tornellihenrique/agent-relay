import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listBotIds, loadBotConfig, patchBotConfig } from '../core/config.js';
import { tailFile } from '../core/log.js';
import { botPaths, entryScript, paths, repoRoot, stableNodePath } from '../core/paths.js';
import { ago } from '../core/text.js';
import { autostartStatus, disableAutostart, enableAutostart } from '../runtime/autostart.js';
import { Control, startSupervisorDetached } from '../runtime/control.js';
import { Supervisor, type BotEntry } from '../runtime/supervisor.js';
import { runWorker } from '../runtime/worker.js';
import { checkClaude, checkDiscordChannel, checkDiscordToken } from './checks.js';
import { importClaudeToIm, newBotWizard } from './wizard.js';

const HELP = `relay — run AI agents as chat bots

  relay                        status of the supervisor and every bot
  relay up                     start the supervisor in the background (starts enabled bots)
  relay down                   stop the supervisor and all bots
  relay start <bot|all>        enable a bot and start it
  relay stop <bot|all>         stop a bot and keep it off (also after reboots)
  relay restart <bot|all>      restart (picks up config changes)
  relay logs <bot|supervisor> [-n 100] [-f]
  relay new                    create a bot (asks a few questions)
  relay edit <bot>             open the bot's config file
  relay doctor [bot]           check node, build, Discord token/channels, Claude login, MCP servers
  relay autostart on|off|status  start the supervisor when you log in
  relay dashboard              open the local web dashboard
  relay install                put the relay command on your PATH
  relay import-cti [file]      import a Claude-to-IM setup (~/.claude-to-im/config.env)
  relay run <bot>              run one bot in this terminal (debugging; no supervisor)

Data lives in ${paths.home}`;

function arg(flag: string, args: string[]): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n - 1) + '…' : s + ' '.repeat(n - s.length);
}

function botLine(b: BotEntry): string {
  const st = b.status;
  const state = b.configError ? 'config error' : b.running ? (st?.state ?? 'starting') : b.enabled ? 'restarting' : 'stopped';
  const conv = st?.conversations ?? [];
  const busy = conv.some((c) => c.busy) ? ' ⚙️' : '';
  const last = Math.max(0, ...conv.map((c) => c.lastActiveAt ?? 0));
  return `${pad(b.id, 20)}${pad(state + busy, 14)}${pad(st?.presence ?? '—', 44)}${last ? ago(last) : ''}`;
}

async function status(): Promise<void> {
  const c = Control.current();
  if (!c) {
    console.log('Supervisor: not running (start it with: relay up)');
    const ids = listBotIds();
    for (const id of ids) {
      try {
        const cfg = loadBotConfig(id);
        console.log(`  ${pad(id, 20)}${cfg.enabled ? 'enabled' : 'disabled'}  ${cfg.context}`);
      } catch (err) {
        console.log(`  ${pad(id, 20)}config error: ${(err as Error).message.split('\n')[0]}`);
      }
    }
    if (!ids.length) console.log('No bots yet: relay new');
    return;
  }
  const s = await c.status();
  console.log(`Supervisor pid ${s.supervisor.pid}, up since ${ago(s.supervisor.startedAt).replace(' ago', '')} · dashboard: relay dashboard`);
  console.log(`\n  ${pad('BOT', 20)}${pad('STATE', 14)}${pad('STATUS LINE', 44)}LAST TURN`);
  for (const b of s.bots) {
    console.log(`  ${botLine(b)}`);
    if (b.configError) console.log(`    ${b.configError.split('\n').join('\n    ')}`);
    if (b.status?.error) console.log(`    error: ${b.status.error}`);
  }
  if (!s.bots.length) console.log('  (no bots: relay new)');
}

async function forBots(target: string | undefined, fn: (c: Control, id: string) => Promise<void>): Promise<void> {
  if (!target) throw new Error('which bot? (or "all")');
  const ids = target === 'all' ? listBotIds() : [target];
  if (!ids.length) throw new Error('no bots configured (relay new)');
  for (const id of ids) if (!listBotIds().includes(id)) throw new Error(`no bot "${id}" (have: ${listBotIds().join(', ') || 'none'})`);
  const c = await startSupervisorDetached();
  for (const id of ids) await fn(c, id);
}

function openInBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function followLog(file: string, lines: number): Promise<void> {
  console.log(tailFile(file, lines));
  let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  setInterval(() => {
    try {
      const now = fs.statSync(file).size;
      if (now < size) size = 0;
      if (now > size) {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(now - size);
        fs.readSync(fd, buf, 0, buf.length, size);
        fs.closeSync(fd);
        process.stdout.write(buf.toString('utf8'));
        size = now;
      }
    } catch { /* rotated */ }
  }, 700);
  await new Promise(() => {});
}

async function doctor(only?: string): Promise<void> {
  const ok = (m: string) => console.log(`  ✓ ${m}`);
  const bad = (m: string) => console.log(`  ✗ ${m}`);
  const warn = (m: string) => console.log(`  ⚠ ${m}`);
  console.log('agent-relay');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) ok(`node ${process.versions.node} (${stableNodePath()})`);
  else bad(`node ${process.versions.node}: need 22.13 or newer`);
  if (fs.existsSync(entryScript())) ok(`build ${entryScript()}`);
  else bad('not built: run npm run build');
  const c = Control.current();
  if (c) ok(`supervisor running (pid ${c.info.pid})`);
  else warn('supervisor not running (relay up)');
  const auto = autostartStatus();
  if (/^(Ready|Running)|^installed/.test(auto)) ok(`autostart: ${auto}`);
  else warn(`autostart: ${auto} (relay autostart on)`);

  for (const id of only ? [only] : listBotIds()) {
    console.log(`\nbot ${id}`);
    let cfg;
    try {
      cfg = loadBotConfig(id);
      ok(`config ${botPaths(id).config}`);
    } catch (err) {
      bad((err as Error).message);
      continue;
    }
    if (fs.existsSync(cfg.context)) ok(`context ${cfg.context}`);
    else bad(`context folder missing: ${cfg.context}`);
    try {
      const me = await checkDiscordToken(cfg.platform.token);
      ok(`discord bot "${me.username}" (${me.id})`);
      if (me.messageContentIntent === false) bad('Message Content Intent is off (Developer Portal → Bot → Privileged Gateway Intents)');
    } catch (err) {
      bad(`discord token: ${(err as Error).message}`);
    }
    for (const ch of cfg.platform.channels) {
      try {
        ok(`channel ${ch}: ${await checkDiscordChannel(cfg.platform.token, ch)}`);
      } catch (err) {
        bad(`channel ${ch}: ${(err as Error).message}`);
      }
    }
    if (!cfg.platform.channels.length && !cfg.platform.users.length) bad('no channels or users configured: the bot answers nobody');
    if (!cfg.owners.length) warn('no owners: nobody can approve tools or change settings from Discord');
    console.log('  … starting Claude in the folder (no prompt is sent)');
    const claude = await checkClaude(cfg);
    if (claude.error) bad(`claude: ${claude.error}`);
    else {
      ok(`claude: ${claude.account ?? '?'}${claude.subscription ? ` (${claude.subscription})` : ''}, auth ${cfg.agent.auth}`);
      for (const m of claude.mcp) {
        const line = `MCP ${m.name}: ${m.status}${m.hidden ? ' — hidden from this bot' : ''}${m.error ? ` (${m.error})` : ''}`;
        if (m.hidden) console.log(`  · ${line}`);
        else if (m.status === 'connected') ok(line);
        else if (m.status === 'needs-auth') bad(`${line} — log in with /mcp in an interactive claude session in ${cfg.context}`);
        else warn(line);
      }
    }
  }
}

function installShim(): string {
  const node = stableNodePath();
  const dir = path.join(os.homedir(), '.local', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const file = path.join(dir, 'relay.cmd');
    fs.writeFileSync(file, `@echo off\r\n"${node}" "${entryScript()}" %*\r\n`);
    const onPath = (process.env.PATH ?? '').toLowerCase().split(';').some((p) => path.resolve(p) === path.resolve(dir).toLowerCase() || p.toLowerCase() === dir.toLowerCase());
    return `Wrote ${file}.${onPath ? '' : ` Add ${dir} to your PATH to use it.`}`;
  }
  const file = path.join(dir, 'relay');
  fs.writeFileSync(file, `#!/bin/sh\nexec "${node}" "${entryScript()}" "$@"\n`, { mode: 0o755 });
  return `Wrote ${file}.`;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd ?? 'status') {
    case 'status':
      return status();
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    case 'supervisor':
      return new Supervisor().run({ foreground: args.includes('--fg') || process.stdout.isTTY });
    case 'worker':
      return runWorker(args[0]);
    case 'run':
      if (!args[0]) throw new Error('relay run <bot>');
      if (Control.current()?.info && (await Control.current()!.status()).bots.find((b) => b.id === args[0] && b.running)) {
        throw new Error(`${args[0]} is already running under the supervisor (relay stop ${args[0]} first)`);
      }
      return runWorker(args[0], { foreground: true });
    case 'up': {
      if (args.includes('--fg')) return new Supervisor().run({ foreground: true });
      const c = await startSupervisorDetached();
      console.log(`Supervisor running (pid ${c.info.pid}).`);
      await new Promise((r) => setTimeout(r, 1500));
      return status();
    }
    case 'down': {
      const c = Control.current();
      if (!c) return console.log('Supervisor is not running.');
      await c.request('POST', '/api/shutdown');
      for (let i = 0; i < 60 && Control.current(); i++) await new Promise((r) => setTimeout(r, 500));
      console.log(Control.current() ? 'Supervisor is still stopping…' : 'Stopped.');
      return;
    }
    case 'start':
      await forBots(args[0], async (c, id) => {
        await c.request('POST', `/api/bots/${id}/start`);
        console.log(`Started ${id}.`);
      });
      return;
    case 'stop':
      await forBots(args[0], async (c, id) => {
        await c.request('POST', `/api/bots/${id}/stop`);
        console.log(`Stopped ${id} (it stays off until: relay start ${id}).`);
      });
      return;
    case 'restart':
      await forBots(args[0], async (c, id) => {
        await c.request('POST', `/api/bots/${id}/restart`);
        console.log(`Restarted ${id}.`);
      });
      return;
    case 'logs': {
      const target = args[0] ?? 'supervisor';
      const n = Number(arg('-n', args) ?? 80);
      const file = target === 'supervisor' ? paths.supervisorLog : botPaths(target).log;
      if (args.includes('-f')) return followLog(file, n);
      console.log(tailFile(file, n) || `(no log at ${file})`);
      return;
    }
    case 'new': {
      const id = await newBotWizard();
      if (!id) return;
      console.log(`\nNext: relay doctor ${id}   then   relay start ${id}`);
      return;
    }
    case 'edit': {
      if (!args[0]) throw new Error('relay edit <bot>');
      const file = botPaths(args[0]).config;
      if (!fs.existsSync(file)) throw new Error(`no ${file}`);
      const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
      spawnSync(editor, [file], { stdio: 'inherit', shell: process.platform === 'win32' });
      loadBotConfig(args[0]);
      console.log(`Config OK. Apply with: relay restart ${args[0]}`);
      return;
    }
    case 'enable':
    case 'disable':
      if (!args[0]) throw new Error(`relay ${cmd} <bot>`);
      patchBotConfig(args[0], (raw) => (raw.enabled = cmd === 'enable'));
      console.log(`${args[0]} ${cmd}d.`);
      return;
    case 'doctor':
      return doctor(args[0]);
    case 'autostart': {
      const sub = args[0] ?? 'status';
      if (sub === 'on') console.log(enableAutostart());
      else if (sub === 'off') console.log(disableAutostart());
      else console.log(`autostart: ${autostartStatus()}`);
      return;
    }
    case 'dashboard': {
      const c = await startSupervisorDetached();
      console.log(c.dashboardUrl);
      openInBrowser(c.dashboardUrl);
      return;
    }
    case 'install':
      console.log(installShim());
      return;
    case 'import-cti': {
      const file = args[0] ?? path.join(os.homedir(), '.claude-to-im', 'config.env');
      console.log(await importClaudeToIm(file));
      return;
    }
    case 'path':
      console.log(`home ${paths.home}\nrepo ${repoRoot()}`);
      return;
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`relay: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
