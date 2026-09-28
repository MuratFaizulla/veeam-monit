import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { TelegramModule } from '../telegram/telegram.module';
import { EstateModule } from '../estate/estate.module';
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
  providers: [MonitorService, { provide: MONITOR, useExisting: MonitorService }],
  exports: [MONITOR],
})
export class MonitorModule {}
