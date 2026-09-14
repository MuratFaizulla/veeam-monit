import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VeeamModule } from '../veeam/veeam.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { JobReportService } from './job-report.service';
import { JobReportController } from './job-report.controller';

@Module({
  imports: [VeeamModule, AuthModule],
  controllers: [JobsController, JobReportController],
  providers: [JobsService, JobReportService],
  exports: [JobsService],
})
export class JobsModule {}
