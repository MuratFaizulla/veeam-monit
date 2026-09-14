import { Injectable, NotFoundException } from '@nestjs/common';
import { VeeamSessionData } from '../auth/session.store';
import { VeeamClientService } from '../veeam/veeam-client.service';
import { VeeamJob, VeeamJobState, VeeamSession } from '../veeam/veeam.types';
import { JobDetails, JobStatus, JobSummary, RunStats, SessionSummary } from './jobs.model';

@Injectable()
export class JobsService {
  constructor(private readonly veeam: VeeamClientService) {}

  /**
   * Builds the job list from /api/v1/jobs/states alone.
   *
   * The job *configuration* collection (/api/v1/jobs) is deliberately not used
   * here: on this installation it takes 8-10 seconds for 111 jobs, while the
   * states collection answers in ~330 ms and already carries name, type,
   * status, lastRun/lastResult, nextRun, workload and objectsCount. The
   * configuration is only fetched for a single job, on its details page.
   *
   * Older builds without the states path fall back to the slow route.
   */
  async list(session: VeeamSessionData): Promise<JobSummary[]> {
    const states = await this.veeam.getJobStates(session);

    if (states === null) {
      return this.listFromConfiguration(session);
    }

    return states
      .filter((state): state is VeeamJobState & { id: string } => Boolean(state.id))
      .map((state) => this.toSummary({ id: state.id }, state, undefined))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Slow path for builds that do not expose /api/v1/jobs/states. */
  private async listFromConfiguration(session: VeeamSessionData): Promise<JobSummary[]> {
    const [jobs, lastSessions] = await Promise.all([
      this.veeam.getJobs(session),
      this.lastSessionByJob(session),
    ]);

    return jobs
      .filter((job): job is VeeamJob & { id: string } => Boolean(job.id))
      .map((job) => this.toSummary(job, undefined, lastSessions.get(job.id)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async details(session: VeeamSessionData, jobId: string): Promise<JobDetails> {
    const [summaries, job, allSessions] = await Promise.all([
      this.list(session),
      this.veeam.getOptional<VeeamJob>(session, `/api/v1/jobs/${encodeURIComponent(jobId)}`),
      this.veeam.getSessions(session, { limit: 20, jobId }),
    ]);

    const summary = summaries.find((item) => item.id === jobId);
    if (!summary && !job) {
      throw new NotFoundException(`Job ${jobId} was not found`);
    }

    const jobSessions = allSessions.filter((item) => item.jobId === jobId).slice(0, 20);
    const sessions = jobSessions.map((item) => this.toSessionSummary(item));
    const base =
      summary ?? this.toSummary({ ...(job ?? {}), id: jobId }, undefined, jobSessions[0]);
    const includes = job?.virtualMachines?.includes ?? [];

    return {
      ...base,
      retention: job?.storage?.retentionPolicy
        ? {
            type: job.storage.retentionPolicy.type ?? null,
            quantity: job.storage.retentionPolicy.quantity ?? null,
          }
        : null,
      includedObjects: includes.map((item) => ({
        name: item.name ?? item.objectId ?? null,
        type: item.type ?? null,
        hostName: item.hostName ?? null,
      })),
      recentSessions: sessions,
      stats: this.computeStats(sessions),
    };
  }

  /**
   * Aggregates a set of runs. Durations only count finished sessions, so a run
   * still in progress does not drag the average towards zero.
   */
  computeStats(sessions: SessionSummary[]): RunStats {
    const counts = { success: 0, warning: 0, failed: 0, running: 0 };
    const durations: number[] = [];
    let lastSuccess: string | null = null;
    let lastFailure: string | null = null;

    for (const item of sessions) {
      const result = item.result?.toLowerCase();
      const state = item.state?.toLowerCase();
      const isRunning = state ? !['stopped', 'idle'].includes(state) : item.endTime === null && (!result || result === 'none');

      if (isRunning) {
        counts.running += 1;
        continue;
      }

      if (result === 'success') {
        counts.success += 1;
        if (!lastSuccess) lastSuccess = item.creationTime;
      } else if (result === 'warning') {
        counts.warning += 1;
      } else if (result === 'failed') {
        counts.failed += 1;
        if (!lastFailure) lastFailure = item.creationTime;
      }

      if (item.durationSeconds !== null) durations.push(item.durationSeconds);
    }

    const finished = counts.success + counts.warning + counts.failed;

    return {
      totalRuns: sessions.length,
      ...counts,
      successRate: finished > 0 ? Math.round((counts.success / finished) * 100) : null,
      avgDurationSeconds:
        durations.length > 0
          ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
          : null,
      minDurationSeconds: durations.length > 0 ? Math.min(...durations) : null,
      maxDurationSeconds: durations.length > 0 ? Math.max(...durations) : null,
      lastSuccess,
      lastFailure,
    };
  }

  async sessionsOfJob(
    session: VeeamSessionData,
    jobId: string,
    limit: number,
  ): Promise<SessionSummary[]> {
    const sessions = await this.veeam.getSessions(session, { limit, jobId });
    return sessions
      .filter((item) => item.jobId === jobId)
      .slice(0, limit)
      .map((item) => this.toSessionSummary(item));
  }

  async recentSessions(session: VeeamSessionData, limit: number): Promise<SessionSummary[]> {
    const sessions = await this.veeam.getSessions(session, { limit: Math.max(limit, 50) });
    return sessions.slice(0, limit).map((item) => this.toSessionSummary(item));
  }

  private async lastSessionByJob(session: VeeamSessionData): Promise<Map<string, VeeamSession>> {
    const sessions = await this.veeam.getSessions(session, { limit: 200 });
    const byJob = new Map<string, VeeamSession>();
    // Sessions arrive newest first, so the first hit per job is the latest run.
    for (const item of sessions) {
      if (item.jobId && !byJob.has(item.jobId)) {
        byJob.set(item.jobId, item);
      }
    }
    return byJob;
  }

  private toSummary(
    job: VeeamJob & { id: string },
    state: VeeamJobState | undefined,
    lastSession: VeeamSession | undefined,
  ): JobSummary {
    const isDisabled = job.isDisabled ?? state?.status?.toLowerCase() === 'disabled';
    const lastResult = state?.lastResult ?? lastSession?.result?.result ?? null;
    const isRunning =
      state?.status?.toLowerCase() === 'running' ||
      (state === undefined && lastSession?.state?.toLowerCase() === 'working');

    return {
      id: job.id,
      name: job.name ?? state?.name ?? job.id,
      type: job.type ?? state?.type ?? null,
      description: job.description ?? state?.description ?? null,
      status: this.toStatus({ isDisabled, isRunning, lastResult }),
      lastResult,
      lastRun: state?.lastRun ?? lastSession?.creationTime ?? null,
      nextRun: state?.nextRun ?? null,
      workload: state?.workload ?? null,
      objectsCount: state?.objectsCount ?? job.virtualMachines?.includes?.length ?? null,
      repositoryId: state?.repositoryId ?? job.storage?.backupRepositoryId ?? null,
      isDisabled,
      isScheduled: job.schedule?.runAutomatically ?? null,
      progressPercent: isRunning ? (lastSession?.progressPercent ?? null) : null,
      lastSessionId: state?.sessionId ?? lastSession?.id ?? null,
    };
  }

  private toStatus(input: {
    isDisabled: boolean;
    isRunning: boolean;
    lastResult: string | null;
  }): JobStatus {
    if (input.isDisabled) return 'disabled';
    if (input.isRunning) return 'running';

    switch (input.lastResult?.toLowerCase()) {
      case 'success':
        return 'success';
      case 'warning':
        return 'warning';
      case 'failed':
        return 'failed';
      case 'none':
      case undefined:
        return 'idle';
      default:
        return 'unknown';
    }
  }

  toSessionSummary(item: VeeamSession): SessionSummary {
    const start = item.creationTime ? Date.parse(item.creationTime) : NaN;
    const end = item.endTime ? Date.parse(item.endTime) : NaN;
    const durationSeconds =
      Number.isFinite(start) && Number.isFinite(end) && end >= start
        ? Math.round((end - start) / 1000)
        : null;

    return {
      id: item.id ?? '',
      name: item.name ?? null,
      jobId: item.jobId ?? null,
      type: item.sessionType ?? null,
      state: item.state ?? null,
      result: item.result?.result ?? null,
      message: item.result?.message ?? null,
      progressPercent: item.progressPercent ?? null,
      creationTime: item.creationTime ?? null,
      endTime: item.endTime ?? null,
      durationSeconds,
    };
  }
}
