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
 * Item of GET /api/v1/sessions. Only `result.message` is read — it supplies the
 * reason a job failed, which the job state itself does not carry.
 */
export interface VeeamSession {
  id?: string;
  jobId?: string;
  creationTime?: string;
  endTime?: string;
  state?: string;
  result?: {
    result?: string;
    message?: string;
  };
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
}
