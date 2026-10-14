import { Module } from '@nestjs/common';
import { VeeamModule } from '../veeam/veeam.module';
import { JobReports } from './job-reports';
import { ReportPrinter } from './report-printer';
import { RepositoryReports } from './repository-reports';
import { ServerEstates } from './server-estates';

/**
 * What the estate establishes, beyond what Veeam says in one answer: for every
 * server, the Evidence scan, the on-demand answers behind a Job card and the
 * Summary, and the Job report; across every server, the Repository report.
 * Every request they make goes through that server's estate reader in VeeamModule.
 *
 * The monitor imports it; the live slots do not, and are handed the Evidence
 * the monitor refreshed rather than reaching for it.
 */
@Module({
  imports: [VeeamModule],
  providers: [ServerEstates, ReportPrinter, RepositoryReports, JobReports],
  exports: [ServerEstates, RepositoryReports, JobReports],
})
export class EstateModule {}
