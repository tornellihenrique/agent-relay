/**
 * End-to-end run against a real Claude session and a fake Discord. Spends a little real usage.
 *   npx tsx test/harness/e2e.ts <scratch-dir> [scenario...]
 * Scenarios: basic, reply, reaction, choices, live, question, status, compact, schedule
 */
import fs from 'node:fs';
import path from 'node:path';

const scratch = path.resolve(process.argv[2] ?? '.e2e');
const wanted = new Set(process.argv.slice(3));
const run = (name: string) => wanted.size === 0 || wanted.has(name);
process.env.AGENT_RELAY_HOME = path.join(scratch, 'home');
const context = path.join(scratch, 'context');
fs.mkdirSync(context, { recursive: true });
fs.writeFileSync(path.join(context, 'CLAUDE.md'), '# Test folder\n\nThis folder is a test fixture for a chat bot. Keep answers to one or two sentences.\n');
fs.writeFileSync(path.join(context, 'notes.md'), '# Notes\n\nline one\nline two\nline three\n');

const { BotConfig } = await import('../../src/core/config.js');
const { Bot } = await import('../../src/bot/bot.js');
const { setLogFile } = await import('../../src/core/log.js');
const { FakePlatform } = await import('./fake-platform.js');
const { sleep } = await import('../../src/core/async.js');

setLogFile(path.join(scratch, 'e2e.log'), { console: false });
const cfg = BotConfig.parse({
  id: 'e2e',
  name: 'TestBot',
  context,
  owners: ['u-henrique'],
  timezone: 'America/Sao_Paulo',
  platform: { type: 'discord', token: 'fake', channels: ['chan-1'] },
  agent: { model: process.env.E2E_MODEL ?? 'haiku', effort: 'medium', warmStart: true, idleMinutes: 0, mcp: { allow: [] } },
  feedback: { liveAfterSeconds: 3, footer: 'always' },
});
const fake = new FakePlatform();
const bot = new Bot(cfg, () => {}, fake);
const henrique = { id: 'u-henrique', name: 'Henrique', username: 'tornelli', isBot: false };
const caua = { id: 'u-caua', name: 'Cauã', username: 'caauuz', isBot: false };

const t0 = Date.now();
await bot.start();
const conv = () => bot.allConversations()[0];
async function idle(label: string, timeoutMs = 240_000): Promise<void> {
  const start = Date.now();
  await sleep(300);
  while (bot.allConversations().some((c) => c.busy || c.queued)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(300);
  }
  console.log(`--- ${label} done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}
console.log(`--- started in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
// Approve permission prompts like an owner would.
const approved = new Set<string>();
setInterval(() => {
  for (const m of fake.messages.values()) {
    const allow = m.buttons?.flat().find((b) => b.id.startsWith('p:') && b.id.endsWith(':allow'));
    if (allow && !approved.has(allow.id)) {
      approved.add(allow.id);
      void fake.interact(henrique, 'button', allow.id, { messageId: m.id });
    }
  }
}, 1000).unref();
await sleep(8000); // let the warm start finish

if (run('basic')) {
  fake.say(henrique, 'quantos arquivos tem nessa pasta? responda em uma linha', { mention: true });
  await idle('basic');
}
if (run('reply')) {
  fake.say(caua, 'alguém sabe se a sprint fecha sexta?');
  await sleep(200);
  const last = fake.lastBotMessage();
  fake.say(henrique, 'e quantas linhas tem o notes.md? e o que o Cauã perguntou?', { replyTo: last?.id });
  await idle('reply');
}
if (run('reaction')) {
  const last = fake.lastBotMessage();
  if (last) fake.reactAs(henrique, last.id, '👍', 'thumbsup');
  await sleep(3000);
  await idle('reaction');
}
if (run('choices')) {
  fake.say(henrique, 'quero criar um arquivo novo aqui. me deixa escolher o nome entre a.txt e b.txt com botões, sem criar ainda', { mention: true });
  await idle('choices (offer)');
  const last = fake.lastBotMessage();
  const btn = last?.buttons?.flat()[0];
  if (btn) {
    await fake.interact(henrique, 'button', btn.id, { messageId: last!.id, label: btn.label });
    await idle('choices (pick)');
  } else console.log('!!! no buttons were offered');
}
if (run('live')) {
  fake.say(henrique, 'leia todos os arquivos daqui, um por um, pensando com calma, e me dê um resumo de 2 linhas', { mention: true });
  await idle('live');
}
if (run('question')) {
  fake.say(henrique, 'use a ferramenta AskUserQuestion para me perguntar se prefiro azul ou verde, e depois me diga o que escolhi', { mention: true });
  const start = Date.now();
  let asked: string | undefined;
  while (!asked && Date.now() - start < 120_000) {
    await sleep(500);
    asked = [...fake.messages.values()].find((m) => m.fromSelf && m.buttons?.flat().some((b) => b.id.startsWith('q:')))?.buttons?.flat()[0]?.id;
  }
  if (asked) {
    const q = [...fake.messages.values()].find((m) => m.buttons?.flat().some((b) => b.id === asked))!;
    await fake.interact(henrique, 'button', asked, { messageId: q.id });
  } else console.log('!!! no question appeared');
  await idle('question');
}
if (run('status')) {
  await fake.interact(henrique, 'command', 'status');
  await fake.interact(henrique, 'command', 'memory');
  await fake.interact(henrique, 'command', 'history', { options: { query: 'sprint' } });
}
if (run('compact')) {
  conv()?.compact({ trigger: 'manual', by: 'Henrique' });
  await idle('compact', 300_000);
}
if (run('schedule')) {
  fake.say(henrique, 'crie um lembrete único daqui a 1 minuto (when "in 1m") dizendo "teste de lembrete", usando schedule_create', { mention: true });
  await idle('schedule (create)');
  console.log('--- waiting for the schedule to fire');
  await sleep(75_000);
  await idle('schedule (fire)');
}

console.log(`--- presence: [${fake.presence?.state}] ${fake.presence?.text}`);
console.log(`--- status: ${JSON.stringify(bot.status().conversations)}`);
await bot.stop('e2e done');
process.exit(0);
