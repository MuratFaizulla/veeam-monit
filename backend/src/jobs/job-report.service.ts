import { Injectable, NotFoundException } from '@nestjs/common';
import { VeeamSessionData } from '../auth/session.store';
import { VeeamClientService } from '../veeam/veeam-client.service';
import { VeeamCollection, VeeamSession } from '../veeam/veeam.types';
import { JobsService } from './jobs.service';
import { JobReport, LogReport, SessionReport, TaskReport } from './job-report.model';

interface TaskSession extends VeeamSession {
  sessionId?: string;
  type?: string;
  algorithm?: string;
  progress?: {
    processingRate?: string;
    bottleneck?: string;
    processedSize?: number;
    readSize?: number;
    transferredSize?: number;
    /** Older server examples use this spelling. */
    transferedSize?: number;
  } | null;
}

interface Logs {
  totalRecords?: number;
  records?: Array<{ id?: number; status?: string; startTime?: string; title?: string; description?: string }>;
}

@Injectable()
export class JobReportService {
  constructor(private readonly veeam: VeeamClientService, private readonly jobs: JobsService) {}

  async report(session: VeeamSessionData, jobId: string, days: number): Promise<JobReport> {
    const now = new Date();
    const from = new Date(now.getTime() - days * 86400000).toISOString();
    const to = now.toISOString();
    const [jobs, raw] = await Promise.all([
      this.jobs.list(session),
      this.veeam.getSessions(session, { jobId, createdAfter: from, createdBefore: to, all: true }),
    ]);
    const job = jobs.find(item => item.id === jobId);
    if (!job) throw new NotFoundException('Задание не найдено');
    const sessions = raw.filter(item => item.jobId === jobId && item.creationTime &&
      Date.parse(item.creationTime) >= Date.parse(from) && Date.parse(item.creationTime) <= now.getTime())
      .map(item => this.jobs.toSessionSummary(item))
      .sort((a, b) => Date.parse(b.creationTime!) - Date.parse(a.creationTime!));
    return { job, generatedAt: to, period: { days, from, to }, stats: this.jobs.computeStats(sessions), sessions };
  }

  private async ownedSession(session: VeeamSessionData, jobId: string, sessionId: string): Promise<VeeamSession> {
    const item = await this.veeam.get<VeeamSession>(session, `/api/v1/sessions/${encodeURIComponent(sessionId)}`);
    if (item.jobId !== jobId) throw new NotFoundException('Запуск не принадлежит этому заданию');
    return item;
  }

  async sessionReport(session: VeeamSessionData, jobId: string, sessionId: string): Promise<SessionReport> {
    const item = await this.ownedSession(session, jobId, sessionId);
    // These scoped paths accept no query parameters in 1.2-rev1.
    const [tasks, logs] = await Promise.all([
      this.veeam.getOptional<VeeamCollection<TaskSession>>(session, `/api/v1/sessions/${encodeURIComponent(sessionId)}/taskSessions`),
      this.veeam.getOptional<Logs>(session, `/api/v1/sessions/${encodeURIComponent(sessionId)}/logs`),
    ]);
    const items = (tasks?.data ?? []).filter(task => task.sessionId === sessionId).map(task => this.task(task));
    return {
      session: this.jobs.toSessionSummary(item),
      tasks: { available: tasks !== null, items, total: tasks?.pagination?.total ?? items.length },
      logs: this.logs(logs),
    };
  }

  async taskLogs(session: VeeamSessionData, jobId: string, sessionId: string, taskId: string): Promise<LogReport> {
    await this.ownedSession(session, jobId, sessionId);
    const task = await this.veeam.get<TaskSession>(session, `/api/v1/taskSessions/${encodeURIComponent(taskId)}`);
    if (task.sessionId !== sessionId) throw new NotFoundException('Объект не принадлежит этому запуску');
    return this.logs(await this.veeam.getOptional<Logs>(session, `/api/v1/taskSessions/${encodeURIComponent(taskId)}/logs`));
  }

  private task(task: TaskSession): TaskReport {
    const number = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) ? value : null;
    return {
      ...this.jobs.toSessionSummary(task), algorithm: task.algorithm ?? null,
      processingRate: task.progress?.processingRate ?? null, bottleneck: task.progress?.bottleneck ?? null,
      processedBytes: number(task.progress?.processedSize), readBytes: number(task.progress?.readSize),
      transferredBytes: number(task.progress?.transferredSize ?? task.progress?.transferedSize),
    };
  }

  private logs(logs: Logs | null): LogReport {
    const items = (logs?.records ?? []).map((record, index) => ({
      id: record.id ?? index, status: record.status ?? null, startTime: record.startTime ?? null,
      title: record.title ?? '—', description: record.description ?? null,
    })).sort((a, b) => (Date.parse(a.startTime ?? '') || 0) - (Date.parse(b.startTime ?? '') || 0) || a.id - b.id);
    return { available: logs !== null, items, total: logs?.totalRecords ?? items.length };
  }
}
