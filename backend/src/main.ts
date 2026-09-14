import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { join } from 'path';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { FileLogger } from './logging/file-logger';
import { TimingInterceptor } from './logging/timing.interceptor';

async function bootstrap(): Promise<void> {
  const logFile = process.env.LOG_FILE ?? join(process.cwd(), 'logs', 'backend.log');
  const app = await NestFactory.create(AppModule, { logger: new FileLogger(logFile) });
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalInterceptors(new TimingInterceptor());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableCors({
    origin: config.getOrThrow<AppConfig['corsOrigins']>('corsOrigins'),
    credentials: true,
  });

  const port = config.getOrThrow<number>('port');
  await app.listen(port);

  const veeam = config.getOrThrow<AppConfig['veeam']>('veeam');
  const logger = new Logger('Bootstrap');
  logger.log(`Listening on http://localhost:${port}/api — Veeam: ${veeam.baseUrl}`);
  logger.log(`Writing logs to ${logFile}`);
}

void bootstrap();
