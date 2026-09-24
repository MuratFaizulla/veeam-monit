import { Module } from '@nestjs/common';
import { VeeamModule } from '../veeam/veeam.module';
import { BackupEvidenceService } from './backup-evidence.service';
import { JobQueryService } from './job-query.service';

/**
 * Reading the Veeam estate: the Evidence scan, and the on-demand reads behind
 * a Job card, the Summary and the running sessions.
 *
 * Its own module because two others read it — the live slots and the monitor —
 * and neither should have to import the other to get at it.
 */
@Module({
  imports: [VeeamModule],
  providers: [BackupEvidenceService, JobQueryService],
  exports: [BackupEvidenceService, JobQueryService],
})
export class EstateModule {}
