import { Module } from '@nestjs/common';
import { MonitorModule } from '../monitor/monitor.module';
import { TelegramAdminGuard, TelegramEnabledGuard, TelegramWebhookGuard } from './access.guard';
import { TelegramController } from './telegram.controller';
import { TelegramModule } from './telegram.module';
import { TelegramUpdatesService } from './updates.service';

/**
 * The bot's ear and the HTTP surface: Updates from Telegram, commands and
 * buttons, the webhook, and the admin endpoints.
 *
 * Separate from delivery because it is the one part that asks the monitor
 * anything. With it inside the delivery module, the monitor — which sends
 * through delivery — and the ear — which asks the monitor — made one cycle,
 * and the whole service had to be a single module to hold it.
 */
@Module({
  imports: [TelegramModule, MonitorModule],
  controllers: [TelegramController],
  providers: [TelegramUpdatesService, TelegramAdminGuard, TelegramWebhookGuard, TelegramEnabledGuard],
})
export class TelegramUpdatesModule {}
