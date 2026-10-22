import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { VeeamModule } from '../veeam/veeam.module';
import { EstateAnswers } from './estate-answers';
import { JobReports } from './job-reports';
import { PointsReports } from './points-reports';
import { ReportPrinter } from './report-printer';
import { RepositoryReports } from './repository-reports';
import { ServerEstates } from './server-estates';

/**
 * What the estate establishes, beyond what Veeam says in one answer: for every
 * server, the Evidence scan, the on-demand answers behind a Job card and the
 * Summary, and the Job report; across every server, the Repository report.
 * Every request they make goes through that server's estate reader in VeeamModule.
 *
 * The answers to the commands are `EstateAnswers`, which the bot's ear asks
 * directly: which server a question is about is read from the state file
 * (TelegramModule), not from the monitor. The monitor imports the rest; the
 * live slots import nothing of it, and are handed the Evidence the monitor
 * refreshed rather than reaching for it.
 */
@Module({
  imports: [VeeamModule, TelegramModule],
  providers: [ServerEstates, ReportPrinter, RepositoryReports, JobReports, PointsReports, EstateAnswers],
  exports: [ServerEstates, RepositoryReports, EstateAnswers],
})
export class EstateModule {}
