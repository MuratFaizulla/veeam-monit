import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentSession } from '../auth/auth.guard';
import { VeeamSessionData } from '../auth/session.store';
import { VeeamClientService } from './veeam-client.service';

/** UI hints only. Veeam still authorizes every request with the user's token. */
@Controller('access')
@UseGuards(AuthGuard)
export class AccessController {
  constructor(private readonly veeam: VeeamClientService) {}

  @Get()
  async describe(@CurrentSession() session: VeeamSessionData) {
    const [license, analyzer, malware] = await Promise.all([
      this.veeam.getOptional(session, '/api/v1/license'),
      this.veeam.getOptional(session, '/api/v1/securityAnalyzer/bestPractices'),
      this.veeam.getOptional(session, '/api/v1/malwareDetection/events', { skip: 0, limit: 1 }),
    ]);
    return { license: license !== null, security: analyzer !== null || malware !== null };
  }
}
