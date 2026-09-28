import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configuration, validateEnvironment } from './config/configuration';
import { HealthController } from './http/health.controller';
import { EstateModule } from './estate/estate.module';
import { LiveModule } from './live/live.module';
import { MonitorModule } from './monitor/monitor.module';
import { TelegramModule } from './telegram/telegram.module';
import { TelegramUpdatesModule } from './updates/updates.module';
import { VeeamModule } from './veeam/veeam.module';

/**
 * Telegram-only build: the service watches Veeam and reports what changed.
 * There is no browser client, so there is no session handling and no
 * per-feature read endpoint — only the health probe and the Telegram surface.
 *
 * One module per subject, and every import points one way:
 *
 *   Veeam ← Estate ← Monitor ← TelegramUpdates
 *   Live ← Monitor
 *   Telegram (delivery) ← Live, Monitor, TelegramUpdates
 *
 * Listed in that order. Importing TelegramUpdatesModule alone would pull in
 * the rest; they are named here so the shape of the service is readable in one
 * place. Each module is one folder of src/, and the folders are layers:
 * config, then veeam and telegram, then estate, live, monitor and updates.
 * test/architecture.test.cjs fails if an import ever points up or sideways,
 * between modules or between the files of two folders.
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
