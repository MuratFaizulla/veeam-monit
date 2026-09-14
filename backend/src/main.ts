import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { join } from 'path';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { FileLogger } from './logging/file-logger';

async function bootstrap(): Promise<void> {
  const logFile = process.env.LOG_FILE ?? join(process.cwd(), 'logs', 'backend.log');
  const app = await NestFactory.create(AppModule, { logger: new FileLogger(logFile) });
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');

  const port = config.getOrThrow<number>('port');
  await app.listen(port);

  const veeam = config.getOrThrow<AppConfig['veeam']>('veeam');
  const telegram = config.getOrThrow<AppConfig['telegram']>('telegram');
  const logger = new Logger('Bootstrap');
  logger.log(`Listening on http://localhost:${port}/api — Veeam: ${veeam.baseUrl}`);
  logger.log(`Telegram routing mode: ${telegram.routingMode}, state: ${telegram.stateFile}`);
  logger.log(
    telegram.live
      ? `Live topics: "${telegram.liveTopics.health}", "${telegram.liveTopics.running}"`
      : 'Live topics disabled (TELEGRAM_LIVE=false)',
  );
  logger.log(`Writing logs to ${logFile}`);
}

void bootstrap();
