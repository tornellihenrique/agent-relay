import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { entryScript, repoRoot, stableNodePath } from '../core/paths.js';

/** Starting the supervisor when the user logs in: a scheduled task on Windows, launchd on macOS, systemd on Linux. */

const TASK = 'agent-relay';

function ps(script: string): { ok: boolean; out: string } {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function autostartStatus(): string {
  if (process.platform === 'win32') {
    const r = ps(`$t = Get-ScheduledTask -TaskName ${q(TASK)} -ErrorAction SilentlyContinue; if ($t) { $t.State.ToString() + ' | ' + $t.Actions[0].Execute + ' ' + $t.Actions[0].Arguments } else { 'not installed' }`);
    return r.out || 'unknown';
  }
  if (process.platform === 'darwin') return fs.existsSync(plistPath()) ? `installed (${plistPath()})` : 'not installed';
  return fs.existsSync(unitPath()) ? `installed (${unitPath()})` : 'not installed';
}

export function enableAutostart(): string {
  const node = stableNodePath();
  const entry = entryScript();
  if (process.platform === 'win32') {
    // conhost --headless runs the console without a window; -WindowStyle Hidden still flashes one when
    // Windows Terminal is the default terminal.
    const args = `--headless "${node}" "${entry}" supervisor`;
    const script = [
      `$conhost = Join-Path $env:SystemRoot 'System32\\conhost.exe'`,
      `$action = New-ScheduledTaskAction -Execute $conhost -Argument ${q(args)} -WorkingDirectory ${q(repoRoot())}`,
      `$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"`,
      `$trigger.Delay = 'PT20S'`,
      `$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)`,
      `$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited`,
      `Register-ScheduledTask -TaskName ${q(TASK)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'agent-relay supervisor: runs the enabled chat bots. Logs in %USERPROFILE%\\.agent-relay\\logs.' -Force | Out-Null`,
      `'ok'`,
    ].join('; ');
    const r = ps(script);
    if (!r.ok) throw new Error(`could not register the scheduled task: ${r.out}`);
    return `Scheduled task "${TASK}" starts the supervisor 20s after you log in (node: ${node}).`;
  }
  if (process.platform === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.agent-relay.supervisor</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${entry}</string><string>supervisor</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>WorkingDirectory</key><string>${repoRoot()}</string>
</dict></plist>`;
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    fs.writeFileSync(plistPath(), plist);
    spawnSync('launchctl', ['load', '-w', plistPath()]);
    return `LaunchAgent installed: ${plistPath()}`;
  }
  const unit = `[Unit]
Description=agent-relay supervisor
After=network-online.target

[Service]
ExecStart=${node} ${entry} supervisor
WorkingDirectory=${repoRoot()}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
  fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
  fs.writeFileSync(unitPath(), unit);
  spawnSync('systemctl', ['--user', 'daemon-reload']);
  spawnSync('systemctl', ['--user', 'enable', 'agent-relay.service']);
  return `systemd user unit installed: ${unitPath()} (enable lingering with "loginctl enable-linger" to run without a login)`;
}

export function disableAutostart(): string {
  if (process.platform === 'win32') {
    const r = ps(`Unregister-ScheduledTask -TaskName ${q(TASK)} -Confirm:$false -ErrorAction SilentlyContinue; 'ok'`);
    return r.ok ? `Scheduled task "${TASK}" removed.` : r.out;
  }
  if (process.platform === 'darwin') {
    spawnSync('launchctl', ['unload', '-w', plistPath()]);
    fs.rmSync(plistPath(), { force: true });
    return 'LaunchAgent removed.';
  }
  spawnSync('systemctl', ['--user', 'disable', 'agent-relay.service']);
  fs.rmSync(unitPath(), { force: true });
  return 'systemd unit removed.';
}

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.agent-relay.supervisor.plist');
}

function unitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'agent-relay.service');
}
