import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentSession } from '../auth/auth.guard';
import { VeeamSessionData } from '../auth/session.store';
import { InfrastructureService, InfrastructureView } from './infrastructure.service';

@Controller('infrastructure')
@UseGuards(AuthGuard)
export class InfrastructureController {
  constructor(private readonly infrastructure: InfrastructureService) {}

  @Get()
  overview(@CurrentSession() session: VeeamSessionData): Promise<InfrastructureView> {
    return this.infrastructure.overview(session);
  }
}
