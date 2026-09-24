import { Module } from '@nestjs/common';
import { EstateModule } from '../monitor/estate.module';
import { TelegramModule } from '../telegram/telegram.module';
import { VeeamModule } from '../veeam/veeam.module';
import { TelegramLiveService } from './live.service';
import { LiveSnapshotsService } from './snapshots.service';

/**
 * The Live slots: what each one says after a cycle, and keeping its one
 * message current in every chat.
 *
 * Reads the estate and sends through Telegram; knows nothing of the monitor
 * that drives it.
 */
@Module({
  imports: [VeeamModule, EstateModule, TelegramModule],
  providers: [TelegramLiveService, LiveSnapshotsService],
  exports: [TelegramLiveService, LiveSnapshotsService],
})
export class LiveModule {}
