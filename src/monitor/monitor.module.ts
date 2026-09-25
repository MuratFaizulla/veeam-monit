import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { TelegramModule } from '../telegram/telegram.module';
import { VeeamModule } from '../veeam/veeam.module';
import { EstateModule } from './estate.module';
import { MONITOR } from './monitor';
import { MonitorService } from './monitor.service';

/**
 * The monitor cycle: poll Veeam, turn what changed into events, refresh the
 * live slots.
 *
 * Exports `MONITOR` and nothing else. What the rest of the service may ask of
 * the monitor is that interface; the class behind it, with everything it
 * depends on, stays in here.
 */
@Module({
  imports: [VeeamModule, EstateModule, LiveModule, TelegramModule],
  providers: [MonitorService, { provide: MONITOR, useExisting: MonitorService }],
  exports: [MONITOR],
})
export class MonitorModule {}
