import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { VeeamModule } from '../veeam/veeam.module';
import { TelegramLiveService } from './live.service';
import { LiveSnapshotsService } from './snapshots.service';

/**
 * The Live slots: what each one says after a cycle, and keeping its one
 * message current in every chat.
 *
 * Reads Veeam through the estate reader and sends through Telegram; knows
 * nothing of the monitor that drives it, which hands it the cycle's job list,
 * Working sessions and Evidence.
 */
@Module({
  imports: [VeeamModule, TelegramModule],
  providers: [TelegramLiveService, LiveSnapshotsService],
  exports: [TelegramLiveService, LiveSnapshotsService],
})
export class LiveModule {}
