import { JobSummary, RunStats, SessionSummary } from './jobs.model';

export interface JobReport {
  job: JobSummary;
  generatedAt: string;
  period: { days: number; from: string; to: string };
  stats: RunStats;
  sessions: SessionSummary[];
}

export interface TaskReport extends SessionSummary {
  algorithm: string | null;
  processingRate: string | null;
  bottleneck: string | null;
  processedBytes: number | null;
  readBytes: number | null;
  transferredBytes: number | null;
}

export interface LogRecord {
  id: number;
  status: string | null;
  startTime: string | null;
  title: string;
  description: string | null;
}

export interface LogReport {
  available: boolean;
  items: LogRecord[];
  total: number;
}

export interface SessionReport {
  session: SessionSummary;
  tasks: { available: boolean; items: TaskReport[]; total: number };
  logs: LogReport;
}
