import path from 'node:path';
import { oneLine } from '../core/text.js';

/** Short human labels and emoji for tool calls, used in the live "working" message and reactions. */

export interface ToolLabel {
  emoji: string;
  text: string;
  /** Reaction to show on the triggering message while this tool runs (undefined = keep current). */
  reaction?: string;
}

function rel(cwd: string, p: unknown): string {
  if (typeof p !== 'string' || !p) return '';
  try {
    const r = path.relative(cwd, p);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.replace(/\\/g, '/') : p.replace(/\\/g, '/');
  } catch {
    return p;
  }
}

/** "claude_ai_Google_Drive" → "Google Drive", "jira-pm" stays. */
export function serverLabel(server: string): string {
  return server.replace(/^claude_ai_/, '').replace(/_/g, ' ');
}

export function toolLabel(name: string, input: Record<string, unknown>, cwd: string): ToolLabel {
  const s = (v: unknown, max = 70) => oneLine(typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v), max);
  switch (name) {
    case 'Read':
      return { emoji: '📖', text: `Read ${rel(cwd, input.file_path)}`, reaction: '📖' };
    case 'Write':
      return { emoji: '✏️', text: `Write ${rel(cwd, input.file_path)}`, reaction: '✏️' };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { emoji: '✏️', text: `Edit ${rel(cwd, input.file_path ?? input.notebook_path)}`, reaction: '✏️' };
    case 'Bash':
    case 'PowerShell':
      return { emoji: '💻', text: s(input.description || input.command, 80), reaction: '💻' };
    case 'Grep':
      return { emoji: '🔎', text: `Search "${s(input.pattern, 40)}"`, reaction: '🔎' };
    case 'Glob':
      return { emoji: '🔎', text: `Find ${s(input.pattern, 50)}`, reaction: '🔎' };
    case 'WebSearch':
      return { emoji: '🌐', text: `Web search "${s(input.query, 50)}"`, reaction: '🌐' };
    case 'WebFetch': {
      let host = s(input.url, 60);
      try {
        host = new URL(String(input.url)).host;
      } catch { /* keep raw */ }
      return { emoji: '🌐', text: `Fetch ${host}`, reaction: '🌐' };
    }
    case 'Agent':
    case 'Task':
      return { emoji: '🧩', text: `Subagent: ${s(input.description ?? input.prompt, 60)}`, reaction: '🧩' };
    case 'TodoWrite':
      return { emoji: '📝', text: 'Update plan' };
    case 'ToolSearch':
      return { emoji: '🧰', text: 'Load tools' };
    case 'Skill':
      return { emoji: '📚', text: `Skill ${s(input.skill ?? input.name, 40)}`, reaction: '📚' };
    case 'AskUserQuestion':
      return { emoji: '🙋', text: 'Ask a question' };
    case 'Monitor':
      return { emoji: '⏱️', text: s(input.description ?? 'Watch a process', 60) };
    default:
      break;
  }
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) {
    const [, server, tool] = mcp;
    if (server === 'relay') {
      if (tool === 'react') return { emoji: '💬', text: `React ${s(input.emoji, 10)}` };
      if (tool === 'offer_choices') return { emoji: '🔘', text: 'Offer choices' };
      if (tool === 'send_message') return { emoji: '💬', text: 'Send a message' };
      if (tool.startsWith('history_')) return { emoji: '🗂️', text: `Archive: ${s(input.query ?? 'read', 40)}`, reaction: '🗂️' };
      if (tool.startsWith('schedule_')) return { emoji: '⏰', text: tool.replace('_', ' ') };
      return { emoji: '💬', text: tool.replace(/_/g, ' ') };
    }
    const label = serverLabel(server);
    const reaction = /jira|atlassian|linear|clickup/i.test(server) ? '📋' : /drive|docs|notion|gitbook/i.test(server) ? '📄' : '🔌';
    return { emoji: '🔌', text: `${label} · ${tool}`, reaction };
  }
  return { emoji: '🛠️', text: name, reaction: '🛠️' };
}
