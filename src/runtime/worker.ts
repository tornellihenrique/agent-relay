import { Bot } from '../bot/bot.js';
import { loadBotConfig } from '../core/config.js';
import { logger, setLogFile } from '../core/log.js';
import { botPaths } from '../core/paths.js';

/** Runs one bot in this process. Under the supervisor it reports status over IPC. */
export async function runWorker(botId: string, opts: { foreground?: boolean } = {}): Promise<void> {
  const cfg = loadBotConfig(botId);
  setLogFile(botPaths(botId, cfg.memory.notebook).log, { console: Boolean(opts.foreground) });
  const log = logger(`${botId}:worker`);
  log.info(`starting bot "${cfg.name}" (pid ${process.pid}, context ${cfg.context})`);

  const bot = new Bot(cfg, (status) => {
    if (process.send) process.send({ type: 'status', status });
  });

  let stopping = false;
  const shutdown = async (why: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`shutting down (${why})`);
    const force = setTimeout(() => process.exit(0), 15_000);
    try {
      await bot.stop(why);
    } catch (err) {
      log.error('error while stopping:', err);
    }
    clearTimeout(force);
    process.exit(0);
  };

  process.on('message', (m: { type?: string }) => {
    if (m?.type === 'shutdown') void shutdown('supervisor request');
  });
  process.on('disconnect', () => void shutdown('supervisor gone'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection:', reason));
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception:', err);
    bot.fail(err);
    setTimeout(() => process.exit(1), 500);
  });

  try {
    await bot.start();
  } catch (err) {
    log.error('failed to start:', err);
    bot.fail(err);
    setTimeout(() => process.exit(2), 500);
  }
}
