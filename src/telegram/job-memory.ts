/**
 * What the monitor remembers about one server's jobs, from one cycle to the
 * next and across a restart: the result each job was last reported with, and
 * the failed runs Veeam was still retrying when announced.
 *
 * Both are what the **Job alerts** module decides against, and both used to be
 * modules of their own — each a record and a save, each with its own accessor
 * in the state store, its own pruning of deleted jobs and of servers taken off
 * the list. The second was added by copying the first, and missed the check
 * the first had on the way in.
 *
 * Holds its server's part of the state file and calls `save` after each
 * change; it knows nothing about files. The file keeps the two parts where
 * older versions wrote them, so a version rolled back to reads what it knows.
 */
export class JobMemory {
  constructor(
    private readonly record: JobMemoryRecord,
    private readonly save: () => void,
  ) {}

  /** False on a server never observed before — its seeding cycle. */
  seeded(): boolean {
    return this.count() > 0;
  }

  /** How many jobs have a remembered result. */
  count(): number {
    return Object.keys(this.record.results).length;
  }

  /** The result the job was last reported with, lower-cased. */
  resultOf(jobId: string): string | undefined {
    return this.record.results[jobId];
  }

  /**
   * Remembers the job's result. What to record — never `none` over a known
   * result — is `rememberedResult` in job-state.ts; this only remembers.
   */
  remember(jobId: string, result: string): void {
    if (this.record.results[jobId] === result) return;
    this.record.results[jobId] = result;
    this.save();
  }

  /** The failed run of this job Veeam was still retrying when announced. */
  retryingOf(jobId: string): RetryingRun | undefined {
    return this.record.retrying[jobId];
  }

  follow(jobId: string, run: RetryingRun): void {
    this.record.retrying[jobId] = run;
    this.save();
  }

  unfollow(jobId: string): void {
    if (!(jobId in this.record.retrying)) return;
    delete this.record.retrying[jobId];
    this.save();
  }

  /** Jobs deleted in Veeam must not keep a slot in the file forever. */
  keepOnly(liveIds: Set<string | undefined>): void {
    let changed = false;
    for (const part of [this.record.results, this.record.retrying]) {
      for (const id of Object.keys(part)) {
        if (liveIds.has(id)) continue;
        delete part[id];
        changed = true;
      }
    }
    if (changed) this.save();
  }
}

/**
 * A failed run announced while Veeam still had attempts left.
 *
 * Followed from the first alert until Veeam either stops trying — which is
 * announced — or the job's result changes, which the ordinary alert already
 * says. Kept in the state file: a restart between two attempts would otherwise
 * forget the run, and the one message that says "no more attempts" with it.
 */
export interface RetryingRun {
  /** Attempts seen so far. */
  attempt: number;
  /**
   * The job's last run as its state reported it when last looked at. Veeam
   * moves it when another attempt starts, which is when the run is worth
   * reading again; until then it costs nothing to follow.
   */
  lastRun?: string;
  /**
   * Epoch ms after which Veeam has let its chance to retry pass. Absent when
   * an attempt was running when last looked at: then the run is read again as
   * soon as the job stops running.
   */
  retryBy?: number;
}

/** One server's part of the state file. */
export interface JobMemoryRecord {
  /** Job id -> last reported result. */
  results: Record<string, string>;
  /** Job id -> the run being followed. */
  retrying: Record<string, RetryingRun>;
}

/** The two parts of the state file, keyed by server. */
export interface JobMemoryFile {
  jobResults: Record<string, Record<string, string>>;
  retrying: Record<string, Record<string, RetryingRun>>;
}

/**
 * The two parts as read from disk, with every entry this version would not
 * have written left out, and said.
 *
 * Entry by entry, never the whole file: a file that fails its check is
 * replaced by its backup or by nothing, and one malformed run is not worth the
 * chats, the topics and the live messages beside it. The worst a dropped
 * entry costs is one job learnt again, quietly.
 */
export const memoryFromFile = (
  jobResults: Record<string, unknown>,
  retrying: unknown,
  warn: (message: string) => void,
): JobMemoryFile => {
  const dropped: string[] = [];
  const results: JobMemoryFile['jobResults'] = {};
  for (const [server, jobs] of Object.entries(jobResults)) {
    if (!isRecord(jobs)) {
      dropped.push(`jobResults.${server}`);
      continue;
    }
    results[server] = {};
    for (const [job, result] of Object.entries(jobs)) {
      if (typeof result === 'string') results[server][job] = result;
      else dropped.push(`jobResults.${server}.${job}`);
    }
  }

  const runs: JobMemoryFile['retrying'] = {};
  if (retrying !== undefined && !isRecord(retrying)) dropped.push('retrying');
  for (const [server, jobs] of Object.entries(isRecord(retrying) ? retrying : {})) {
    if (!isRecord(jobs)) {
      dropped.push(`retrying.${server}`);
      continue;
    }
    runs[server] = {};
    for (const [job, run] of Object.entries(jobs)) {
      if (isRetryingRun(run)) runs[server][job] = run;
      else dropped.push(`retrying.${server}.${job}`);
    }
  }

  if (dropped.length > 0) warn(`Telegram state: left out what this version cannot read: ${dropped.join(', ')}`);
  return { jobResults: results, retrying: runs };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isRetryingRun = (value: unknown): value is RetryingRun =>
  isRecord(value) &&
  typeof value.attempt === 'number' &&
  (value.lastRun === undefined || typeof value.lastRun === 'string') &&
  (value.retryBy === undefined || typeof value.retryBy === 'number');
