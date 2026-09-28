import { Logger } from '@nestjs/common';
import { VeeamApiError } from './api.error';
import { InventoryNames, Job, jobOf, withResultLowered, WorkingSessions, workingOf } from './estate';
import { RawRequest, VeeamHttpService } from './http.service';
import { VeeamMonitorAuthService } from './monitor-auth.service';
import { allPages } from './pages';
import {
  VeeamBackup,
  VeeamCollection,
  VeeamJob,
  VeeamJobState,
  VeeamNamedResource,
  VeeamRepositoryState,
  VeeamRestorePoint,
  VeeamSession,
  VeeamTaskSession,
} from './types';

const JOB_STATES = '/api/v1/jobs/states';
const JOBS = '/api/v1/jobs';
const SESSIONS = '/api/v1/sessions';
const BACKUPS = '/api/v1/backups';
const RESTORE_POINTS = '/api/v1/restorePoints';
const REPOSITORY_STATES = '/api/v1/backupInfrastructure/repositories/states';
const REPOSITORIES = '/api/v1/backupInfrastructure/repositories';
const PROXIES = '/api/v1/backupInfrastructure/proxies';

const NEWEST_FIRST = { orderColumn: 'CreationTime', orderAsc: false };

/**
 * The Evidence's collections are read this many rows a page. The default of
 * 100 would turn a nine-thousand-point estate into ninety requests.
 */
const SCAN_PAGE = 500;

/**
 * Everything the service reads from Veeam, by name.
 *
 * The paths, their parameters, paging and the monitor account's token are all
 * in here. Callers ask for "the job states" or "this session's tasks"; none of
 * them builds a path or holds a token.
 *
 * The token used to be a string fetched at the start of a cycle and passed
 * from reader to reader. When Veeam refused it, the refused call was retried
 * with a fresh token — but every later call of the cycle still carried the
 * refused string, was refused in turn, and found the login-storm guard
 * declining to fetch another. One 403 cost the rest of the cycle. Here every
 * request asks the auth service for its token, which is cached and costs
 * nothing, so a token replaced once is used by everything after.
 *
 * What comes back is translated once, here: a job has an id, one name and one
 * spelling of its result, and every session's result is lower-cased.
 *
 * Every read throws when Veeam does not answer; what a failure means is the
 * caller's decision.
 *
 * One per Veeam server, built by `VeeamServers` beside the token it asks for.
 */
export class VeeamEstateReader {
  private readonly logger = new Logger(VeeamEstateReader.name);

  constructor(
    private readonly veeam: VeeamHttpService,
    private readonly auth: VeeamMonitorAuthService,
  ) {}

  /** Every job's runtime state, as a `Job`. A job Veeam gave no id is left out. */
  async jobStates(): Promise<Job[]> {
    const states = (await this.get<VeeamCollection<VeeamJobState>>(JOB_STATES)).data ?? [];
    const jobs = states.map(jobOf).filter((job): job is Job => job !== undefined);
    if (jobs.length < states.length) {
      this.logger.warn(`Veeam reported ${states.length - jobs.length} job(s) without an id; left out`);
    }
    return jobs;
  }

  /** One job's `count` newest sessions, newest first. */
  async recentSessions(jobId: string, count: number): Promise<VeeamSession[]> {
    const response = await this.get<VeeamCollection<VeeamSession>>(SESSIONS, {
      skip: 0,
      limit: count,
      ...NEWEST_FIRST,
      jobIdFilter: jobId,
    });
    return (response.data ?? []).map(withResultLowered);
  }

  /**
   * What Veeam is running right now: every page of the Working sessions, and
   * only those whose state says they are active.
   */
  async workingSessions(): Promise<WorkingSessions> {
    const sessions = await this.pages<VeeamSession>(SESSIONS, { stateFilter: 'Working', ...NEWEST_FIRST });
    return workingOf(sessions.map(withResultLowered));
  }

  /** The per-object tasks of one session: which machine, and how it went. */
  async taskSessions(sessionId: string): Promise<VeeamTaskSession[]> {
    const path = `${SESSIONS}/${encodeURIComponent(sessionId)}/taskSessions`;
    return (await this.pages<VeeamTaskSession>(path)).map(withResultLowered);
  }

  /** One job's whole configuration — storage and machines included, which the collection leaves out. */
  jobConfiguration(jobId: string): Promise<VeeamJob> {
    return this.get<VeeamJob>(`${JOBS}/${encodeURIComponent(jobId)}`);
  }

  /** Every job's configuration, as the collection gives it: schedules, not storage. */
  jobConfigurations(): Promise<VeeamJob[]> {
    return this.pages<VeeamJob>(JOBS, {}, SCAN_PAGE);
  }

  /** How full each repository is. */
  repositoryStates(): Promise<VeeamRepositoryState[]> {
    return this.pages<VeeamRepositoryState>(REPOSITORY_STATES);
  }

  /** Every backup chain, with the job that owns it. */
  backups(): Promise<VeeamBackup[]> {
    return this.pages<VeeamBackup>(BACKUPS, {}, SCAN_PAGE);
  }

  /** Every restore point, newest first. */
  restorePoints(): Promise<VeeamRestorePoint[]> {
    return this.pages<VeeamRestorePoint>(RESTORE_POINTS, NEWEST_FIRST, SCAN_PAGE);
  }

  /** Every session Veeam still keeps, newest first — the Evidence's history. */
  async sessions(): Promise<VeeamSession[]> {
    return (await this.pages<VeeamSession>(SESSIONS, NEWEST_FIRST, SCAN_PAGE)).map(withResultLowered);
  }

  /** The names behind repository and proxy ids — what the Inventory keeps. */
  async inventoryNames(): Promise<InventoryNames> {
    const [repositories, proxies] = await Promise.all([
      this.pages<VeeamNamedResource>(REPOSITORIES),
      this.pages<VeeamNamedResource>(PROXIES),
    ]);
    return { repositories: byId(repositories), proxies: byId(proxies) };
  }

  private get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    return this.authorized<T>({ method: 'GET', path, params });
  }

  private pages<T>(path: string, params: Record<string, unknown> = {}, limit?: number): Promise<T[]> {
    return allPages<T>(
      (skip, size) => this.get<VeeamCollection<T>>(path, { ...params, skip, limit: size }),
      limit,
    );
  }

  /**
   * One request with the monitor account's current token, tried once more if
   * Veeam refuses it and there is a better token to try.
   *
   * Exactly one retry. If the second token is refused too, the answer is
   * "Veeam is not letting us in", and that belongs in the health message
   * rather than in a loop.
   */
  private async authorized<T>(request: Omit<RawRequest, 'accessToken'>): Promise<T> {
    const token = await this.auth.getAccessToken();
    try {
      return await this.veeam.request<T>({ ...request, accessToken: token });
    } catch (error) {
      if (!(error instanceof VeeamApiError) || !error.isTokenRejected) throw error;
      const replacement = await this.replacementFor(token);
      if (replacement === undefined) throw error;
      return this.veeam.request<T>({ ...request, accessToken: replacement });
    }
  }

  /**
   * The token to try after `refused` was refused, or nothing worth trying.
   *
   * A token somebody has already replaced is simply used: a request that was
   * in flight when another request's refusal was dealt with carries the old
   * one, and spending the login-storm guard on it would leave the guard
   * saying no to the refusal that matters. Only a refusal of the token still
   * in use asks for a new one, and `rejectToken` allows that once a minute.
   * When it says no because a request refused alongside this one got there an
   * instant earlier, the token that request is fetching is the answer.
   */
  private async replacementFor(refused: string): Promise<string | undefined> {
    const current = await this.auth.getAccessToken();
    if (current !== refused) return current;
    if (this.auth.rejectToken()) return this.auth.getAccessToken();
    const after = await this.auth.getAccessToken();
    return after !== refused ? after : undefined;
  }
}

const byId = (rows: VeeamNamedResource[]): Map<string, string> =>
  new Map(
    rows
      .filter((row): row is VeeamNamedResource & { id: string } => Boolean(row.id))
      .map((row) => [row.id, row.name ?? row.id]),
  );
