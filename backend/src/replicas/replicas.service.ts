import { Injectable, NotFoundException } from '@nestjs/common';
import { VeeamSessionData } from '../auth/session.store';
import { VeeamClientService } from '../veeam/veeam-client.service';
import { VeeamReplica, VeeamReplicaRestorePoint } from '../veeam/veeam.types';

export interface ReplicaView {
  id: string;
  name: string;
  jobId: string | null;
  jobName: string | null;
  platform: string | null;
  state: string | null;
  hostName: string | null;
  originalVmName: string | null;
  replicaVmName: string | null;
  restorePointsCount: number | null;
  latestRestorePointTime: string | null;
  /** Minutes since the latest restore point — the practical lag of the replica. */
  lagMinutes: number | null;
}

export interface ReplicaRestorePointView {
  id: string;
  name: string | null;
  replicaId: string | null;
  creationTime: string | null;
  type: string | null;
  state: string | null;
}

export interface ReplicasView {
  available: boolean;
  items: ReplicaView[];
}

export interface ReplicaDetails {
  replica: ReplicaView;
  restorePoints: { available: boolean; items: ReplicaRestorePointView[] };
}

const REPLICAS = '/api/v1/replicas';

@Injectable()
export class ReplicasService {
  constructor(private readonly veeam: VeeamClientService) {}

  async list(session: VeeamSessionData): Promise<ReplicasView> {
    const [replicas, points] = await Promise.all([
      this.veeam.collection<VeeamReplica>(session, REPLICAS),
      this.veeam.collection<VeeamReplicaRestorePoint>(session, '/api/v1/replicaPoints'),
    ]);

    return {
      available: replicas !== null,
      items: (replicas ?? [])
        .filter((replica): replica is VeeamReplica & { id: string } => Boolean(replica.id))
        .map((replica) => this.withPoints(this.toView(replica), points?.filter((point) => point.replicaId === replica.id) ?? null))
        .sort((a, b) => (b.lagMinutes ?? -1) - (a.lagMinutes ?? -1) || a.name.localeCompare(b.name)),
    };
  }

  async details(session: VeeamSessionData, replicaId: string): Promise<ReplicaDetails> {
    const raw = await this.veeam.get<VeeamReplica>(session, `${REPLICAS}/${encodeURIComponent(replicaId)}`);
    const replica = raw.id ? this.toView({ ...raw, id: raw.id }) : null;

    if (!replica) {
      throw new NotFoundException(`Replica ${replicaId} was not found`);
    }

    const points = await this.veeam.collection<VeeamReplicaRestorePoint>(
      session,
      `${REPLICAS}/${encodeURIComponent(replicaId)}/replicaPoints`,
    );

    const items = (points ?? [])
      .filter((point) => !point.replicaId || point.replicaId === replicaId)
      .map((point) => ({
        id: point.id ?? '',
        name: point.name ?? null,
        replicaId: point.replicaId ?? replicaId,
        creationTime: point.creationTime ?? null,
        type: point.type ?? null,
        state: point.state ?? null,
      }))
      .sort((a, b) => this.time(b.creationTime) - this.time(a.creationTime));

    return {
      replica: this.withPoints(replica, points),
      restorePoints: { available: points !== null, items },
    };
  }

  private withPoints(replica: ReplicaView, points: VeeamReplicaRestorePoint[] | null): ReplicaView {
    if (points === null) return replica;
    const latest = points.map((point) => point.creationTime).filter((time): time is string => Boolean(time))
      .sort((a, b) => this.time(b) - this.time(a))[0] ?? null;
    return { ...replica, restorePointsCount: points.length, latestRestorePointTime: latest,
      lagMinutes: latest && this.time(latest) > 0 ? Math.max(0, Math.round((Date.now() - this.time(latest)) / 60000)) : null };
  }

  private toView(replica: VeeamReplica & { id: string }): ReplicaView {
    const latest = replica.latestRestorePointTime ?? null;
    const latestMs = latest ? Date.parse(latest) : NaN;

    return {
      id: replica.id,
      name: replica.name ?? replica.replicaVmName ?? replica.originalVmName ?? '—',
      jobId: replica.jobId ?? null,
      jobName: replica.jobName ?? null,
      platform: replica.platformName ?? null,
      state: replica.state ?? replica.status ?? null,
      hostName: replica.hostName ?? null,
      originalVmName: replica.originalVmName ?? null,
      replicaVmName: replica.replicaVmName ?? null,
      restorePointsCount: replica.restorePointsCount ?? null,
      latestRestorePointTime: latest,
      lagMinutes: Number.isFinite(latestMs)
        ? Math.max(0, Math.round((Date.now() - latestMs) / 60000))
        : null,
    };
  }

  private time(value: string | null): number {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
