import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configuration, validateEnvironment } from './config/configuration';
import { HealthController } from './http/health.controller';
import { EstateModule } from './monitor/estate.module';
import { LiveModule } from './live/live.module';
import { MonitorModule } from './monitor/monitor.module';
import { TelegramModule } from './telegram/telegram.module';
import { TelegramUpdatesModule } from './telegram/updates.module';
import { VeeamModule } from './veeam/veeam.module';

/**
 * Telegram-only build: the service watches Veeam and reports what changed.
 * There is no browser client, so there is no session handling and no
 * per-feature read endpoint — only the health probe and the Telegram surface.
 *
 * One module per subject, and every import points one way:
 *
 *   Veeam ← Estate ← Monitor ← TelegramUpdates
 *   Veeam ← Live ← Monitor
 *   Telegram (delivery) ← Live, Monitor, TelegramUpdates
 *
 * Listed in that order. Importing TelegramUpdatesModule alone would pull in
 * the rest; they are named here so the shape of the service is readable in one
 * place. test/architecture.test.cjs fails if an import ever points backwards.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate: validateEnvironment }),
    VeeamModule,
    TelegramModule,
    EstateModule,
    LiveModule,
    MonitorModule,
    TelegramUpdatesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
