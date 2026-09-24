import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { TelegramRoutingService } from './routing.service';
import { TelegramStateStore } from './state.store';
import { TelegramService } from './telegram.service';
import { TelegramTopicsService } from './topics.service';
import { TelegramTransportService } from './transport.service';

/**
 * Delivery: getting a message into the right chat and topic, and remembering
 * what that took — the chat registry, the topics, the state file.
 *
 * Depends on nothing of ours, and asks nobody anything. It used to be the one
 * module the whole service was wired in, because the ear that drives the
 * monitor lived here too and the monitor sends through here: splitting along
 * the folders would have been a cycle. The ear now asks the monitor through
 * `MONITOR` and lives in `TelegramUpdatesModule`, so this is a leaf that the
 * live slots, the monitor and the ear all import.
 */
@Module({
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
    TelegramTopicsService,
    TelegramRoutingService,
    TelegramService,
  ],
  exports: [
    TelegramStateStore,
    TelegramTransportService,
    TelegramTopicsService,
    TelegramRoutingService,
    TelegramService,
  ],
})
export class TelegramModule {}
