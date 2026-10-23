# agent-relay

Run AI agents as chat bots. Each bot is an agent (Claude Code, through the Agent SDK) working in a folder of your choice, reachable from Discord, with live feedback while it works, a memory that survives compaction, and a supervisor that starts with your machine.

A fork of [op7418/Claude-to-IM-skill](https://github.com/op7418/Claude-to-IM-skill), rewritten: it is no longer a Claude Code skill but a standalone runtime for any number of bots.

## What a bot does

- **Answers when it's addressed.** By default a bot answers @mentions and replies to its own messages. `/listen all` makes it read every message in a channel; DMs from allowed users always work. A thread started from one of the bot's messages becomes a conversation with it.
- **Sees what you see.** A reply brings the replied-to message along (mention the bot while replying to *anyone's* message and that message comes too), and every trigger carries the channel messages the bot hasn't seen yet. Attachments are saved and images are shown to the agent.
- **Shows its work.**
  - 👀 the moment a message reaches it (⏳ if it's queued behind another).
  - 🤔 while it thinks, then a tool emoji while it works (🔎 📖 ✏️ 💻 🌐 📋 🧩), ✍️ while it writes.
  - On longer turns, a live message with its reasoning and tool calls, plus a ⏹️ Stop button.
  - That message is deleted when the answer is posted, and ✅ marks the trigger as done (⚠️ error, ⏹️ stopped).
- **Takes reactions as answers.** 👍 on its proposal means go ahead, 👎 means no, ❓ explain, 🔁 redo. 🛑 on a message it's working on stops it. 🤖 on *any* message pulls the bot in to look at it.
- **Asks with buttons.** It can attach quick-reply buttons to an answer (`offer_choices`), ask a blocking question with buttons mid-task (Claude Code's `AskUserQuestion`), and ask the owners to approve a tool it isn't allowed to use on its own.
- **Says what it's running on.** The bot's Discord status reads `PM | Opus 5.5 (1M) | ctx 23%`: model, context window, context used. Green means ready, red working, yellow asleep. `/status` has the details.
- **Remembers.** Every message in its channels goes into a searchable archive. The bot keeps its own notebook. Before a compaction or a reset it saves notes first. Compacting is safe at any time.
- **Works on a schedule.** It can set reminders and recurring tasks for itself ("every weekday at 18h, check the sprint").

## Install

Node 22.13 or newer, and Claude Code logged in on the machine (`claude`, then `/login`) or an API key.

```bash
git clone https://github.com/tornellihenrique/agent-relay.git
cd agent-relay
npm install
npm run build
node dist/relay.mjs install
```

`relay install` puts a `relay` command in `~/.local/bin`.

## Create a bot

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application. On the **Bot** page, reset the token and turn on **Message Content Intent**.
2. Run `relay new` and answer the questions. It checks the token and channels and prints the invite link (scopes `bot` and `applications.commands`, with the permissions the bot needs).
3. `relay doctor <bot>` checks everything once more: the token, the channels, the Claude login, and which MCP servers the bot will see. It sends no prompt and spends no tokens.
4. `relay start <bot>`.

Coming from Claude-to-IM? `relay import-cti` turns `~/.claude-to-im/config.env` into a bot.

## Run

| Command | What it does |
|---|---|
| `relay` | Status of the supervisor and each bot, with its status line |
| `relay up` / `relay down` | Start the supervisor in the background, without a window / stop it and every bot |
| `relay start <bot\|all>` | Enable and start a bot |
| `relay stop <bot\|all>` | Stop a bot. It stays off, also after reboots, until started again |
| `relay restart <bot\|all>` | Restart, picking up config changes |
| `relay logs <bot\|supervisor> [-n 100] [-f]` | Read or follow logs |
| `relay dashboard` | Local web page with every bot: status, conversations, logs, start/stop |
| `relay autostart on\|off\|status` | Start the supervisor at logon. Windows uses a scheduled task, macOS launchd, Linux a systemd user unit |
| `relay doctor [bot]` | Health checks |
| `relay edit <bot>` | Open the bot's config |
| `relay run <bot>` | Run one bot in the terminal, without the supervisor (debugging) |

The supervisor runs each bot in its own process and restarts it if it crashes. Each bot keeps one Claude Code session per conversation (channel, thread or DM) alive between messages, so replies don't wait for a new CLI process. After `agent.idleMinutes` without messages the process is closed, and the next message resumes the same session.

## In Discord

| Command | |
|---|---|
| `/status` | Model, effort, context use, session, plan usage, listening mode |
| `/model [name]` · `/effort [level]` | Show or change them for this channel (owners) |
| `/compact [focus]` | Save notes, then compact the conversation |
| `/new` | Save notes and start a fresh session (owners) |
| `/stop` | Interrupt the current turn |
| `/context` | What fills the context window |
| `/memory` | The notebook index and where memory lives |
| `/history query` | Search everything said in the bot's channels |
| `/listen mode` | mentions, every message, or off, for this channel (owners) |
| `/schedules [remove]` | List or remove scheduled tasks |
| `/usage` | 5-hour and weekly plan usage |
| `/restart` | Restart the agent process; the session resumes (owners) |
| `/help` | How to talk to the bot |

## Memory

Each bot has a home at `~/.agent-relay/bots/<id>/`:

| Path | What |
|---|---|
| `bot.json` | The bot's config |
| `relay.db` | The archive: every message in its channels (or only its interactions, per config), every turn, sessions, schedules. Full-text search ignores accents |
| `notebook/` | The bot's own notes. `NOTEBOOK.md` is the index, given to the agent at the start of every session and after each compaction |
| `inbox/` | Files people attached |
| `logs/bot.log` | The bot's log |
| `state.json` | Sessions to resume, per-channel overrides |

**Compaction:**

- Claude Code compacts on its own when the context fills up. The bot compacts first, at `agent.compactAtPercent`, after asking the agent to update its notebook.
- `/compact` does the same on demand.
- The summary replaces old turns inside the session. Nothing is lost:
  - the full transcript stays in Claude Code's history (`~/.claude/projects/...`, path in `/context`);
  - every message stays in the archive, which the agent searches with `history_search` and `history_read`;
  - durable facts live in the notebook.

Several bots can share a context folder: they share the folder, its `CLAUDE.md` and its tools, and each keeps its own notebook, archive and sessions.

## The agent's Discord tools

Every session gets an in-process MCP server, `relay`, with:

- **Discord:** `react`, `offer_choices`, `send_message`, `upload_file`, `channel_messages`, `get_message`, `find_member`
- **Memory:** `history_search`, `history_read`
- **Schedules:** `schedule_create` (cron, ISO date, or "in 10m"), `schedule_list`, `schedule_delete`
- **Self:** `bot_status`

The bot's instructions are appended to Claude Code's system prompt. They cover how it is reached, how to write for Discord, how to read reactions, and its memory. Bot-specific instructions go in `agent.instructions` or `agent.instructionsFile`. Instructions about the work itself belong in the folder's `CLAUDE.md`.

## Configuration

A full `bot.json`. Only `id`, `name`, `context` and `platform` are required; everything else shows its default.

```jsonc
{
  "id": "egg-smash-pm",
  "name": "Egg Smash PM",
  "enabled": true,
  "context": "C:\\Users\\me\\Projects\\egg-smash-pm",   // the agent's working folder
  "timezone": "America/Sao_Paulo",
  "owners": ["111111111111111111"],                     // change settings, approve tools, /new
  "platform": {
    "type": "discord",
    "token": "env:EGG_SMASH_BOT_TOKEN",                 // or the token itself, or "file:path"
    "channels": ["222222222222222222"],                // channels, threads inside them, or categories
    "users": [],                                        // allowed anywhere the bot is, DMs included
    "blockedUsers": [],
    "summonEmoji": "🤖",
    "respondToBots": false,
    "suppressEmbeds": true,                             // no link previews under the bot's messages
    "allowMentions": ["users"],
    "slashCommands": true
  },
  "agent": {
    "runtime": "claude",
    "model": "opus",                                    // alias or id; empty = the CLI default
    "effort": "medium",                                 // low | medium | high | xhigh | max
    "thinking": "summarized",                           // reasoning text for the live message
    "auth": "subscription",                             // or "apiKey" with "apiKey": "env:ANTHROPIC_API_KEY"
    "claudeConfigDir": "",                              // another Claude account for this bot
    "permissionMode": "acceptEdits",                    // default | acceptEdits | bypassPermissions | plan | dontAsk | auto
    "allowedTools": [],
    "disallowedTools": ["PowerShell"],
    "mcp": { "allow": ["jira-pm", "claude.ai Google Drive"], "deny": [] },
    "settingSources": ["user", "project", "local"],     // load the folder's CLAUDE.md, settings and .mcp.json
    "additionalDirectories": [],
    "instructions": "",
    "instructionsFile": "",
    "idleMinutes": 60,                                  // 0 = keep the agent process warm forever
    "warmStart": true,
    "turnTimeoutMinutes": 45,
    "compactAtPercent": 85,
    "saveBeforeCompact": true,
    "env": {}
  },
  "conversation": {
    "scope": "channel",                                 // or "bot": one session for every channel
    "trigger": "mentions",                              // mentions | all | off
    "recentMessages": 12,                               // unseen channel messages sent along with a trigger
    "channelSettings": { "222222222222222222": { "trigger": "mentions" } }
  },
  "feedback": {
    "liveAfterSeconds": 6,
    "footer": "auto",                                   // auto | always | never
    "pingAfterSeconds": 45,                             // ping the asker when the answer took longer
    "toolReactions": true,
    "promptSuggestions": false,
    "reactions": { "received": "👀", "queued": "⏳", "thinking": "🤔", "writing": "✍️", "done": "✅", "error": "⚠️", "stopped": "⏹️", "waiting": "🙋" }
  },
  "status": { "template": "{label} | {model} ({window}) | ctx {ctx}", "label": "PM" },
  "memory": { "notebook": "", "archive": "all" },
  "schedules": [
    { "id": "daily", "when": "0 18 * * 1-5", "channel": "222222222222222222", "prompt": "Check the sprint and remind people of stale tasks." }
  ]
}
```

Status template placeholders are `{label}`, `{model}`, `{window}`, `{ctx}`, `{effort}`, `{state}`, `{queue}`, `{five_hour}` and `{seven_day}`.

### Security

- A bot only reads and answers in its `channels`, and only `users` reach it elsewhere.
- Tool approvals and settings commands are limited to `owners`.
- `agent.mcp.allow` keeps your personal connectors out of a team-facing bot. On a claude.ai login, every connector of the account loads into every session unless you hide it. `relay doctor` shows what each bot sees.
- Agent processes don't inherit Claude/Anthropic variables from the shell that started the relay (for example, a parent Claude Code session's proxy); set what a bot needs in `agent.env`.
- With `auth: subscription`, `ANTHROPIC_API_KEY` is removed, so the machine's Claude login is used.

## Code map

```
src/
  agent/      runtime interface; claude.ts = a persistent Agent SDK session
  platform/   platform interface; discord.ts; markdown chunking and tables
  bot/        bot.ts (events, triggers, context), conversation.ts (queue, session,
              compaction), turn.ts (live feedback), tools.ts (relay MCP server),
              prompts.ts (permission/question buttons), commands.ts, scheduler.ts
  core/       config schema, archive (SQLite + FTS5), state, logs, paths
  runtime/    supervisor, worker, control API + dashboard, autostart
  cli/        relay command, setup wizard, doctor
```

Adding a platform means implementing `Platform` (`src/platform/types.ts`), and a platform that can't react or edit reports it in `capabilities`. Adding an agent runtime means implementing `AgentSession` (`src/agent/types.ts`).

## Development

```bash
npm run typecheck
npm test                                  # unit tests
npx tsx test/harness/e2e.ts <scratch-dir> # real Claude, fake Discord: prints everything the bot does
```

## License

MIT. Based on Claude-to-IM-skill by op7418.
