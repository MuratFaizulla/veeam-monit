import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VeeamClientService } from './veeam-client.service';
import { VeeamHttpModule } from './veeam-http.module';
import { AccessController } from './access.controller';

@Module({
  imports: [VeeamHttpModule, AuthModule],
  providers: [VeeamClientService],
  controllers: [AccessController],
  exports: [VeeamClientService],
})
export class VeeamModule {}
