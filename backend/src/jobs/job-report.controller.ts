import { Controller, DefaultValuePipe, Get, Header, Param, ParseIntPipe, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard, CurrentSession } from '../auth/auth.guard';
import { VeeamSessionData } from '../auth/session.store';
import { JobReportService } from './job-report.service';
import { jobReportCsv, jobReportHtml, sessionReportHtml } from './job-report.export';

@Controller('jobs/:id')
@UseGuards(AuthGuard)
export class JobReportController {
  constructor(private readonly reports: JobReportService) {}
  private days(value: number) { return Math.min(90, Math.max(1, value)); }

  @Get('report')
  report(@CurrentSession() session: VeeamSessionData, @Param('id') id: string,
    @Query('days', new DefaultValuePipe(7), ParseIntPipe) days: number) {
    return this.reports.report(session, id, this.days(days));
  }

  @Get('report.csv')
  async csv(@CurrentSession() session: VeeamSessionData, @Param('id') id: string,
    @Query('days', new DefaultValuePipe(7), ParseIntPipe) days: number, @Res({ passthrough: true }) response: Response) {
    const report = await this.reports.report(session, id, this.days(days));
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="veeam-job-report.csv"');
    return jobReportCsv(report);
  }

  @Get('report.html')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'")
  async html(@CurrentSession() session: VeeamSessionData, @Param('id') id: string,
    @Query('days', new DefaultValuePipe(7), ParseIntPipe) days: number) {
    return jobReportHtml(await this.reports.report(session, id, this.days(days)));
  }

  @Get('sessions/:sessionId/report')
  session(@CurrentSession() session: VeeamSessionData, @Param('id') id: string, @Param('sessionId') sessionId: string) {
    return this.reports.sessionReport(session, id, sessionId);
  }

  @Get('sessions/:sessionId/report.html')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'")
  async sessionHtml(@CurrentSession() session: VeeamSessionData, @Param('id') id: string, @Param('sessionId') sessionId: string) {
    return sessionReportHtml(await this.reports.sessionReport(session, id, sessionId));
  }

  @Get('sessions/:sessionId/tasks/:taskId/logs')
  taskLogs(@CurrentSession() session: VeeamSessionData, @Param('id') id: string,
    @Param('sessionId') sessionId: string, @Param('taskId') taskId: string) {
    return this.reports.taskLogs(session, id, sessionId, taskId);
  }
}
