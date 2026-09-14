import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VeeamModule } from '../veeam/veeam.module';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';

@Module({
  imports: [VeeamModule, AuthModule],
  controllers: [ComplianceController],
  providers: [ComplianceService],
})
export class ComplianceModule {}
