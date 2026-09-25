import { Module } from '@nestjs/common';
import { VeeamEstateReader } from './estate-reader.service';
import { VeeamHttpService } from './http.service';
import { VeeamInventoryService } from './inventory.service';
import { VeeamMonitorAuthService } from './monitor-auth.service';

/**
 * Talking to Veeam: the HTTP client, the monitor account's token, the estate
 * reader every read goes through, and the Inventory of names behind ids.
 *
 * Depends on nothing of ours. Everything that reads the estate imports this.
 */
@Module({
  providers: [VeeamHttpService, VeeamMonitorAuthService, VeeamEstateReader, VeeamInventoryService],
  exports: [VeeamHttpService, VeeamMonitorAuthService, VeeamEstateReader, VeeamInventoryService],
})
export class VeeamModule {}
