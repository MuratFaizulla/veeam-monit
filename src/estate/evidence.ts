import { Job } from '../veeam/estate';
import { VeeamBackup, VeeamJob, VeeamRestorePoint, VeeamSchedule, VeeamSession } from '../veeam/types';
import { Attempt, failureStreakOf, retryWindowOf, Run, runsOf } from './runs';

/**
 * What one reading of the estate establishes.
 *
 * Given what a scan read — the jobs, their configurations, the backups, every
 * restore point and every session — which run wrote each point, which points
 * count, how far back each job can be restored, how often it runs and how many
 * of its runs failed in a row. Pure: no Veeam, no clock but the one it is
 * handed, nothing kept between readings.
 *
 * It used to be the body of the Evidence's scan, between the reads and the
 * caches, and was only reached through them: a test of where one point
 * belongs drove a whole scan through a fake Veeam of four or five paths. When
 * to read, and what is kept from one reading to the next — the Session history
 * and the machine outcomes — stay in `BackupEvidenceService`.
 */

/** How far back sessions are read when counting consecutive failures. */
const STREAK_WINDOW_DAYS = 7;

/**
 * Job types whose restore points are not in the restore point list: a replica
 * keeps its own on the target host, and file, object storage, Entra ID and
 * tape jobs keep theirs in collections of their own. They are judged by their
 * good runs instead; judged by points, every one of them read "точек
 * восстановления нет" for ever, NTP/DOM and TTC_Billing_DB_file among them.
 */
const PROVEN_BY_RUNS = /Replica|EntraID|File|ObjectStorage|Tape/i;

/**
 * Points this close together, where nothing else can tell their runs apart,
 * are one run. Only for points older than the session history on a server
 * whose points do not name their session (REST API 1.1).
 */
const SAME_RUN_MS = 2 * 3_600_000;

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
  /** Absent when Veeam did not say which points are full. */
  chain?: ChainShape;
}

/**
 * How a job's retained runs line up into backup chains.
 *
 * A Full begins a chain and every increment after it depends on it, so the
 * chain still being added to is "the newest Full and the runs since". The
 * chains before it stay on disk until retention lets the whole of each go,
 * which is why a job kept for seven days can hold eleven points.
 */
export interface ChainShape {
  /** Retained runs that wrote a Full, each of which began a chain. */
  fulls: number;
  /** When the newest of them began, epoch ms; absent when no retained run wrote one. */
  lastFull?: number;
  /** Runs after that Full: the increments of the chain still being added to. */
  sinceFull: number;
}

/** How long Veeam is told to keep a job's points, as its configuration says. */
export interface Retention {
  quantity: number;
  unit: 'days' | 'points';
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
  /**
   * Jobs whose `runsByJob` are their good runs rather than their restore
   * points, because their points are kept somewhere this scan does not read.
   */
  provenByRuns: ReadonlySet<string>;
  /** Full schedules, used to validate and describe today's nextRun values. */
  schedulesByJob: ReadonlyMap<string, VeeamSchedule>;
  /** Each job's retention, where its configuration gave one. */
  retentionByJob: ReadonlyMap<string, Retention>;
  depthByJob: Map<string, RetainedHistory>;
  orphanChains: OrphanChain[];
  /** Restore points in the estate, orphans and failed runs included. */
  totalPoints: number;
  /** Of those, the ones a failed run left behind for a machine that failed in it. */
  failedPoints: number;
  /** And the ones a failed run wrote for a machine that got through it, which count. */
  keptFromFailed: number;
}

/** No evidence to answer from, and the reason a reader can show. */
export interface PendingEvidence {
  status: 'pending';
  reason: string;
}

export type Evidence = ScannedEvidence | PendingEvidence;

/** What one scan read, as it came back. */
export interface EstateRead {
  /** The live jobs, from their runtime state. */
  jobs: Job[];
  /** Every job's configuration: its schedule, and whether it has one. */
  configurations: VeeamJob[];
  backups: VeeamBackup[];
  points: VeeamRestorePoint[];
  /** Every session the Session history keeps, in any order. */
  sessions: VeeamSession[];
}

/** How each machine of a failed session ended, by session id and then machine name; results lower-cased. */
export type SessionOutcomes = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** One reading, its points placed: what it still has to ask, and then what it establishes. */
export interface Reading {
  /**
   * The failed sessions that wrote a point. Veeam marks a whole run failed
   * when one machine of fifteen does, so each of these is asked how its
   * machines ended before its points are counted or set aside.
   */
  failedSessions: ReadonlySet<string>;
  /**
   * What the reading establishes, `outcomes` saying how the machines of the
   * failed sessions ended and `now` being when, epoch ms. A failed session
   * missing from `outcomes` has all of its points set aside.
   */
  evidence(outcomes: SessionOutcomes, now: number): ScannedEvidence;
}

/** When one session of a job was on the clock, how it ended, and which run it belongs to. */
interface RunWindow {
  /** The session. */
  id: string;
  from: number;
  to: number;
  failed: boolean;
  /** The session that opened its run: the one Veeam stamps the run's points with. */
  run: string;
}

/** One session, as the run folding reads it. */
interface SessionAttempt extends Attempt {
  id: string;
}

/** One restore point of a live job, with what the sessions say about it. */
interface Placed {
  jobId: string;
  at: number;
  /** The machine. */
  name?: string;
  sessionId?: string;
  /** The run that was on the clock when it was written, when one was. */
  run?: string;
  /** The failed session that wrote it, when it was a failed one. */
  failedBy?: string;
  /** Lower-cased: `full`, `increment`, … */
  type?: string;
}

/** One retained run of a job, as its points add up. */
interface RunTally {
  /** Its earliest point: when the run began writing. */
  at: number;
  points: number;
  fulls: number;
}

/** Places every point of `read` in the run that wrote it. */
export const readingOf = (read: EstateRead): Reading => {
  const { jobs, configurations, backups, points, sessions } = read;
  const liveJobIds = new Set(jobs.map((job) => job.id));

  // The runtime state says whether a job is disabled; only the job
  // configuration says whether it has a schedule at all.
  const unscheduled = new Set(
    configurations
      .filter((job) => job.id && job.schedule?.runAutomatically === false)
      .map((job) => job.id as string),
  );
  const schedulesByJob = new Map(
    configurations
      .filter((job): job is VeeamJob & { id: string; schedule: VeeamSchedule } => Boolean(job.id && job.schedule))
      .map((job) => [job.id, job.schedule]),
  );
  const retentionByJob = new Map(
    configurations.flatMap((job): [string, Retention][] => {
      const retention = retentionOf(job);
      return job.id && retention ? [[job.id, retention]] : [];
    }),
  );

  // Backups whose job no longer exists. Every other check starts from the
  // job list, so nothing else can see them at all.
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

  // A restore point object says nothing about whether the run that made it
  // worked: it carries a creation time and a session id, and that is all.
  // A failed run still leaves one behind — TTC_Exchange errored out on 14
  // September having transferred 6.8 GB of 22.4, and the point it left made
  // the job look backed up that night when its last good copy was from 23
  // August. The verdict lives only in the sessions.
  const attempts = jobAttempts(sessions);
  const runsOfJob = jobRuns(attempts, schedulesByJob);
  const windowsOfJob = runWindows(runsOfJob);
  const resultOfSession = new Map(
    sessions
      .filter((session): session is VeeamSession & { id: string } => Boolean(session.id))
      .map((session) => [session.id, session.result?.result ?? '']),
  );

  // Which failed session — if any — wrote each point.
  const placed: Placed[] = [];
  const orphans = new Map<string, { points: number; oldest: number; newest: number }>();
  for (const point of points) {
    if (!point.creationTime) continue;
    const at = Date.parse(point.creationTime);
    if (!Number.isFinite(at)) continue;

    const jobId = point.backupId ? jobOfBackup.get(point.backupId) : undefined;
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
    const covering = coveringOf(windowsOfJob.get(jobId), at);
    placed.push({
      jobId,
      at,
      name: point.name,
      sessionId: point.sessionId,
      run: covering?.run,
      failedBy: failedSessionOf(covering, point.sessionId, resultOfSession),
      type: point.type?.toLowerCase(),
    });
  }

  const evidence = (outcomes: SessionOutcomes, now: number): ScannedEvidence => {
    // One restore point is created per protected machine, so a job covering
    // eleven VMs produces eleven points minutes apart. Taken raw, that made a
    // quarterly job look like it ran hourly. Points are therefore folded down
    // to one timestamp per run: the one `sessionId` names, or on a server
    // whose points name no session, the run that was on the clock.
    const runsByJob = new Map<string, Map<string, number>>();
    const depth = new Map<
      string,
      {
        runs: Map<string, RunTally>;
        points: number;
        machines: Set<string>;
        oldest: number;
        newest: number;
        typed: boolean;
      }
    >();
    const nearest = new Map<string, { key: string; at: number }>();
    let failedPoints = 0;
    let keptFromFailed = 0;

    for (const { jobId, at, name, sessionId, run: coveringRun, failedBy, type } of placed) {
      // A failed run is not a failed machine. Veeam marks the whole run failed
      // when one machine of fifteen does, and every point of it used to be
      // discarded: TTC_ASUEDT_REMS_DBS03 read "точек восстановления нет" with
      // 131 points on disk, thirteen machines a night. Only a failed
      // machine's point goes.
      if (failedBy) {
        const outcome = name ? outcomes.get(failedBy)?.get(name) : undefined;
        // Counted, then dropped: it is a file on a repository, not a state
        // anybody should plan to restore to.
        if (outcome !== 'success' && outcome !== 'warning') {
          failedPoints += 1;
          continue;
        }
        keptFromFailed += 1;
      }
      const run = sessionId ?? coveringRun ?? nearby(nearest, jobId, at);

      // Depth is counted over every point, uncapped: how far back a job can
      // be restored is exactly the question the cap would answer wrongly.
      const seen = depth.get(jobId) ?? {
        runs: new Map<string, RunTally>(),
        points: 0,
        machines: new Set<string>(),
        oldest: at,
        newest: at,
        typed: false,
      };
      const tally = seen.runs.get(run) ?? { at, points: 0, fulls: 0 };
      tally.at = Math.min(tally.at, at);
      tally.points += 1;
      if (type === 'full') tally.fulls += 1;
      seen.runs.set(run, tally);
      if (type) seen.typed = true;
      seen.points += 1;
      if (name) seen.machines.add(name);
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

    // Their points are elsewhere; what they have to show is runs that worked.
    const provenByRuns = new Set(jobs.filter((job) => PROVEN_BY_RUNS.test(job.type ?? '')).map((job) => job.id));
    for (const jobId of provenByRuns) {
      const good = (runsOfJob.get(jobId) ?? [])
        .filter((run) => run.result === 'success' || run.result === 'warning')
        .slice(0, RUNS_PER_JOB);
      runsByJob.set(
        jobId,
        new Map(good.map((run) => [run.attempts[0].id, Date.parse(run.attempts[0].startedAt ?? '')])),
      );
    }

    // Newest first, which is the order a cadence reads its gaps in.
    const runs = new Map(
      [...runsByJob].map(([jobId, kept]): [string, number[]] => [jobId, [...kept.values()].sort((a, b) => b - a)]),
    );

    return {
      status: 'ready',
      scannedAt: now,
      runsByJob: runs,
      cadenceByJob: new Map([...runs].map(([jobId, kept]) => [jobId, cadenceOf(kept)])),
      streakByJob: failureStreaks(attempts, schedulesByJob, now),
      unscheduled,
      provenByRuns,
      schedulesByJob,
      retentionByJob,
      depthByJob: new Map(
        [...depth].map(([jobId, seen]): [string, RetainedHistory] => [
          jobId,
          {
            runs: seen.runs.size,
            points: seen.points,
            machines: seen.machines.size,
            oldest: seen.oldest,
            newest: seen.newest,
            ...(seen.typed ? { chain: chainOf([...seen.runs.values()]) } : {}),
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
      keptFromFailed,
    };
  };

  return { failedSessions: new Set(placed.flatMap((point) => point.failedBy ?? [])), evidence };
};

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
 * Which retained runs began a chain, and how far the newest chain has grown.
 *
 * A run is a Full when most of its points are: a machine added to a job gets
 * its first, full, point on an ordinary incremental night, and that night did
 * not begin a chain for the other fourteen.
 */
const chainOf = (runs: RunTally[]): ChainShape => {
  const fulls = runs.filter((run) => run.fulls * 2 > run.points);
  if (fulls.length === 0) return { fulls: 0, sinceFull: runs.length };
  const lastFull = Math.max(...fulls.map((run) => run.at));
  return { fulls: fulls.length, lastFull, sinceFull: runs.filter((run) => run.at > lastFull).length };
};

/** "7 days" or "14 restore points", as the job is configured to keep. */
const retentionOf = (job: VeeamJob): Retention | undefined => {
  const policy = job.storage?.retentionPolicy;
  if (!policy?.quantity) return undefined;
  const unit = (policy.type ?? '').toLowerCase() === 'days' ? 'days' : 'points';
  return { quantity: policy.quantity, unit };
};

/**
 * Each job's sessions, newest first. Only actual job runs: malware scans,
 * compliance analysis, retention and configuration backups are sessions too,
 * and are not the job running or failing.
 *
 * Both the point placing and the failure streak start from these, and each
 * picks the sessions its own question needs (ADR 0001).
 */
const jobAttempts = (sessions: VeeamSession[]): Map<string, SessionAttempt[]> => {
  const attempts = new Map<string, SessionAttempt[]>();
  for (const session of sessions) {
    if (!session.id || !session.jobId || !/Job$/.test(session.sessionType ?? '')) continue;
    if (!Number.isFinite(Date.parse(session.creationTime ?? ''))) continue;
    const list = attempts.get(session.jobId) ?? [];
    list.push({
      id: session.id,
      startedAt: session.creationTime,
      endedAt: session.endTime,
      result: session.result?.result,
    });
    attempts.set(session.jobId, list);
  }
  for (const list of attempts.values()) {
    list.sort((a, b) => Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? ''));
  }
  return attempts;
};

/**
 * Each job's runs, newest first, its retries folded in by the one rule in
 * runs.ts. Every attempt, the one still going included: a point is written
 * by a session while it runs, and must be placed in it.
 */
const jobRuns = (
  attempts: Map<string, SessionAttempt[]>,
  schedules: ReadonlyMap<string, VeeamSchedule>,
): Map<string, Run<SessionAttempt>[]> =>
  new Map([...attempts].map(([jobId, list]) => [jobId, runsOf(list, retryWindowOf(schedules.get(jobId)))]));

/**
 * When each job's sessions were on the clock, oldest first.
 *
 * A session's window is what the point lookup needs: a point written at 01:31
 * belongs to whatever was running at 01:31, whatever id the point carries.
 */
const runWindows = (runs: Map<string, Run<SessionAttempt>[]>): Map<string, RunWindow[]> => {
  const windows = new Map<string, RunWindow[]>();
  for (const [jobId, list] of runs) {
    const flat: RunWindow[] = [];
    for (const { attempts } of list) {
      const opener = attempts[attempts.length - 1].id;
      for (const attempt of attempts) {
        flat.push({
          id: attempt.id,
          from: Date.parse(attempt.startedAt ?? ''),
          // A session still running has no end; it owns everything since it began.
          to: attempt.endedAt ? Date.parse(attempt.endedAt) : Number.POSITIVE_INFINITY,
          failed: attempt.result === 'failed',
          run: opener,
        });
      }
    }
    windows.set(jobId, flat.sort((a, b) => a.from - b.from));
  }
  return windows;
};

/** The newest session that was on the clock at `at`. */
const coveringOf = (windows: RunWindow[] | undefined, at: number): RunWindow | undefined => {
  let covering: RunWindow | undefined;
  for (const window of windows ?? []) {
    if (window.from > at) break;
    if (at <= window.to && (!covering || window.from > covering.from)) covering = window;
  }
  return covering;
};

/**
 * The failed session that wrote this point, if a failed one did.
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
const failedSessionOf = (
  covering: RunWindow | undefined,
  sessionId: string | undefined,
  results: Map<string, string>,
): string | undefined => {
  if (covering) return covering.failed ? covering.id : undefined;
  return sessionId !== undefined && results.get(sessionId) === 'failed' ? sessionId : undefined;
};

/**
 * The run of a point nothing else places: the same as the point before it
 * (newer, in the order points are read) when that one is close enough.
 */
const nearby = (last: Map<string, { key: string; at: number }>, jobId: string, at: number): string => {
  const previous = last.get(jobId);
  if (previous && previous.at - at <= SAME_RUN_MS) {
    previous.at = at;
    return previous.key;
  }
  const key = `near:${at}`;
  last.set(jobId, { key, at });
  return key;
};

/**
 * Consecutive failed *runs* per job, counted back from its newest session.
 *
 * A run is not a session: Veeam retries a failed job automatically, and each
 * retry is its own session, so a job with the default three retries reports
 * four failed sessions for one failed run — which made "4 неуспеха подряд"
 * appear against nearly every currently-failing job and mean nothing. Which
 * sessions are one run is decided in runs.ts, the same rule the alert's
 * "Попытка 2 из 4" reads; this only picks the attempts to hand it.
 */
const failureStreaks = (
  attempts: Map<string, SessionAttempt[]>,
  schedules: ReadonlyMap<string, VeeamSchedule>,
  now: number,
): Map<string, number> => {
  const since = now - STREAK_WINDOW_DAYS * 86_400_000;
  const streaks = new Map<string, number>();
  for (const [jobId, list] of attempts) {
    // A run still going has not failed. And a streak is about a job that is
    // broken now: counting back through a year of history would report "forty
    // failed runs in a row" for a job nobody has touched since spring.
    const finished = list.filter((attempt) => attempt.endedAt && Date.parse(attempt.startedAt ?? '') >= since);
    const streak = failureStreakOf(finished, retryWindowOf(schedules.get(jobId)));
    if (streak > 0) streaks.set(jobId, streak);
  }
  return streaks;
};
