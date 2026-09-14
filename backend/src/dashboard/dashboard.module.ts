import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InfrastructureModule } from '../infrastructure/infrastructure.module';
import { JobsModule } from '../jobs/jobs.module';
import { VeeamModule } from '../veeam/veeam.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [JobsModule, VeeamModule, AuthModule, InfrastructureModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
