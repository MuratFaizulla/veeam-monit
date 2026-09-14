import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentSession } from '../auth/auth.guard';
import { VeeamSessionData } from '../auth/session.store';
import { ReplicaDetails, ReplicasService, ReplicasView } from './replicas.service';

@Controller('replicas')
@UseGuards(AuthGuard)
export class ReplicasController {
  constructor(private readonly replicas: ReplicasService) {}

  @Get()
  list(@CurrentSession() session: VeeamSessionData): Promise<ReplicasView> {
    return this.replicas.list(session);
  }

  @Get(':id')
  details(
    @CurrentSession() session: VeeamSessionData,
    @Param('id') id: string,
  ): Promise<ReplicaDetails> {
    return this.replicas.details(session, id);
  }
}
