import { Injectable } from '@nestjs/common';
import { VeeamSessionData } from '../auth/session.store';
import { InfrastructureService, RepositoryView } from '../infrastructure/infrastructure.service';
import { JobStatus, JobSummary, SessionSummary } from '../jobs/jobs.model';
import { JobsService } from '../jobs/jobs.service';
import { VeeamClientService } from '../veeam/veeam-client.service';
import { VeeamApiError } from '../veeam/veeam-api.error';

export interface DashboardSummary {
  available: { jobs: boolean; sessions: boolean };
  server: {
    name: string | null;
    buildVersion: string | null;
    databaseVendor: string | null;
    patches: string[];
  } | null;
  generatedAt: string;
  jobs: {
    total: number;
    byStatus: Record<JobStatus, number>;
    successRate: number | null;
  };
  attention: JobSummary[];
  running: JobSummary[];
  upcoming: JobSummary[];
  recentSessions: SessionSummary[];
  /** Fullest repositories first; empty when the role cannot read them. */
  repositories: RepositoryView[];
}

const EMPTY_COUNTS: Record<JobStatus, number> = {
  running: 0,
  success: 0,
  warning: 0,
  failed: 0,
  disabled: 0,
  idle: 0,
  unknown: 0,
};

@Injectable()
export class DashboardService {
  constructor(
    private readonly jobs: JobsService,
    private readonly veeam: VeeamClientService,
    private readonly infrastructure: InfrastructureService,
  ) {}

  async summary(session: VeeamSessionData): Promise<DashboardSummary> {
    const [jobData, serverInfo, sessionData, infrastructure] = await Promise.all([
      this.optional(this.jobs.list(session)),
      this.veeam.getServerInfo(session),
      this.optional(this.jobs.recentSessions(session, 15)),
      this.infrastructure.overview(session),
    ]);
    const jobs = jobData ?? [];
    const recentSessions = sessionData ?? [];

    const byStatus = { ...EMPTY_COUNTS };
    for (const job of jobs) {
      byStatus[job.status] += 1;
    }

    // Only jobs that actually ran count towards the rate; idle and disabled
    // jobs would otherwise drag a healthy installation down.
    const rated = byStatus.success + byStatus.warning + byStatus.failed;

    return {
      available: { jobs: jobData !== null, sessions: sessionData !== null },
      server: serverInfo
        ? {
            name: serverInfo.name ?? null,
            buildVersion: serverInfo.buildVersion ?? null,
            databaseVendor: serverInfo.databaseVendor ?? null,
            patches: serverInfo.patches ?? [],
          }
        : null,
      generatedAt: new Date().toISOString(),
      jobs: {
        total: jobs.length,
        byStatus,
        successRate: rated > 0 ? Math.round((byStatus.success / rated) * 100) : null,
      },
      attention: jobs
        .filter((job) => job.status === 'failed' || job.status === 'warning')
        .sort((a, b) => this.severity(b) - this.severity(a) || this.time(b.lastRun) - this.time(a.lastRun)),
      running: jobs.filter((job) => job.status === 'running'),
      upcoming: jobs
        .filter((job) => job.nextRun !== null && !job.isDisabled)
        .sort((a, b) => this.time(a.nextRun) - this.time(b.nextRun))
        .slice(0, 5),
      recentSessions,
      repositories: [
        ...infrastructure.repositories.items,
        ...infrastructure.scaleOutRepositories.items,
      ].slice(0, 6),
    };
  }

  private async optional<T>(request: Promise<T>): Promise<T | null> {
    try { return await request; } catch (error) {
      if (error instanceof VeeamApiError && (error.isForbidden || error.isNotFound)) return null;
      throw error;
    }
  }

  private severity(job: JobSummary): number {
    return job.status === 'failed' ? 2 : 1;
  }

  private time(value: string | null): number {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
