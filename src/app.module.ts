import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configuration } from './config/configuration';
import { validateEnvironment } from './config/validate';
import { HealthController } from './http/health.controller';
import { TelegramModule } from './telegram/telegram.module';
import { VeeamHttpModule } from './veeam/http.module';

/**
 * Telegram-only build: the service watches Veeam and reports what changed.
 * There is no browser client, so there is no session handling and no
 * per-feature read endpoint — only the health probe and the Telegram surface.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate: validateEnvironment }),
    VeeamHttpModule,
    TelegramModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
