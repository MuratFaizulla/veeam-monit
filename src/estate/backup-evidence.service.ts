import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { Job } from '../veeam/estate';
import { VeeamEstateReader } from '../veeam/estate-reader.service';
import { VeeamJob, VeeamSchedule, VeeamSession } from '../veeam/types';
import { failureStreakOf, retryWindowOf } from './runs';

/**
 * What one reading of the estate established.
 *
 * Three live slots — 🛡 Protection, 🗂 Restore points and 🧹 Orphaned backups —
 * are three questions about one body of facts: every restore point Veeam holds,
 * every session that wrote one, and every job configuration that says whether a
 * job was supposed to run at all. Reading that costs around twenty requests and
 * half a minute, so it happens on its own slow cadence and the answer is kept.
 *
 * It used to be kept as nine mutable fields on the monitor. Everything a reader
 * had to know — which fields it may read, that `scannedAt === 0` means "no
 * evidence yet", that the fields may be a cadence stale, and that the slot
 * rendering depth had to run *after* the slot that happened to trigger the scan
 * — was an interface as complicated as the scan itself, and most of it was
 * written in comments. This module has one interface instead: ask for the
 * evidence, and either it is there or it says why not.
 */

/** How far back sessions are read when counting consecutive failures. */
const STREAK_WINDOW_DAYS = 7;

/**
 * A reading this young is kept when its server is selected again. Switching
 * back and forth must not become a way of running the heaviest read there is
 * on demand.
 */
const JUST_READ_MS = 10 * 60_000;

/**
 * Run timestamps kept per job.
 *
 * One more than the gaps a cadence is learned from: N gaps need N+1 points.
 * The two numbers only mean anything together, which is why the reader that
 * needs the cadence is handed it from here rather than the timestamps.
 */
const RHYTHM_SAMPLES = 10;
const RUNS_PER_JOB = RHYTHM_SAMPLES + 1;

/** How far back a job can be restored, and how much it took to get there. */
export interface RetainedHistory {
  /** Distinct runs retained — the moments this job can be restored to. */
  runs: number;
  /** Restore point objects, which is runs × machines. */
  points: number;
  machines: number;
  oldest: number;
  newest: number;
}

/** A backup chain no live job owns. */
export interface OrphanChain {
  name: string;
  points: number;
  oldest: number;
  newest: number;
}

export interface ScannedEvidence {
  status: 'ready';
  scannedAt: number;
  /** Run timestamps per job, newest first, capped at RUNS_PER_JOB. */
  runsByJob: Map<string, number[]>;
  /**
   * How often each job actually runs, in days; null where its history is too
   * short to tell. Computed here because it is the only place that knows both
   * how many runs were kept and how many gaps a cadence is read from — two
   * constants that mean nothing apart and used to live in different files.
   */
  cadenceByJob: Map<string, number | null>;
  /** Consecutive failed runs per job, inside the streak window. */
  streakByJob: Map<string, number>;
  /** Jobs Veeam will not start on its own; they owe nobody a restore point. */
  unscheduled: ReadonlySet<string>;
  /** Full schedules, used to validate and describe today's nextRun values. */
  schedulesByJob: ReadonlyMap<string, VeeamSchedule>;
  depthByJob: Map<string, RetainedHistory>;
  orphanChains: OrphanChain[];
  /** Restore points in the estate, orphans and failed runs included. */
  totalPoints: number;
  /** Of those, the ones a failed run left behind. */
  failedPoints: number;
}

/** No evidence to answer from, and the reason a reader can show. */
export interface PendingEvidence {
  status: 'pending';
  reason: string;
}

export type Evidence = ScannedEvidence | PendingEvidence;

const NOT_READ = 'Точки восстановления ещё не прочитаны.';
const NO_ANSWER = 'Veeam не ответил на этот цикл, поэтому точки не перечитывались.';

/** When one run of a job was on the clock, and how it ended. */
interface RunWindow {
  from: number;
  to: number;
  failed: boolean;
}

/** One per Veeam server, built by `ServerEstates`: a scan reads one server. */
export class BackupEvidenceService {
  private readonly logger: Logger;
  private readonly config: AppConfig['telegram'];
  /** The last scan that finished. Survives cycles Veeam did not answer. */
  private scanned?: ScannedEvidence;
  private current: Evidence = { status: 'pending', reason: NOT_READ };
  /** The next refresh reads again, whatever the cadence says. */
  private renewing = false;

  constructor(
    config: ConfigService,
    private readonly reader: VeeamEstateReader,
    server = '',
  ) {
    this.logger = new Logger(`${BackupEvidenceService.name}${server ? ` ${server}` : ''}`);
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
  }

  /** What the readers answer from. Never throws, never blocks. */
  get evidence(): Evidence {
    return this.current;
  }

  /**
   * Has the next refresh read the estate again, ahead of the cadence.
   *
   * For a server that was just selected: only the selected server is scanned,
   * so a server selected again still holds the reading from when it was last
   * shown — up to a whole cadence old, which at two hours is not what somebody
   * who just pressed the button expects to see. A reading from the last few
   * minutes is kept.
   */
  renew(): void {
    if (Date.now() - (this.scanned?.scannedAt ?? 0) >= JUST_READ_MS) this.renewing = true;
  }

  /**
   * Brings the evidence up to date if it is older than the configured cadence,
   * or `renew` asked for it.
   *
   * Called once per cycle, before anything reads. That is what makes the order
   * the slots are published in mean nothing: it used to be that whichever slot
   * ran first paid for the scan, so rendering depth before protection silently
   * showed the previous cycle's numbers.
   *
   * Never throws: a scan that failed leaves the previous evidence in place, and
   * a cycle with nothing to read from says so rather than claiming an estate
   * with no restore points.
   */
  async refresh(authenticated: boolean, jobs: Job[] | undefined): Promise<void> {
    if (!authenticated || !jobs) {
      this.current = { status: 'pending', reason: NO_ANSWER };
      return;
    }
    if (this.renewing || Date.now() - (this.scanned?.scannedAt ?? 0) >= this.config.protectionIntervalMs) {
      const fresh = await this.scan(jobs);
      if (fresh) {
        this.scanned = fresh;
        this.renewing = false;
      }
    }
    this.current = this.scanned ?? { status: 'pending', reason: NOT_READ };
  }

  /** Reads the estate. Returns undefined when the read did not finish. */
  private async scan(jobs: Job[]): Promise<ScannedEvidence | undefined> {
    const startedAt = Date.now();
    const liveJobIds = new Set(jobs.map((job) => job.id));

    try {
      // The runtime state says whether a job is disabled; only the job
      // configuration says whether it has a schedule at all.
      const configured = await this.reader.jobConfigurations();
      const unscheduled = new Set(
        configured
          .filter((job) => job.id && job.schedule?.runAutomatically === false)
          .map((job) => job.id as string),
      );
      const schedulesByJob = new Map(
        configured
          .filter((job): job is VeeamJob & { id: string; schedule: VeeamSchedule } =>
            Boolean(job.id && job.schedule),
          )
          .map((job) => [job.id, job.schedule]),
      );

      // Backups whose job no longer exists. Every other check starts from the
      // job list, so nothing else can see them at all.
      const backups = await this.reader.backups();
      const jobOfBackup = new Map<string, string>();
      const orphanNames = new Map<string, string>();
      for (const backup of backups) {
        if (!backup.id) continue;
        if (backup.jobId && liveJobIds.has(backup.jobId)) {
          jobOfBackup.set(backup.id, backup.jobId);
        } else {
          orphanNames.set(backup.id, backup.name ?? backup.id);
        }
      }

      const points = await this.reader.restorePoints();

      // A restore point object says nothing about whether the run that made it
      // worked: it carries a creation time and a session id, and that is all.
      // A failed run still leaves one behind — TTC_Exchange errored out on 14
      // September having transferred 6.8 GB of 22.4, and the point it left made
      // the job look backed up that night when its last good copy was from 23
      // August. The verdict lives only in the sessions.
      const sessions = await this.reader.sessions();
      const runsOfJob = runWindows(sessions);
      const resultOfSession = new Map(
        sessions
          .filter((session): session is VeeamSession & { id: string } => Boolean(session.id))
          .map((session) => [session.id, session.result?.result ?? '']),
      );

      // One restore point is created per protected machine, so a job covering
      // eleven VMs produces eleven points minutes apart. Taken raw, that made a
      // quarterly job look like it ran hourly. Points are therefore folded down
      // to one timestamp per run, which is what `sessionId` identifies.
      const runsByJob = new Map<string, Map<string, number>>();
      const depth = new Map<
        string,
        { runs: Set<string>; points: number; machines: Set<string>; oldest: number; newest: number }
      >();
      const orphans = new Map<string, { points: number; oldest: number; newest: number }>();
      let failedPoints = 0;

      for (const point of points) {
        if (!point.creationTime) continue;
        const at = Date.parse(point.creationTime);
        if (!Number.isFinite(at)) continue;

        const jobId = point.backupId ? jobOfBackup.get(point.backupId) : undefined;
        // Counted for the job it belongs to, then dropped: it is a file on a
        // repository, not a state anybody should plan to restore to.
        if (jobId && wroteByFailedRun(runsOfJob.get(jobId), at, point.sessionId, resultOfSession)) {
          failedPoints += 1;
          continue;
        }
        if (!jobId) {
          const orphanId = point.backupId;
          if (!orphanId || !orphanNames.has(orphanId)) continue;
          const chain = orphans.get(orphanId) ?? { points: 0, oldest: at, newest: at };
          chain.points += 1;
          chain.oldest = Math.min(chain.oldest, at);
          chain.newest = Math.max(chain.newest, at);
          orphans.set(orphanId, chain);
          continue;
        }
        const run = point.sessionId ?? point.creationTime;

        // Depth is counted over every point, uncapped: how far back a job can
        // be restored is exactly the question the cap would answer wrongly.
        const seen = depth.get(jobId) ?? {
          runs: new Set<string>(),
          points: 0,
          machines: new Set<string>(),
          oldest: at,
          newest: at,
        };
        seen.runs.add(run);
        seen.points += 1;
        if (point.name) seen.machines.add(point.name);
        seen.oldest = Math.min(seen.oldest, at);
        seen.newest = Math.max(seen.newest, at);
        depth.set(jobId, seen);

        const runs = runsByJob.get(jobId) ?? new Map<string, number>();
        // Only the newest few runs matter here: one for the age, the rest for
        // the rhythm.
        if (!runs.has(run) && runs.size >= RUNS_PER_JOB) continue;
        runs.set(run, Math.max(runs.get(run) ?? 0, at));
        runsByJob.set(jobId, runs);
      }

      const scannedAt = Date.now();
      this.logger.log(
        `Evidence scan: ${points.length} restore points (${failedPoints} from failed runs),` +
          ` ${sessions.length} sessions, ${runsByJob.size} jobs, ${scannedAt - startedAt}ms`,
      );

      // Newest first, which is the order a cadence reads its gaps in.
      const runs = new Map(
        [...runsByJob].map(([jobId, kept]): [string, number[]] => [
          jobId,
          [...kept.values()].sort((a, b) => b - a),
        ]),
      );

      return {
        status: 'ready',
        scannedAt,
        runsByJob: runs,
        cadenceByJob: new Map([...runs].map(([jobId, kept]) => [jobId, cadenceOf(kept)])),
        streakByJob: failureStreaks(sessions, schedulesByJob),
        unscheduled,
        schedulesByJob,
        depthByJob: new Map(
          [...depth].map(([jobId, seen]) => [
            jobId,
            {
              runs: seen.runs.size,
              points: seen.points,
              machines: seen.machines.size,
              oldest: seen.oldest,
              newest: seen.newest,
            },
          ]),
        ),
        orphanChains: [...orphans].map(([id, chain]) => ({
          name: orphanNames.get(id) ?? id,
          points: chain.points,
          oldest: chain.oldest,
          newest: chain.newest,
        })),
        totalPoints: points.length,
        failedPoints,
      };
    } catch (error) {
      this.logger.error(`Evidence scan failed: ${(error as Error).message}`);
      return undefined;
    }
  }
}

/**
 * The job's usual interval in days, as the median gap between its recent runs.
 *
 * The median rather than the mean because one long outage between two runs
 * would otherwise redefine the job as a monthly one. Exported because it is the
 * shape of the answer, not a step in it: callers ask the evidence how often a
 * job runs, and this is how the evidence knows.
 */
export const cadenceOf = (newestFirst: number[]): number | null => {
  if (newestFirst.length < 3) return null;
  const gaps: number[] = [];
  for (let i = 0; i < Math.min(newestFirst.length - 1, RHYTHM_SAMPLES); i += 1) {
    gaps.push(newestFirst[i] - newestFirst[i + 1]);
  }
  gaps.sort((a, b) => a - b);
  const middle = gaps[Math.floor(gaps.length / 2)] / 86_400_000;
  return Number.isFinite(middle) && middle > 0 ? middle : null;
};

/**
 * When each job's runs were on the clock, oldest first.
 *
 * A session's window is what the point lookup needs: a point written at 01:31
 * belongs to whatever was running at 01:31, whatever id the point carries.
 */
const runWindows = (sessions: VeeamSession[]): Map<string, RunWindow[]> => {
  const windows = new Map<string, RunWindow[]>();
  for (const session of sessions) {
    if (!session.jobId || !/Job$/.test(session.sessionType ?? '')) continue;
    const from = Date.parse(session.creationTime ?? '');
    if (!Number.isFinite(from)) continue;
    const list = windows.get(session.jobId) ?? [];
    list.push({
      from,
      // A session still running has no end; it owns everything since it began.
      to: session.endTime ? Date.parse(session.endTime) : Number.POSITIVE_INFINITY,
      failed: session.result?.result === 'failed',
    });
    windows.set(session.jobId, list);
  }
  for (const list of windows.values()) list.sort((a, b) => a.from - b.from);
  return windows;
};

/**
 * Did the run that wrote this point end in an error?
 *
 * Not the same question as "did the session whose id the point carries fail".
 * Veeam stamps a point with the session that *opened* the run, and a run that
 * is retried keeps writing into the same point: TTC_Exchange's 23 August point
 * carries the id of the attempt that started on 21 August and failed, yet it
 * was written at 01:31 on the 23rd, nine minutes into the retry that succeeded
 * and ran until the 26th. Across this estate the id says "failed" for 344
 * points that a successful run actually wrote — discarding them would have
 * moved TTC_Exchange's newest point back to 31 July for no reason.
 *
 * So the point is matched to whatever was on the clock when it appeared, and
 * the carried id is only the fallback for a point written outside every known
 * session window. A point nothing can be proven against is kept: the evidence
 * that a run failed may simply have aged out of Veeam's session history, and
 * inventing a verdict is worse than trusting a point that survived that long.
 */
const wroteByFailedRun = (
  windows: RunWindow[] | undefined,
  at: number,
  sessionId: string | undefined,
  results: Map<string, string>,
): boolean => {
  let covering: RunWindow | undefined;
  for (const window of windows ?? []) {
    if (window.from > at) break;
    if (at <= window.to && (!covering || window.from > covering.from)) covering = window;
  }
  if (covering) return covering.failed;
  return sessionId !== undefined && results.get(sessionId) === 'failed';
};

/**
 * Consecutive failed *runs* per job, counted back from its newest session.
 *
 * A run is not a session: Veeam retries a failed job automatically, and each
 * retry is its own session, so a job with the default three retries reports
 * four failed sessions for one failed run — which made "4 неуспеха подряд"
 * appear against nearly every currently-failing job and mean nothing. Which
 * sessions are one run is decided in runs.ts, the same rule the alert's
 * "Попытка 2 из 4" reads; this only picks the sessions to hand it.
 */
const failureStreaks = (
  sessions: VeeamSession[],
  schedules: ReadonlyMap<string, VeeamSchedule>,
): Map<string, number> => {
  const since = Date.now() - STREAK_WINDOW_DAYS * 86_400_000;

  const newestFirst = new Map<string, VeeamSession[]>();
  for (const session of sessions) {
    if (!session.jobId || !session.endTime) continue;
    // Only actual job runs. Malware scans, compliance analysis, retention and
    // configuration backups also appear here and are not the job failing.
    if (!/Job$/.test(session.sessionType ?? '')) continue;
    // A streak is about a job that is broken now. Counting back through a year
    // of history would report "forty failed runs in a row" for a job nobody has
    // touched since spring.
    if (Date.parse(session.creationTime ?? '') < since) continue;
    const list = newestFirst.get(session.jobId) ?? [];
    list.push(session);
    newestFirst.set(session.jobId, list);
  }

  const streaks = new Map<string, number>();
  for (const [jobId, list] of newestFirst) {
    list.sort((a, b) => Date.parse(b.creationTime ?? '') - Date.parse(a.creationTime ?? ''));
    const attempts = list.map((session) => ({
      startedAt: session.creationTime,
      endedAt: session.endTime,
      result: session.result?.result,
    }));
    const streak = failureStreakOf(attempts, retryWindowOf(schedules.get(jobId)));
    if (streak > 0) streaks.set(jobId, streak);
  }
  return streaks;
};
