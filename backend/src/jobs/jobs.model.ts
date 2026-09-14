/** Shapes returned to the React application. */

export type JobStatus =
  | 'running'
  | 'success'
  | 'warning'
  | 'failed'
  | 'disabled'
  | 'idle'
  | 'unknown';

export interface JobSummary {
  id: string;
  name: string;
  type: string | null;
  description: string | null;
  status: JobStatus;
  lastResult: string | null;
  lastRun: string | null;
  nextRun: string | null;
  workload: string | null;
  objectsCount: number | null;
  repositoryId: string | null;
  isDisabled: boolean;
  isScheduled: boolean | null;
  progressPercent: number | null;
  lastSessionId: string | null;
}

export interface SessionSummary {
  id: string;
  name: string | null;
  jobId: string | null;
  type: string | null;
  state: string | null;
  result: string | null;
  message: string | null;
  progressPercent: number | null;
  creationTime: string | null;
  endTime: string | null;
  durationSeconds: number | null;
}

/** Aggregate of a set of runs — used per job and across the installation. */
export interface RunStats {
  totalRuns: number;
  success: number;
  warning: number;
  failed: number;
  running: number;
  /** Share of successful runs among finished ones, 0-100. */
  successRate: number | null;
  avgDurationSeconds: number | null;
  minDurationSeconds: number | null;
  maxDurationSeconds: number | null;
  lastSuccess: string | null;
  lastFailure: string | null;
}

export interface JobDetails extends JobSummary {
  retention: { type: string | null; quantity: number | null } | null;
  includedObjects: Array<{ name: string | null; type: string | null; hostName: string | null }>;
  recentSessions: SessionSummary[];
  stats: RunStats;
}
