import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { VeeamHttpModule } from '../veeam/http.module';
import { VeeamMonitorAuthService } from '../veeam/monitor-auth.service';
import { BackupEvidenceService } from '../monitor/backup-evidence.service';
import { MonitorService } from '../monitor/monitor.service';
import { TelegramLiveService } from '../live/live.service';
import {
  TelegramAdminGuard,
  TelegramEnabledGuard,
  TelegramWebhookGuard,
} from './access.guard';
import { TelegramRoutingService } from './routing.service';
import { TelegramStateStore } from './state.store';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { TelegramTopicsService } from './topics.service';
import { TelegramTransportService } from './transport.service';
import { TelegramUpdatesService } from './updates.service';

/**
 * One Nest module across four folders, on purpose.
 *
 * The folders separate subjects; this separates nothing, it wires. And the
 * graph it wires is genuinely mutual: the monitor sends through the Telegram
 * delivery module, and the Telegram controller drives the monitor. Splitting it
 * along the folders would not untangle that — it would express it as a pair of
 * modules referring to each other through forwardRef, which is the same cycle
 * with a ceremony around it.
 */
@Module({
  imports: [VeeamHttpModule],
  controllers: [TelegramController],
  providers: [
    {
      provide: TelegramStateStore,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new TelegramStateStore(
          config.getOrThrow<AppConfig['telegram']>('telegram').stateFile,
          config.getOrThrow<AppConfig['telegram']>('telegram').chatIds,
        ),
    },
    {
      // Built by hand because the optional transport seam the tests use is a
      // plain function, which Nest cannot resolve from design-time metadata.
      provide: TelegramTransportService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new TelegramTransportService(config),
    },

    // telegram/ — delivery and the bot's connection
    TelegramTopicsService,
    TelegramRoutingService,
    TelegramService,
    TelegramUpdatesService,
    TelegramAdminGuard,
    TelegramWebhookGuard,
    TelegramEnabledGuard,

    // live/ — the always-current status messages
    TelegramLiveService,

    // monitor/ and veeam/ — what is being watched
    MonitorService,
    BackupEvidenceService,
    VeeamMonitorAuthService,
  ],
})
export class TelegramModule {}
