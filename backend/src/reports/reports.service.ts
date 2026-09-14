import { Injectable } from '@nestjs/common';
import { VeeamSessionData } from '../auth/session.store';
import { InfrastructureService, RepositoryView } from '../infrastructure/infrastructure.service';
import { JobStatus, JobSummary, RunStats, SessionSummary } from '../jobs/jobs.model';
import { JobsService } from '../jobs/jobs.service';
import { CsvColumn, csvDateTime, toCsv } from './csv';

export interface ReportSummary {
  generatedAt: string;
  periodDays: number;
  jobs: {
    total: number;
    byStatus: Record<JobStatus, number>;
    successRate: number | null;
  };
  runs: RunStats;
  /** Jobs with the most failed runs in the period, worst first. */
  worstJobs: Array<{
    id: string;
    name: string;
    failed: number;
    warning: number;
    success: number;
    successRate: number | null;
  }>;
  repositories: {
    available: boolean;
    total: number;
    /** Repositories above 80% used. */
    lowOnSpace: RepositoryView[];
  };
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

/** Sessions are read in bulk and filtered here; this caps how many we ask for. */
const SESSION_FETCH_LIMIT = 500;

@Injectable()
export class ReportsService {
  constructor(
    private readonly jobs: JobsService,
    private readonly infrastructure: InfrastructureService,
  ) {}

  async summary(session: VeeamSessionData, days: number): Promise<ReportSummary> {
    const [jobs, sessions, infrastructure] = await Promise.all([
      this.jobs.list(session),
      this.sessionsInPeriod(session, days),
      this.infrastructure.overview(session),
    ]);

    const byStatus = { ...EMPTY_COUNTS };
    for (const job of jobs) byStatus[job.status] += 1;

    const rated = byStatus.success + byStatus.warning + byStatus.failed;
    const nameById = new Map(jobs.map((job) => [job.id, job.name]));

    const repositories = [
      ...infrastructure.repositories.items,
      ...infrastructure.scaleOutRepositories.items,
    ];

    return {
      generatedAt: new Date().toISOString(),
      periodDays: days,
      jobs: {
        total: jobs.length,
        byStatus,
        successRate: rated > 0 ? Math.round((byStatus.success / rated) * 100) : null,
      },
      runs: this.jobs.computeStats(sessions),
      worstJobs: this.worstJobs(sessions, nameById),
      repositories: {
        available: infrastructure.repositories.available,
        total: repositories.length,
        lowOnSpace: repositories.filter(
          (repository) => repository.usedPercent !== null && repository.usedPercent >= 80,
        ),
      },
    };
  }

  async jobsCsv(session: VeeamSessionData): Promise<string> {
    const jobs = await this.jobs.list(session);

    const columns: CsvColumn<JobSummary>[] = [
      { header: 'Задание', value: (job) => job.name },
      { header: 'Тип', value: (job) => job.type },
      { header: 'Статус', value: (job) => STATUS_LABELS[job.status] },
      { header: 'Последний результат', value: (job) => job.lastResult },
      { header: 'Последний запуск', value: (job) => csvDateTime(job.lastRun) },
      { header: 'Следующий запуск', value: (job) => csvDateTime(job.nextRun) },
      { header: 'Объектов', value: (job) => job.objectsCount },
      { header: 'Нагрузка', value: (job) => job.workload },
      { header: 'Отключено', value: (job) => job.isDisabled },
      { header: 'Описание', value: (job) => job.description },
      { header: 'ID', value: (job) => job.id },
    ];

    return toCsv(jobs, columns);
  }

  async sessionsCsv(session: VeeamSessionData, days: number): Promise<string> {
    const [sessions, jobs] = await Promise.all([
      this.sessionsInPeriod(session, days),
      this.jobs.list(session),
    ]);
    const nameById = new Map(jobs.map((job) => [job.id, job.name]));

    const columns: CsvColumn<SessionSummary>[] = [
      { header: 'Задание', value: (item) => (item.jobId ? nameById.get(item.jobId) : null) },
      { header: 'Сессия', value: (item) => item.name },
      { header: 'Тип', value: (item) => item.type },
      { header: 'Результат', value: (item) => item.result },
      { header: 'Состояние', value: (item) => item.state },
      { header: 'Начало', value: (item) => csvDateTime(item.creationTime) },
      { header: 'Окончание', value: (item) => csvDateTime(item.endTime) },
      { header: 'Длительность, мин', value: (item) => this.minutes(item.durationSeconds) },
      { header: 'Сообщение', value: (item) => item.message },
    ];

    return toCsv(sessions, columns);
  }

  async repositoriesCsv(session: VeeamSessionData): Promise<string> {
    const infrastructure = await this.infrastructure.overview(session);
    const rows = [
      ...infrastructure.repositories.items,
      ...infrastructure.scaleOutRepositories.items,
    ];

    const columns: CsvColumn<RepositoryView>[] = [
      { header: 'Репозиторий', value: (row) => row.name },
      { header: 'Тип', value: (row) => row.type },
      { header: 'Сервер', value: (row) => row.hostName },
      { header: 'Путь', value: (row) => row.path },
      { header: 'Ёмкость, ГБ', value: (row) => this.round(row.capacityGB) },
      { header: 'Свободно, ГБ', value: (row) => this.round(row.freeGB) },
      { header: 'Занято, ГБ', value: (row) => this.round(row.usedGB) },
      { header: 'Занято, %', value: (row) => row.usedPercent },
    ];

    return toCsv(rows, columns);
  }

  /** Sessions started within the last `days` days, newest first. */
  private async sessionsInPeriod(
    session: VeeamSessionData,
    days: number,
  ): Promise<SessionSummary[]> {
    const sessions = await this.jobs.recentSessions(session, SESSION_FETCH_LIMIT);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    return sessions.filter((item) => {
      if (!item.creationTime) return false;
      const started = Date.parse(item.creationTime);
      return Number.isFinite(started) && started >= since;
    });
  }

  private worstJobs(
    sessions: SessionSummary[],
    nameById: Map<string, string>,
  ): ReportSummary['worstJobs'] {
    const byJob = new Map<string, { failed: number; warning: number; success: number }>();

    for (const item of sessions) {
      if (!item.jobId) continue;
      const bucket = byJob.get(item.jobId) ?? { failed: 0, warning: 0, success: 0 };

      switch (item.result?.toLowerCase()) {
        case 'failed':
          bucket.failed += 1;
          break;
        case 'warning':
          bucket.warning += 1;
          break;
        case 'success':
          bucket.success += 1;
          break;
        default:
          break;
      }

      byJob.set(item.jobId, bucket);
    }

    return [...byJob.entries()]
      .map(([id, bucket]) => {
        const finished = bucket.failed + bucket.warning + bucket.success;
        return {
          id,
          name: nameById.get(id) ?? id,
          ...bucket,
          successRate: finished > 0 ? Math.round((bucket.success / finished) * 100) : null,
        };
      })
      .filter((row) => row.failed > 0 || row.warning > 0)
      .sort((a, b) => b.failed - a.failed || b.warning - a.warning)
      .slice(0, 10);
  }

  private minutes(seconds: number | null): number | null {
    return seconds === null ? null : Math.round(seconds / 60);
  }

  private round(value: number | null): number | null {
    return value === null ? null : Math.round(value);
  }
}

export const STATUS_LABELS: Record<JobStatus, string> = {
  running: 'Выполняется',
  success: 'Успешно',
  warning: 'Предупреждение',
  failed: 'Ошибка',
  disabled: 'Отключено',
  idle: 'Не запускалось',
  unknown: 'Неизвестно',
};
