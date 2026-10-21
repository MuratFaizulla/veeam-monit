import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LiveModule } from '../live/live.module';
import { TelegramLiveService } from '../live/live.service';
import { LiveSnapshotsService } from '../live/snapshots.service';
import { TelegramModule } from '../telegram/telegram.module';
import { TelegramService } from '../telegram/telegram.service';
import { TelegramStateStore } from '../telegram/state.store';
import { EstateModule } from '../estate/estate.module';
import { RepositoryReports } from '../estate/repository-reports';
import { ServerEstates } from '../estate/server-estates';
import { MONITOR } from './monitor';
import { MonitorService } from './monitor.service';

/**
 * The monitor cycle: poll every Veeam server, turn what changed into events,
 * refresh the live slots for the Selected server.
 *
 * Exports `MONITOR` and nothing else. What the rest of the service may ask of
 * the monitor is that interface; the class behind it, with everything it
 * depends on, stays in here.
 */
@Module({
  imports: [EstateModule, LiveModule, TelegramModule],
  providers: [
    {
      // Built by hand because its clock is a plain function, which Nest cannot
      // resolve from design-time metadata and the tests hand in.
      provide: MonitorService,
      inject: [ConfigService, ServerEstates, TelegramService, TelegramStateStore, TelegramLiveService, LiveSnapshotsService, RepositoryReports],
      useFactory: (
        config: ConfigService,
        estates: ServerEstates,
        telegram: TelegramService,
        store: TelegramStateStore,
        live: TelegramLiveService,
        snapshots: LiveSnapshotsService,
        reports: RepositoryReports,
      ) => new MonitorService(config, estates, telegram, store, live, snapshots, reports),
    },
    { provide: MONITOR, useExisting: MonitorService },
  ],
  exports: [MONITOR],
})
export class MonitorModule {}
