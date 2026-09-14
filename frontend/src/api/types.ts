/** Mirrors the models returned by the NestJS backend. */

export type JobStatus =
  | 'running'
  | 'success'
  | 'warning'
  | 'failed'
  | 'disabled'
  | 'idle'
  | 'unknown';

export interface SessionUser {
  username: string;
  role?: string;
  expiresAt: string;
}

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

export interface JobDetails extends JobSummary {
  stats: RunStats;
  retention: { type: string | null; quantity: number | null } | null;
  includedObjects: Array<{ name: string | null; type: string | null; hostName: string | null }>;
  recentSessions: SessionSummary[];
}

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
export interface LogReport {
  available: boolean;
  items: Array<{ id: number; status: string | null; startTime: string | null; title: string; description: string | null }>;
  total: number;
}
export interface SessionReport {
  session: SessionSummary;
  tasks: { available: boolean; items: TaskReport[]; total: number };
  logs: LogReport;
}

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
  repositories: RepositoryView[];
}

/* ---------- infrastructure ---------- */

export interface RepositoryView {
  id: string;
  name: string;
  type: string | null;
  hostName: string | null;
  path: string | null;
  capacityGB: number | null;
  freeGB: number | null;
  usedGB: number | null;
  usedPercent: number | null;
}

export interface ComponentView {
  id: string;
  name: string;
  type: string | null;
  description: string | null;
  detail: string | null;
}

/** Every section carries `available: false` when the role or build lacks it. */
export interface Section<T> {
  available: boolean;
  items: T[];
}

export interface InfrastructureView {
  repositories: Section<RepositoryView>;
  scaleOutRepositories: Section<RepositoryView>;
  proxies: Section<ComponentView>;
  managedServers: Section<ComponentView>;
  wanAccelerators: Section<ComponentView>;
}

/* ---------- backups ---------- */

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

export interface BackupObjectDetails {
  object: BackupObjectView;
  restorePoints: Section<RestorePointView>;
}

/* ---------- replicas ---------- */

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

export interface ReplicaDetails {
  replica: ReplicaView;
  restorePoints: Section<ReplicaRestorePointView>;
}

/* ---------- license & security ---------- */

export interface LicenseWorkloadView {
  id: string;
  name: string;
  hostName: string | null;
  type: string | null;
  amount: number | null;
  unit: 'instances' | 'sockets' | 'GB';
}

export interface LicenseView {
  available: boolean;
  status: string | null;
  edition: string | null;
  type: string | null;
  licensedTo: string | null;
  expirationDate: string | null;
  supportExpirationDate: string | null;
  autoUpdateEnabled: boolean | null;
  instances: { licensed: number | null; used: number | null } | null;
  sockets: { licensed: number | null; used: number | null } | null;
  capacityTb: { licensed: number | null; used: number | null } | null;
  topWorkloads: LicenseWorkloadView[];
}

export interface BestPracticeView {
  id: string;
  name: string | null;
  status: string | null;
  description: string | null;
  suppressComment: string | null;
}

export interface SecurityView {
  analyzer: {
    available: boolean;
    lastRun: { state: string | null; result: string | null; endTime: string | null } | null;
    counts: Record<string, number>;
    items: BestPracticeView[];
  };
  malware: {
    available: boolean;
    items: Array<{
      id: string;
      detectedAt: string | null;
      severity: string | null;
      state: string | null;
      machineName: string | null;
      source: string | null;
      details: string | null;
    }>;
  };
}

/* ---------- reports ---------- */

export interface RunStats {
  totalRuns: number;
  success: number;
  warning: number;
  failed: number;
  running: number;
  successRate: number | null;
  avgDurationSeconds: number | null;
  minDurationSeconds: number | null;
  maxDurationSeconds: number | null;
  lastSuccess: string | null;
  lastFailure: string | null;
}

export interface ReportSummary {
  generatedAt: string;
  periodDays: number;
  jobs: {
    total: number;
    byStatus: Record<JobStatus, number>;
    successRate: number | null;
  };
  runs: RunStats;
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
    lowOnSpace: RepositoryView[];
  };
}
