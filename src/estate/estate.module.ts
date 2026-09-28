import { Module } from '@nestjs/common';
import { VeeamModule } from '../veeam/veeam.module';
import { ServerEstates } from './server-estates';

/**
 * What the estate establishes, beyond what Veeam says in one answer: for every
 * server, the Evidence scan, and the on-demand answers behind a Job card and
 * the Summary. Every request they make goes through that server's estate
 * reader in VeeamModule.
 *
 * The monitor imports it; the live slots do not, and are handed the Evidence
 * the monitor refreshed rather than reaching for it.
 */
@Module({
  imports: [VeeamModule],
  providers: [ServerEstates],
  exports: [ServerEstates],
})
export class EstateModule {}
