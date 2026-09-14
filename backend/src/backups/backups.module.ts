import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VeeamModule } from '../veeam/veeam.module';
import { BackupsController } from './backups.controller';
import { BackupsService } from './backups.service';

@Module({
  imports: [VeeamModule, AuthModule],
  controllers: [BackupsController],
  providers: [BackupsService],
})
export class BackupsModule {}
