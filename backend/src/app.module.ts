import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { BackupsModule } from './backups/backups.module';
import { ComplianceModule } from './compliance/compliance.module';
import { configuration } from './config/configuration';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthController } from './health.controller';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { JobsModule } from './jobs/jobs.module';
import { ReplicasModule } from './replicas/replicas.module';
import { ReportsModule } from './reports/reports.module';
import { VeeamHttpModule } from './veeam/veeam-http.module';
import { VeeamModule } from './veeam/veeam.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    AuthModule,
    VeeamHttpModule,
    VeeamModule,
    JobsModule,
    DashboardModule,
    InfrastructureModule,
    BackupsModule,
    ReplicasModule,
    ComplianceModule,
    ReportsModule,
    TelegramModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
