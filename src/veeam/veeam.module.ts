import { Module } from '@nestjs/common';
import { VeeamServers } from './servers';

/**
 * Talking to Veeam: for every configured server, the HTTP client, the monitor
 * account's token, the estate reader every read goes through, and the
 * Inventory of names behind ids.
 *
 * Depends on nothing of ours. Everything that reads the estate imports this.
 */
@Module({
  providers: [VeeamServers],
  exports: [VeeamServers],
})
export class VeeamModule {}
