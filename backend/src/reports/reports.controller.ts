import {
  Controller,
  DefaultValuePipe,
  Get,
  Header,
  ParseIntPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard, CurrentSession } from '../auth/auth.guard';
import { VeeamSessionData } from '../auth/session.store';
import { fileStamp } from './csv';
import { renderSummaryHtml } from './report.html';
import { ReportsService, ReportSummary } from './reports.service';

/** Clamp for the reporting period, in days. */
const MIN_DAYS = 1;
const MAX_DAYS = 90;

@Controller('reports')
@UseGuards(AuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('summary')
  summary(
    @CurrentSession() session: VeeamSessionData,
    @Query('days', new DefaultValuePipe(7), ParseIntPipe) days: number,
  ): Promise<ReportSummary> {
    return this.reports.summary(session, this.clampDays(days));
  }

  @Get('summary.html')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async summaryHtml(
    @CurrentSession() session: VeeamSessionData,
    @Query('days', new DefaultValuePipe(7), ParseIntPipe) days: number,
  ): Promise<string> {
    return renderSummaryHtml(await this.reports.summary(session, this.clampDays(days)));
  }

  @Get('jobs.csv')
  async jobsCsv(
    @CurrentSession() session: VeeamSessionData,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    this.asAttachment(response, `veeam-jobs-${fileStamp()}.csv`);
    return this.reports.jobsCsv(session);
  }

  @Get('sessions.csv')
  async sessionsCsv(
    @CurrentSession() session: VeeamSessionData,
    @Query('days', new DefaultValuePipe(7), ParseIntPipe) days: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const period = this.clampDays(days);
    this.asAttachment(response, `veeam-sessions-${period}d-${fileStamp()}.csv`);
    return this.reports.sessionsCsv(session, period);
  }

  @Get('repositories.csv')
  async repositoriesCsv(
    @CurrentSession() session: VeeamSessionData,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    this.asAttachment(response, `veeam-repositories-${fileStamp()}.csv`);
    return this.reports.repositoriesCsv(session);
  }

  private asAttachment(response: Response, filename: string): void {
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  }

  private clampDays(days: number): number {
    return Math.min(Math.max(days, MIN_DAYS), MAX_DAYS);
  }
}
