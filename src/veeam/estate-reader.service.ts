import { Logger } from '@nestjs/common';
import { VeeamApiError } from './api.error';
import { InventoryNames, Job, jobOf, withResultLowered, WorkingSessions, workingOf } from './estate';
import { RawRequest, VeeamHttpService } from './http.service';
import { VeeamMonitorAuthService } from './monitor-auth.service';
import { allPages } from './pages';
import { machineLine } from './session-text';
import {
  VeeamBackup,
  VeeamBackupFile,
  VeeamCollection,
  VeeamJob,
  VeeamJobState,
  VeeamLogRecord,
  VeeamNamedResource,
  VeeamRepositoryState,
  VeeamRestorePoint,
  VeeamSession,
  VeeamTaskSession,
} from './types';

const JOB_STATES = '/api/v1/jobs/states';
const JOBS = '/api/v1/jobs';
const SESSIONS = '/api/v1/sessions';
const TASK_SESSIONS = '/api/v1/taskSessions';
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

/** A session log's record status, as the result a task session would carry. */
const LOG_OUTCOME: Record<string, string> = { succeeded: 'success', warning: 'warning', failed: 'failed' };

/** How one machine of a session ended. */
export interface MachineResult {
  name: string;
  /** Lower-cased, as every result this reader hands out. */
  result: string;
  /** Why it went wrong, in Veeam's words and without its boilerplate; absent when Veeam gave none. */
  reason?: string;
  /** Lower-cased: `full`, `increment`. Only from the task sessions; a log does not say. */
  algorithm?: string;
}

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

  /**
   * How each machine of one session ended, by machine name, lower-cased.
   * `machineResults` without the reasons, which is all the Evidence needs.
   */
  async machineOutcomes(sessionId: string): Promise<Map<string, string>> {
    return new Map((await this.machineResults(sessionId)).map(({ name, result }) => [name, result]));
  }

  /**
   * How each machine of one session ended, and in Veeam's words why.
   *
   * From the task sessions where the server has them. A server on REST API
   * 1.1 answers that path with 404, and the session log is the only other
   * place the outcome is written: one record per machine, whose status is the
   * machine's.
   */
  async machineResults(sessionId: string): Promise<MachineResult[]> {
    try {
      const tasks = await this.taskSessions(sessionId);
      return tasks
        .filter((task): task is VeeamTaskSession & { name: string } => Boolean(task.name))
        .map((task) => ({
          name: task.name,
          result: task.result?.result ?? '',
          reason: machineLine(task.result?.message ?? '').reason,
          ...(task.algorithm ? { algorithm: task.algorithm.toLowerCase() } : {}),
        }));
    } catch (error) {
      if (!(error instanceof VeeamApiError) || error.upstreamStatus !== 404) throw error;
    }
    const results = new Map<string, MachineResult>();
    for (const record of await this.sessionLog(sessionId)) {
      const { machine, reason } = machineLine(record.title ?? '');
      const result = LOG_OUTCOME[(record.status ?? '').toLowerCase()];
      if (machine && result) results.set(machine, { name: machine, result, reason });
    }
    return [...results.values()];
  }

  /** What Veeam wrote down while running one session, in order. */
  sessionLog(sessionId: string): Promise<VeeamLogRecord[]> {
    return this.log(`${SESSIONS}/${encodeURIComponent(sessionId)}/logs`);
  }

  /** What Veeam wrote down while processing one machine of a session, in order. */
  taskLog(taskSessionId: string): Promise<VeeamLogRecord[]> {
    return this.log(`${TASK_SESSIONS}/${encodeURIComponent(taskSessionId)}/logs`);
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

  /** The files one backup keeps on its repository, and the restore points each holds. */
  backupFiles(backupId: string): Promise<VeeamBackupFile[]> {
    return this.pages<VeeamBackupFile>(`${BACKUPS}/${encodeURIComponent(backupId)}/backupFiles`, {}, SCAN_PAGE);
  }

  /** Every restore point, newest first. */
  restorePoints(): Promise<VeeamRestorePoint[]> {
    return this.pages<VeeamRestorePoint>(RESTORE_POINTS, NEWEST_FIRST, SCAN_PAGE);
  }

  /** Every session Veeam still keeps, newest first — the Evidence's history. */
  async sessions(): Promise<VeeamSession[]> {
    return (await this.pages<VeeamSession>(SESSIONS, NEWEST_FIRST, SCAN_PAGE)).map(withResultLowered);
  }

  /** The sessions begun after `since`, newest first: what a history read then is missing. */
  async sessionsCreatedAfter(since: Date): Promise<VeeamSession[]> {
    const params = { createdAfterFilter: since.toISOString(), ...NEWEST_FIRST };
    return (await this.pages<VeeamSession>(SESSIONS, params, SCAN_PAGE)).map(withResultLowered);
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

  /**
   * A log, which Veeam answers as `records` rather than `data`; 1.1 builds
   * may use either. A thousand records is more than any one session writes.
   */
  private async log(path: string): Promise<VeeamLogRecord[]> {
    const log = await this.get<{ records?: VeeamLogRecord[]; data?: VeeamLogRecord[] }>(path, { limit: 1000 });
    return log.records ?? log.data ?? [];
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
