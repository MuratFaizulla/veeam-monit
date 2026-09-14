import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentSession } from '../auth/auth.guard';
import { VeeamSessionData } from '../auth/session.store';
import { JobDetails, JobSummary, SessionSummary } from './jobs.model';
import { JobsService } from './jobs.service';

@Controller('jobs')
@UseGuards(AuthGuard)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  list(@CurrentSession() session: VeeamSessionData): Promise<JobSummary[]> {
    return this.jobs.list(session);
  }

  @Get(':id')
  details(
    @CurrentSession() session: VeeamSessionData,
    @Param('id') id: string,
  ): Promise<JobDetails> {
    return this.jobs.details(session, id);
  }

  @Get(':id/sessions')
  sessions(
    @CurrentSession() session: VeeamSessionData,
    @Param('id') id: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ): Promise<SessionSummary[]> {
    return this.jobs.sessionsOfJob(session, id, Math.min(Math.max(limit, 1), 100));
  }
}
