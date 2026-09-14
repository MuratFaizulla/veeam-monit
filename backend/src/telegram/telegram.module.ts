import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { VeeamHttpModule } from '../veeam/veeam-http.module';
import { TelegramController } from './telegram.controller';
import { TelegramLiveService } from './telegram-live.service';
import { TelegramMonitorService } from './telegram-monitor.service';
import { TelegramRoutingService } from './telegram-routing.service';
import { TelegramService } from './telegram.service';
import { TelegramStateStore } from './telegram-state.store';
import { TelegramTopicsService } from './telegram-topics.service';
import { TelegramTransportService } from './telegram-transport.service';
import { VeeamMonitorAuthService } from './veeam-monitor-auth.service';

@Module({
  imports: [VeeamHttpModule],
  controllers: [TelegramController],
  providers: [
    {
      provide: TelegramStateStore,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new TelegramStateStore(config.getOrThrow<AppConfig['telegram']>('telegram').stateFile),
    },
    {
      // Built by hand because the optional transport seam the tests use is a
      // plain function, which Nest cannot resolve from design-time metadata.
      provide: TelegramTransportService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new TelegramTransportService(config),
    },
    TelegramTopicsService,
    TelegramLiveService,
    TelegramRoutingService,
    TelegramService,
    TelegramMonitorService,
    VeeamMonitorAuthService,
  ],
})
export class TelegramModule {}
