/**
 * Subset of the Veeam Backup & Replication REST API models (spec 1.2-rev1) that
 * this application consumes. Every field is optional on purpose: the exact shape
 * differs between VBR builds, and a missing property must never crash a page.
 */

export interface VeeamTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  '.issued'?: string;
  '.expires'?: string;
  username?: string;
  role?: string;
  short_term_license?: string;
  long_term_license?: string;
  mfa_token?: string;
  redirect_to?: string;
}

export interface VeeamPagination {
  total?: number;
  count?: number;
  skip?: number;
  limit?: number;
}

export interface VeeamCollection<T> {
  data?: T[];
  pagination?: VeeamPagination;
}

export interface VeeamServerInfo {
  vbrId?: string;
  name?: string;
  buildVersion?: string;
  databaseVendor?: string;
  patches?: string[];
}

/** Item of GET /api/v1/jobs — the job configuration. */
export interface VeeamJob {
  id?: string;
  name?: string;
  description?: string;
  type?: string;
  isDisabled?: boolean;
  isHighPriority?: boolean;
  virtualMachines?: {
    includes?: Array<{ type?: string; hostName?: string; name?: string; objectId?: string }>;
    excludes?: unknown;
  };
  storage?: {
    backupRepositoryId?: string;
    backupProxies?: unknown;
    retentionPolicy?: { type?: string; quantity?: number };
    gfsPolicy?: unknown;
  };
  schedule?: {
    runAutomatically?: boolean;
    daily?: unknown;
    monthly?: unknown;
    periodically?: unknown;
    continuous?: unknown;
    backupWindow?: unknown;
    retry?: { isEnabled?: boolean; retryCount?: number; awaitMinutes?: number };
  };
}

/** Item of GET /api/v1/jobs/states — the runtime state of a job. */
export interface VeeamJobState {
  id?: string;
  name?: string;
  type?: string;
  description?: string;
  status?: string;
  lastRun?: string;
  lastResult?: string;
  nextRun?: string;
  workload?: string;
  repositoryId?: string;
  objectsCount?: number;
  sessionId?: string;
  isHighPriorityJob?: boolean;
}

export interface VeeamSession {
  id?: string;
  name?: string;
  activityId?: string;
  jobId?: string;
  sessionType?: string;
  creationTime?: string;
  endTime?: string;
  state?: string;
  progressPercent?: number;
  resourceId?: string;
  resourceReference?: string;
  parentSessionId?: string;
  usn?: number;
  platformName?: string;
  result?: {
    result?: string;
    message?: string;
    isCanceled?: boolean;
  };
}

/* ------------------------------------------------------------------ *
 * Backup infrastructure
 * ------------------------------------------------------------------ */

export interface VeeamRepository {
  id?: string;
  name?: string;
  description?: string;
  type?: string;
  hostId?: string;
  hostName?: string;
  path?: string;
  tag?: string;
}

/** Item of .../repositories/states — capacity figures live here, not in the config. */
export interface VeeamRepositoryState {
  id?: string;
  name?: string;
  type?: string;
  description?: string;
  hostId?: string;
  hostName?: string;
  path?: string;
  capacityGB?: number;
  freeGB?: number;
  usedSpaceGB?: number;
}

export interface VeeamProxy {
  id?: string;
  name?: string;
  description?: string;
  type?: string;
  server?: { hostId?: string; hostName?: string; transportMode?: string; maxTaskCount?: number };
  hostId?: string;
  maxTaskCount?: number;
}

export interface VeeamManagedServer {
  id?: string;
  name?: string;
  description?: string;
  type?: string;
  status?: string;
  port?: number;
  credentialsId?: string;
}

export interface VeeamWanAccelerator {
  id?: string;
  name?: string;
  description?: string;
  serverId?: string;
  serverName?: string;
  cachePath?: string;
  cacheSizeGb?: number;
  trafficPort?: number;
}

/* ------------------------------------------------------------------ *
 * Backups, objects and restore points
 * ------------------------------------------------------------------ */

export interface VeeamBackup {
  id?: string;
  name?: string;
  jobId?: string;
  policyTag?: string;
  platformId?: string;
  platformName?: string;
  creationTime?: string;
  repositoryId?: string;
  backupType?: string;
  isRunning?: boolean;
}

export interface VeeamBackupObject {
  id?: string;
  name?: string;
  type?: string;
  platformId?: string;
  platformName?: string;
  restorePointsCount?: number;
  objectId?: string;
  path?: string;
  viType?: string;
}

export interface VeeamRestorePoint {
  id?: string;
  name?: string;
  backupId?: string;
  backupObjectId?: string;
  creationTime?: string;
  platformId?: string;
  platformName?: string;
  type?: string;
  malwareStatus?: string;
  allowedOperations?: string[];
}

/* ------------------------------------------------------------------ *
 * Replicas
 * ------------------------------------------------------------------ */

export interface VeeamReplica {
  id?: string;
  name?: string;
  jobId?: string;
  jobName?: string;
  platformId?: string;
  platformName?: string;
  state?: string;
  status?: string;
  originalVmName?: string;
  replicaVmName?: string;
  hostId?: string;
  hostName?: string;
  restorePointsCount?: number;
  latestRestorePointTime?: string;
}

export interface VeeamReplicaRestorePoint {
  id?: string;
  name?: string;
  replicaId?: string;
  creationTime?: string;
  type?: string;
  state?: string;
}

/* ------------------------------------------------------------------ *
 * License
 * ------------------------------------------------------------------ */

export interface VeeamLicense {
  status?: string;
  expirationDate?: string;
  supportExpirationDate?: string;
  licensedTo?: string;
  edition?: string;
  type?: string;
  autoUpdateEnabled?: boolean;
  cloudConnect?: string;
  instanceLicenseSummary?: {
    licensedInstancesNumber?: number;
    usedInstancesNumber?: number;
    newInstancesNumber?: number;
    rentalInstancesNumber?: number;
  };
  socketLicenseSummary?: {
    licensedSocketsNumber?: number;
    usedSocketsNumber?: number;
    remainingSocketsNumber?: number;
  };
  capacityLicenseSummary?: {
    licensedCapacityTb?: number;
    usedCapacityTb?: number;
  };
}

export interface VeeamLicenseWorkload {
  instanceId?: string;
  hostId?: string;
  name?: string;
  hostName?: string;
  type?: string;
  usedInstancesNumber?: number;
  socketsNumber?: number;
  coresNumber?: number;
  multiplier?: number;
  usedCapacityGb?: number;
}

/* ------------------------------------------------------------------ *
 * Security & malware
 * ------------------------------------------------------------------ */

export interface VeeamBestPractice {
  bestPractice?: string;
  note?: string;
  id?: string;
  type?: string;
  name?: string;
  status?: string;
  description?: string;
  suppressComment?: string;
}

export interface VeeamMalwareEvent {
  id?: string;
  type?: string;
  detectionTimeUtc?: string;
  state?: string;
  severity?: string;
  source?: string;
  details?: string;
  machineId?: string;
  machineName?: string;
  engine?: string;
}
