import { Module } from '@nestjs/common';
import { VeeamHttpService } from './http.service';
import { VeeamInventoryService } from './inventory.service';
import { VeeamMonitorAuthService } from './monitor-auth.service';

/**
 * Talking to Veeam: the HTTP client, the monitor account's token, and the
 * Inventory of names behind ids.
 *
 * Depends on nothing of ours. Everything that reads the estate imports this.
 */
@Module({
  providers: [VeeamHttpService, VeeamMonitorAuthService, VeeamInventoryService],
  exports: [VeeamHttpService, VeeamMonitorAuthService, VeeamInventoryService],
})
export class VeeamModule {}
