import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentSession } from '../auth/auth.guard';
import { VeeamSessionData } from '../auth/session.store';
import { DashboardService, DashboardSummary } from './dashboard.service';

@Controller('dashboard')
@UseGuards(AuthGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  summary(@CurrentSession() session: VeeamSessionData): Promise<DashboardSummary> {
    return this.dashboard.summary(session);
  }
}
