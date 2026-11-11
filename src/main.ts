import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { join } from 'path';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { FileLogger } from './logging/file-logger';
import { DOCS_PATH, mountOpenApi } from './http/openapi';

async function bootstrap(): Promise<void> {
  const logFile = process.env.LOG_FILE ?? join(process.cwd(), 'logs', 'backend.log');
  const app = await NestFactory.create(AppModule, { logger: new FileLogger(logFile) });
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');

  // After the prefix, so the document describes the paths callers actually use.
  const docs = config.getOrThrow<boolean>('docs');
  if (docs) mountOpenApi(app);

  // In a container this process is PID 1, and the kernel hands PID 1 no signal
  // it has not asked for: `docker compose stop` waited its ten seconds and
  // killed it, every time. Asked for here, a stop closes the modules — the
  // state file is written, the queue let go — and ends at once, without
  // waiting out a long poll still open to Telegram.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void app
        .close()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
  }

  const port = config.getOrThrow<number>('port');
  await app.listen(port);

  const veeam = config.getOrThrow<AppConfig['veeam']>('veeam');
  const telegram = config.getOrThrow<AppConfig['telegram']>('telegram');
  const logger = new Logger('Bootstrap');
  logger.log(
    `Listening on http://localhost:${port}/api — Veeam: ${veeam.servers
      .map((server) => `${server.name} ${server.baseUrl}`)
      .join(', ')}`,
  );
  logger.log(
    docs
      ? `API docs on http://localhost:${port}/${DOCS_PATH}`
      : 'API docs disabled (API_DOCS=false)',
  );
  logger.log(`Telegram routing mode: ${telegram.routingMode}, state: ${telegram.stateFile}`);
  logger.log(
    telegram.live
      ? `Live topics: ${Object.values(telegram.liveTopics)
          .map((name) => `"${name}"`)
          .join(', ')}`
      : 'Live topics disabled (TELEGRAM_LIVE=false)',
  );
  logger.log(`Writing logs to ${logFile}`);
}

void bootstrap();
