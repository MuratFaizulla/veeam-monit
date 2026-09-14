import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VeeamModule } from '../veeam/veeam.module';
import { InfrastructureController } from './infrastructure.controller';
import { InfrastructureService } from './infrastructure.service';

@Module({
  imports: [VeeamModule, AuthModule],
  controllers: [InfrastructureController],
  providers: [InfrastructureService],
  exports: [InfrastructureService],
})
export class InfrastructureModule {}
