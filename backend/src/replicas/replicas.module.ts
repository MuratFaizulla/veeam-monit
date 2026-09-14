import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VeeamModule } from '../veeam/veeam.module';
import { ReplicasController } from './replicas.controller';
import { ReplicasService } from './replicas.service';

@Module({
  imports: [VeeamModule, AuthModule],
  controllers: [ReplicasController],
  providers: [ReplicasService],
})
export class ReplicasModule {}
