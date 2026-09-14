import { Injectable, NotFoundException } from '@nestjs/common';
import { VeeamSessionData } from '../auth/session.store';
import { VeeamClientService } from '../veeam/veeam-client.service';
import { VeeamBackup, VeeamBackupObject, VeeamRestorePoint } from '../veeam/veeam.types';

export interface BackupView {
  id: string;
  name: string;
  jobId: string | null;
  platform: string | null;
  type: string | null;
  repositoryId: string | null;
  creationTime: string | null;
}

export interface BackupObjectView {
  id: string;
  name: string;
  type: string | null;
  platform: string | null;
  path: string | null;
  restorePointsCount: number | null;
}

export interface RestorePointView {
  id: string;
  name: string | null;
  backupId: string | null;
  backupObjectId: string | null;
  creationTime: string | null;
  type: string | null;
  malwareStatus: string | null;
}

export interface BackupsView {
  available: boolean;
  items: BackupView[];
}

export interface BackupObjectsView {
  available: boolean;
  items: BackupObjectView[];
}

export interface BackupObjectDetails {
  object: BackupObjectView;
  restorePoints: { available: boolean; items: RestorePointView[] };
}

const BACKUPS = '/api/v1/backups';
const BACKUP_OBJECTS = '/api/v1/backupObjects';

@Injectable()
export class BackupsService {
  constructor(private readonly veeam: VeeamClientService) {}

  async listBackups(session: VeeamSessionData): Promise<BackupsView> {
    const backups = await this.veeam.collection<VeeamBackup>(session, BACKUPS);

    return {
      available: backups !== null,
      items: (backups ?? [])
        .filter((backup): backup is VeeamBackup & { id: string } => Boolean(backup.id))
        .map((backup) => ({
          id: backup.id,
          name: backup.name ?? '—',
          jobId: backup.jobId ?? null,
          platform: backup.platformName ?? null,
          type: backup.backupType ?? backup.policyTag ?? null,
          repositoryId: backup.repositoryId ?? null,
          creationTime: backup.creationTime ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async listObjects(session: VeeamSessionData): Promise<BackupObjectsView> {
    const objects = await this.veeam.collection<VeeamBackupObject>(session, BACKUP_OBJECTS);

    return {
      available: objects !== null,
      items: (objects ?? [])
        .filter((object): object is VeeamBackupObject & { id: string } => Boolean(object.id))
        .map((object) => this.toObjectView(object))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async objectDetails(session: VeeamSessionData, objectId: string): Promise<BackupObjectDetails> {
    const raw = await this.veeam.get<VeeamBackupObject>(session, `${BACKUP_OBJECTS}/${encodeURIComponent(objectId)}`);
    const object = raw.id ? this.toObjectView({ ...raw, id: raw.id }) : null;

    if (!object) {
      throw new NotFoundException(`Backup object ${objectId} was not found`);
    }

    // This endpoint has no paging/query parameters in 1.2-rev1. Its points
    // do not carry backupObjectId; the path supplies the association.
    const result = await this.veeam.getOptional<{ data: VeeamRestorePoint[] }>(
      session, `${BACKUP_OBJECTS}/${encodeURIComponent(objectId)}/restorePoints`,
    );
    const points = result?.data ?? null;

    const items = (points ?? [])
      .map((point) => this.toRestorePointView({ ...point, backupObjectId: objectId }))
      .sort((a, b) => this.time(b.creationTime) - this.time(a.creationTime));

    return {
      object,
      restorePoints: { available: points !== null, items },
    };
  }

  private toObjectView(object: VeeamBackupObject & { id: string }): BackupObjectView {
    return {
      id: object.id,
      name: object.name ?? '—',
      type: object.type ?? object.viType ?? null,
      platform: object.platformName ?? null,
      path: object.path ?? null,
      restorePointsCount: object.restorePointsCount ?? null,
    };
  }

  private toRestorePointView(point: VeeamRestorePoint): RestorePointView {
    return {
      id: point.id ?? '',
      name: point.name ?? null,
      backupId: point.backupId ?? null,
      backupObjectId: point.backupObjectId ?? null,
      creationTime: point.creationTime ?? null,
      type: point.type ?? null,
      malwareStatus: point.malwareStatus ?? null,
    };
  }

  private time(value: string | null): number {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
