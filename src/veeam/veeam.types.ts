/**
 * The part of the Veeam Backup & Replication REST API (spec 1.2-rev1) this
 * service consumes. Every field is optional on purpose: the exact shape differs
 * between VBR builds, and a missing property must never abort a monitor cycle.
 *
 * Four endpoints are read, and nothing else:
 *   GET /api/v1/serverTime                                  — reachability
 *   GET /api/v1/jobs/states                                 — VeeamJobState
 *   GET /api/v1/sessions                                    — VeeamSession
 *   GET /api/v1/backupInfrastructure/repositories/states    — VeeamRepositoryState
 * plus POST /api/oauth2/token for VeeamTokenResponse.
 *
 * The file used to carry 21 models covering jobs configuration, backups,
 * restore points, replicas, licensing, proxies and malware events. Those served
 * the dashboard; it is gone, and so are they.
 */

export interface VeeamTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  username?: string;
  mfa_token?: string;
}

export interface VeeamPagination {
  total?: number;
  count?: number;
  skip?: number;
  limit?: number;
}

/** Envelope every collection endpoint answers with. */
export interface VeeamCollection<T> {
  data?: T[];
  pagination?: VeeamPagination;
}

/** Item of GET /api/v1/jobs/states — the runtime state of a job. */
export interface VeeamJobState {
  id?: string;
  name?: string;
  type?: string;
  status?: string;
  lastRun?: string;
  lastResult?: string;
  nextRun?: string;
  objectsCount?: number;
}

/**
 * Item of GET /api/v1/sessions. Two things are read: `result.message`, which
 * supplies the reason a job failed, and `progressPercent`/`creationTime` for
 * the sessions that are still running.
 */
export interface VeeamSession {
  id?: string;
  name?: string;
  jobId?: string;
  sessionType?: string;
  creationTime?: string;
  endTime?: string;
  state?: string;
  /** 0-100 while the session is working; absent before it reports any. */
  progressPercent?: number;
  result?: {
    result?: string;
    message?: string;
  };
}

export interface VeeamTaskProgress {
  duration?: string | null;
  processingRate?: string | null;
  bottleneck?: string | null;
  processedSize?: number | null;
  readSize?: number | null;
  transferredSize?: number | null;
}

export interface VeeamTaskSession {
  id?: string;
  name?: string;
  type?: string;
  state?: string;
  status?: string;
  progress?: VeeamTaskProgress | null;
}

/**
 * Item of GET /api/v1/backups — the link from a restore point back to the job
 * that produced it. Restore points carry only `backupId`, so without this the
 * points cannot be attributed to anything.
 */
export interface VeeamBackup {
  id?: string;
  name?: string;
  jobId?: string;
  creationTime?: string;
}

/**
 * Item of GET /api/v1/restorePoints — the actual recoverable copy.
 *
 * This is the only endpoint that answers "is this data protected". A job can
 * report Success and still have produced nothing new for months.
 */
export interface VeeamRestorePoint {
  id?: string;
  /** The protected machine, not the job: one point is created per VM per run. */
  name?: string;
  backupId?: string;
  /** Identifies the run. Every VM of one run shares it. */
  sessionId?: string;
  creationTime?: string;
}

/**
 * Item of GET /api/v1/jobs — the job *configuration*, as opposed to its runtime
 * state. Only the schedule is read: a job set to run manually has no business
 * being reported for not having produced a restore point lately.
 */
export interface VeeamSchedule {
  runAutomatically?: boolean;
  daily?: {
    isEnabled?: boolean;
    dailyKind?: string;
    localTime?: string;
    days?: string[];
  };
  monthly?: {
    isEnabled?: boolean;
    localTime?: string;
    dayOfMonth?: number | null;
    dayOfWeek?: string;
    dayNumberInMonth?: string;
    months?: string[];
  };
  periodically?: {
    isEnabled?: boolean;
    periodicallyKind?: string;
    frequency?: number;
  };
  continuously?: { isEnabled?: boolean };
  afterThisJob?: { isEnabled?: boolean; jobName?: string | null };
  retry?: {
    isEnabled?: boolean;
    retryCount?: number;
    awaitMinutes?: number;
  };
}

export interface VeeamJob {
  id?: string;
  name?: string;
  isDisabled?: boolean;
  /** False when the job only ever runs because somebody started it. */
  schedule?: VeeamSchedule;
}

/** Item of .../repositories/states — capacity figures live here, not in the config. */
export interface VeeamRepositoryState {
  id?: string;
  name?: string;
  hostName?: string;
  path?: string;
  capacityGB?: number;
  freeGB?: number;
  usedSpaceGB?: number;
  isOnline?: boolean;
}
