/**
 * The part of the Veeam Backup & Replication REST API (spec 1.2-rev1) this
 * service consumes. Every field is optional on purpose: the exact shape differs
 * between VBR builds, and a missing property must never abort a monitor cycle.
 *
 * What is read, and nothing else:
 *   GET /api/v1/serverTime                                  — reachability
 *   GET /api/v1/jobs/states                                 — VeeamJobState
 *   GET /api/v1/jobs, /api/v1/jobs/{id}                     — VeeamJob
 *   GET /api/v1/sessions                                    — VeeamSession
 *   GET /api/v1/sessions/{id}/taskSessions                  — VeeamTaskSession
 *   GET /api/v1/backups, /api/v1/restorePoints              — VeeamBackup, VeeamRestorePoint
 *   GET /api/v1/backupInfrastructure/repositories/states    — VeeamRepositoryState
 *   GET /api/v1/backupInfrastructure/repositories, /proxies — VeeamNamedResource
 * plus POST /api/oauth2/token for VeeamTokenResponse. Every one of them is a
 * GET: this service has no business changing anything on the backup server.
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

/**
 * One record of GET /api/v1/sessions/{id}/logs. On a server whose REST API
 * predates task sessions (1.1), "Processing <machine>" records are the only
 * place a machine's outcome is written down.
 */
export interface VeeamLogRecord {
  /** `Succeeded`, `Warning`, `Failed` or `None`. */
  status?: string;
  title?: string;
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
  /** The object this task processed — a VM name, which is what is asked for. */
  name?: string;
  type?: string;
  state?: string;
  status?: string;
  /** Per-object outcome: this is where "which machine failed, and why" lives. */
  result?: {
    result?: string;
    message?: string;
  };
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

/** One protected object, as the job configuration names it. */
export interface VeeamJobObject {
  name?: string;
  /** The host it lives on, which is what an operator recognises it by. */
  hostName?: string;
  type?: string;
  platform?: string;
  /** Veeam's own formatting, locale and all: "3,9 TB". Never parsed. */
  size?: string;
}

/** Where a job writes, and what it may use to get there. */
export interface VeeamJobStorage {
  backupRepositoryId?: string;
  backupProxies?: {
    /** True when Veeam picks the proxy per run; then `proxyIds` is empty. */
    autoSelectEnabled?: boolean;
    proxyIds?: string[];
  };
  retentionPolicy?: {
    /** `Days` or `RestorePoints`. */
    type?: string;
    quantity?: number;
  };
  advancedSettings?: {
    backupModeType?: string;
    activeFulls?: VeeamFullBackups;
    /** Veeam's own spelling of "synthetic", kept so the field is found. */
    synthenticFulls?: VeeamFullBackups;
  };
}

export interface VeeamFullBackups {
  isEnabled?: boolean;
  weekly?: { isEnabled?: boolean; days?: string[] };
}

export interface VeeamJob {
  id?: string;
  name?: string;
  type?: string;
  description?: string;
  isDisabled?: boolean;
  /** `runAutomatically: false` when the job only ever runs by hand. */
  schedule?: VeeamSchedule;
  /** Only present on a single job read by id, not in the collection. */
  storage?: VeeamJobStorage;
  virtualMachines?: {
    includes?: VeeamJobObject[];
    excludes?: { vms?: VeeamJobObject[] };
  };
}

/**
 * Item of the backup infrastructure collections — repositories and proxies.
 *
 * Jobs point at these by id and nothing else, so without this a card can only
 * say that the job writes to `60df9772-a2d9-…`.
 */
export interface VeeamNamedResource {
  id?: string;
  name?: string;
  type?: string;
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
