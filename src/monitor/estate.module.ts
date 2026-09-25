import { Module } from '@nestjs/common';
import { VeeamModule } from '../veeam/veeam.module';
import { BackupEvidenceService } from './backup-evidence.service';
import { JobQueryService } from './job-query.service';

/**
 * What the estate establishes, beyond what Veeam says in one answer: the
 * Evidence scan, and the on-demand answers behind a Job card and the Summary.
 * Every request they make goes through the estate reader in VeeamModule.
 *
 * The monitor imports it; the live slots do not, and are handed the Evidence
 * the monitor refreshed rather than reaching for it.
 */
@Module({
  imports: [VeeamModule],
  providers: [BackupEvidenceService, JobQueryService],
  exports: [BackupEvidenceService, JobQueryService],
})
export class EstateModule {}
