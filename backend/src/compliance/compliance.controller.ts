import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentSession } from '../auth/auth.guard';
import { VeeamSessionData } from '../auth/session.store';
import { ComplianceService, LicenseView, SecurityView } from './compliance.service';

@Controller()
@UseGuards(AuthGuard)
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get('license')
  license(@CurrentSession() session: VeeamSessionData): Promise<LicenseView> {
    return this.compliance.license(session);
  }

  @Get('security')
  security(@CurrentSession() session: VeeamSessionData): Promise<SecurityView> {
    return this.compliance.security(session);
  }
}
