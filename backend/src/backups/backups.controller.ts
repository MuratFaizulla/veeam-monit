import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentSession } from '../auth/auth.guard';
import { VeeamSessionData } from '../auth/session.store';
import {
  BackupObjectDetails,
  BackupObjectsView,
  BackupsService,
  BackupsView,
} from './backups.service';

@Controller('backups')
@UseGuards(AuthGuard)
export class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Get()
  list(@CurrentSession() session: VeeamSessionData): Promise<BackupsView> {
    return this.backups.listBackups(session);
  }

  @Get('objects')
  objects(@CurrentSession() session: VeeamSessionData): Promise<BackupObjectsView> {
    return this.backups.listObjects(session);
  }

  @Get('objects/:id')
  objectDetails(
    @CurrentSession() session: VeeamSessionData,
    @Param('id') id: string,
  ): Promise<BackupObjectDetails> {
    return this.backups.objectDetails(session, id);
  }
}
