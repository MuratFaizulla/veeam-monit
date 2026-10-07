import type { AppConfig } from '../config/configuration';
import { Clock, dateOf, dayOf, everyLabel, momentOf, plural } from '../telegram/time';
import { Job } from '../veeam/estate';
import { RetainedHistory, Retention, ScannedEvidence } from './evidence';
import { FullSchedule, missedFullDays } from './full-schedule';
import { isDisabled } from './job-state';
import { missedRunsWords, owedDaysWords } from './point-facts';

/**
 * What each job is owed, what it has, and whether it needs somebody.
 *
 * "Is this job excused from having a restore point?" used to be answered twice,
 * in two places, from two copies of the same predicate — once on the way into
 * 🛡 Protection and once inside the builder for 🗂 Restore points. Each kept its
 * own count of what it had excluded, both counts were printed, and the rule
 * that they must agree lived in a comment asking the next reader to keep them
 * in the same order.
 *
 * Whether a job needs somebody is answered here too, against the clock when it
 * is asked (`verdictOf`), and in the words it is said in (`verdictWords`): 🛡
 * lists every job by it and /points opens with it, so the two cannot call the
 * same job fine and behind. They did, after 🗂 became part of 🛡: the verdict
 * was 🛡's own, and /points kept the one 🗂 had used.
 */

const DAY = 86_400_000;

/** Missed Full days a verdict names before the earlier ones are only counted. */
const OWED_SHOWN = 3;

/** Why a job owes nobody a restore point. */
export type Excuse = 'disabled' | 'unscheduled';

/** One job that is supposed to be producing restore points, and what it has. */
export interface JobStanding {
  id: string;
  name: string;
  type?: string;
  lastRun?: string;
  /** Run timestamps, newest first; empty when the job has no usable point. */
  runs: number[];
  /**
   * Whether `runs` are its good runs rather than its restore points: a
   * replica, or a job whose points Veeam keeps outside the list the scan reads.
   */
  byRuns: boolean;
  /** How often it runs, in days; null when its history is too short to tell. */
  cadenceDays: number | null;
  /** Consecutive failed runs, counted back from its newest session. */
  failures: number;
  /** Absent when the job has no restore point at all. */
  depth?: RetainedHistory;
  /** What its configuration tells Veeam to keep; absent when it did not say. */
  retention?: Retention;
  /** The periodic Fulls it is set to take; absent when its configuration did not say. */
  fulls?: FullSchedule[];
}

export interface Standings {
  judged: JobStanding[];
  excludedDisabled: number;
  excludedUnscheduled: number;
}

/**
 * A job is only excused on positive evidence.
 *
 * `disabled` comes from the runtime state and `unscheduled` from the job
 * configuration, which the evidence read. A job whose configuration could not
 * be read is judged: an unknown schedule is treated as a real one, because the
 * failure mode of the other choice is silently dropping a job from every check.
 */
export const excuseFor = (job: Job, evidence: ScannedEvidence): Excuse | null => {
  if (isDisabled(job)) return 'disabled';
  if (evidence.unscheduled.has(job.id)) return 'unscheduled';
  return null;
};

/** What one job has, gathered from the Evidence, whether or not it is excused. */
export const standingOf = (job: Job, evidence: ScannedEvidence): JobStanding => ({
  id: job.id,
  name: job.name,
  type: job.type,
  lastRun: job.lastRun,
  runs: evidence.runsByJob.get(job.id) ?? [],
  byRuns: evidence.provenByRuns.has(job.id),
  cadenceDays: evidence.cadenceByJob.get(job.id) ?? null,
  failures: evidence.streakByJob.get(job.id) ?? 0,
  depth: evidence.depthByJob.get(job.id),
  retention: evidence.retentionByJob.get(job.id),
  fulls: evidence.fullsByJob.get(job.id),
});

export const standingsOf = (jobs: Job[], evidence: ScannedEvidence): Standings => {
  const judged: JobStanding[] = [];
  let excludedDisabled = 0;
  let excludedUnscheduled = 0;

  for (const job of jobs) {
    const excuse = excuseFor(job, evidence);
    if (excuse === 'disabled') {
      excludedDisabled += 1;
      continue;
    }
    if (excuse === 'unscheduled') {
      excludedUnscheduled += 1;
      continue;
    }
    judged.push(standingOf(job, evidence));
  }

  return { judged, excludedDisabled, excludedUnscheduled };
};

/* ------------------------------------------------------------------ *
 * The verdict
 * ------------------------------------------------------------------ */

export interface ProtectionThresholds {
  /** Floor, in days. Nothing fresher than this is ever reported as late. */
  staleDays: number;
  /**
   * How many of a job's own intervals it may miss before it counts as overdue.
   * A weekly job is not late after three days; a hourly one is.
   */
  overdueFactor: number;
  /**
   * Consecutive failed runs that make a job worth reporting on their own.
   * Runs, not sessions: a job with retries enabled produces several failed
   * sessions per failed run.
   */
  minStreak: number;
}

/** The thresholds as configured, read in one place for 🛡 and /points. */
export const thresholdsOf = (
  config: Pick<AppConfig['telegram'], 'protectionStaleDays' | 'protectionOverdueFactor' | 'protectionFailureStreak'>,
): ProtectionThresholds => ({
  staleDays: config.protectionStaleDays,
  overdueFactor: config.protectionOverdueFactor,
  minStreak: config.protectionFailureStreak,
});

/**
 * What is wrong with a job, the worst first: no point at all, none for longer
 * than it may go, runs failing one after another while its point is still
 * fresh, a scheduled Full not taken while its backups go on.
 */
export type Trouble = 'none' | 'stale' | 'failing' | 'fullMissed';

/** 🔴 somebody should look today, 🟠 this week, 🟡 the chain is not as planned. */
export type Severity = 'critical' | 'warning' | 'notice';

/** Where one job stands now, and the facts it was judged by. */
export interface Verdict {
  /** What is wrong; absent when nothing is. */
  trouble?: Trouble;
  /** Present with a trouble. */
  severity?: Severity;
  /** Judged by its good runs, its restore points being kept elsewhere. */
  byRuns: boolean;
  /** Epoch ms of the newest restore point, or good run, when there is one. */
  lastPoint?: number;
  /** Days since it; null when the job has none at all. */
  ageDays: number | null;
  /** Past its deadline, or without a point at all. */
  overdue: boolean;
  /** The job's own typical interval in days, when it has enough history. */
  intervalDays: number | null;
  failures: number;
  lastRun?: string;
  /**
   * Runs it skipped by its own rhythm; absent when none, or when its rhythm or
   * points are unknown. Said beside the verdict, never decided by: one late
   * night is not a reason to wake anybody.
   */
  missed?: number;
  /** The days a scheduled Full was owed and not taken, as `Date.UTC` midnights. */
  owed: number[];
  /** Whether its Fulls could be checked at all: Veeam typed its points and its configuration named its Fulls. */
  fullsChecked: boolean;
  /** Epoch ms of the newest Full, where Veeam said which points are full. */
  lastFull?: number;
}

/**
 * Whether one job needs somebody, and why. Pure: judged against the clock it
 * is given, so the ages stay right between scans.
 */
export const verdictOf = (job: JobStanding, clock: Clock, thresholds: ProtectionThresholds): Verdict => {
  const { staleDays, overdueFactor, minStreak } = thresholds;
  const now = clock.now.getTime();
  const { runs, failures, cadenceDays: intervalDays } = job;
  const ageDays = runs.length ? (now - runs[0]) / DAY : null;

  // The deadline is the job's own schedule where it is known, but never
  // tighter than the configured floor: a job that runs hourly should not be
  // reported the moment it misses one run.
  const deadline = Math.max(staleDays, (intervalDays ?? staleDays) * overdueFactor);
  const overdue = ageDays === null || ageDays > deadline;

  // A rhythm and Fulls belong to points; a job judged by its runs has neither.
  const points = job.depth && !job.byRuns ? job.depth : undefined;
  // The count only begins at the second interval: a run still going, or one
  // that started late, is not a run skipped.
  const missed =
    points && intervalDays && ageDays !== null ? Math.max(0, Math.floor(ageDays / intervalDays) - 1) : 0;
  // A Full is only owed where Veeam said which points are full and the job's
  // configuration said when it takes them.
  const since = points?.chain ? points.chain.lastFull ?? points.oldest : undefined;
  const fulls = since !== undefined && job.fulls && job.fulls.length > 0 ? job.fulls : undefined;
  const owed = fulls && since !== undefined ? missedFullDays(fulls, since, now, clock.timezone) : [];

  const trouble: Trouble | undefined =
    ageDays === null ? 'none'
    : overdue ? 'stale'
    : failures >= minStreak ? 'failing'
    : owed.length > 0 ? 'fullMissed'
    : undefined;
  // "No restore point at all" and "twice past the deadline" are the two cases
  // where somebody should be looking today rather than this week.
  const severity: Severity | undefined =
    !trouble ? undefined
    : trouble === 'fullMissed' ? 'notice'
    : ageDays === null || ageDays > deadline * 2 ? 'critical'
    : 'warning';

  return {
    ...(trouble ? { trouble, severity } : {}),
    byRuns: job.byRuns,
    ...(runs.length ? { lastPoint: runs[0] } : {}),
    ageDays,
    overdue,
    intervalDays,
    failures,
    lastRun: job.lastRun,
    ...(missed ? { missed } : {}),
    owed,
    fullsChecked: fulls !== undefined,
    lastFull: points?.chain?.lastFull,
  };
};

/* ------------------------------------------------------------------ *
 * Every job's verdict: what 🛡 lists
 * ------------------------------------------------------------------ */

export interface ProtectionInput extends ProtectionThresholds {
  /** Which jobs are owed a restore point, and what each of them has. */
  standings: Standings;
  now: number;
  /** IANA zone the days a Full is owed on are counted in; empty for the server's own. */
  timezone?: string;
}

/** A job that needs somebody. */
export interface ProtectionRisk extends Verdict {
  id: string;
  name: string;
  type?: string;
  trouble: Trouble;
  severity: Severity;
}

export interface ProtectionSnapshot {
  /** The jobs that need somebody, the worst first. */
  risks: ProtectionRisk[];
  /** Jobs actually judged — excludes the ones below. */
  totalJobs: number;
  /** Jobs with a restore point inside their own expected interval. */
  protectedJobs: number;
  excludedDisabled: number;
  excludedUnscheduled: number;
  /** Why nothing was judged; the slot says it instead of claiming everything is fine. */
  unavailable?: string;
}

/** Decides which jobs need somebody, and why, the worst first. */
export const assessProtection = (input: ProtectionInput): ProtectionSnapshot => {
  const { standings, now } = input;
  const clock = { now: new Date(now), timezone: input.timezone ?? '' };
  const risks: ProtectionRisk[] = [];
  let protectedJobs = 0;

  for (const job of standings.judged) {
    const verdict = verdictOf(job, clock, input);
    // A failed attempt does not erase a usable restore point. The job is still
    // listed, but counted as protected while its point is fresh enough.
    if (!verdict.overdue) protectedJobs += 1;
    const { trouble, severity } = verdict;
    if (trouble && severity) risks.push({ ...verdict, id: job.id, name: job.name, type: job.type, trouble, severity });
  }

  risks.sort(compareRisk);

  return {
    risks,
    totalJobs: standings.judged.length,
    protectedJobs,
    excludedDisabled: standings.excludedDisabled,
    excludedUnscheduled: standings.excludedUnscheduled,
  };
};

const RANK: Record<Severity, number> = { critical: 0, warning: 1, notice: 2 };

/** The worst first, then the longest without a backup, then by name. */
const compareRisk = (a: ProtectionRisk, b: ProtectionRisk): number => {
  const age = (risk: ProtectionRisk): number =>
    risk.ageDays === null ? Number.POSITIVE_INFINITY : risk.ageDays;
  return RANK[a.severity] - RANK[b.severity] || age(b) - age(a) || b.owed.length - a.owed.length || a.name.localeCompare(b.name);
};

/* ------------------------------------------------------------------ *
 * The words
 * ------------------------------------------------------------------ */

/** The mark a verdict carries wherever it is shown. */
export const VERDICT_ICON: Record<Severity | 'fine', string> = {
  critical: '🔴',
  warning: '🟠',
  notice: '🟡',
  fine: '🟢',
};

/** A verdict as it is said: its mark, what is wrong, and the facts to check it by. */
export interface VerdictWords {
  icon: string;
  /** "нет бэкапа 5 дней", "в порядке": lower case, to follow a name or open a line. */
  problem: string;
  facts: string[];
}

/**
 * What 🛡 says of a job and what /points opens with, in the same words. The
 * newest point is a day and a minute, the moment to look up in Veeam, rather
 * than "5 дней назад", which has to be turned back into a moment before it can
 * be checked.
 */
export const verdictWords = (verdict: Verdict, clock: Clock): VerdictWords => {
  const now = clock.now.getTime();
  const streak = verdict.failures > 0 ? streakWords(verdict.failures) : undefined;
  const usually = verdict.intervalDays !== null ? `обычно ${everyLabel(verdict.intervalDays)}` : undefined;
  const last = verdict.lastPoint === undefined ? undefined : momentOf(verdict.lastPoint, clock);
  const owed = owedDaysWords(verdict.owed, now, OWED_SHOWN);
  const missed = verdict.missed ? missedRunsWords(verdict.missed) : undefined;

  const [problem, facts] = ((): [string, (string | undefined)[]] => {
    switch (verdict.trouble) {
      case 'none':
        // A replica's points are not in the list read, so "no points" would be
        // said of every replica whatever it did; what it lacks is a run that worked.
        return [
          verdict.byRuns ? 'нет успешных запусков' : 'нет ни одной точки',
          [verdict.lastRun ? `последний запуск ${dayOf(verdict.lastRun, clock)}` : undefined, streak],
        ];
      case 'stale':
        return [
          `нет ${verdict.byRuns ? 'успешного запуска' : 'бэкапа'} ${age(verdict.ageDays ?? 0)}`,
          [
            last ? `последний ${last}` : undefined,
            usually,
            missed,
            verdict.owed.length > 0 ? `не сделан Full ${owed}` : undefined,
            streak,
          ],
        ];
      case 'failing':
        return [streakWords(verdict.failures), [last ? `последний бэкап ${last}` : undefined, usually]];
      case 'fullMissed':
        return [
          `${plural(verdict.owed.length, 'пропущен', 'пропущены', 'пропущены')} Full ${owed}`,
          ['бэкапы идут', verdict.lastFull === undefined ? undefined : `последний Full ${dateOf(verdict.lastFull, clock)}`],
        ];
      default:
        // Never listed by 🛡; /points says it of one job, with what is worth
        // knowing although it needs nobody.
        return [
          'в порядке',
          [
            missed,
            streak,
            verdict.intervalDays === null ? 'ритм ещё не ясен' : undefined,
            verdict.fullsChecked ? 'Full вовремя' : undefined,
          ],
        ];
    }
  })();

  return {
    icon: VERDICT_ICON[verdict.severity ?? 'fine'],
    problem,
    facts: facts.filter((fact): fact is string => fact !== undefined),
  };
};

/** "5 неудачных запусков подряд", or "1 неудачный запуск": one failure is not a streak. */
const streakWords = (failures: number): string => {
  const runs = `${failures} ${plural(failures, 'неудачный запуск', 'неудачных запуска', 'неудачных запусков')}`;
  return failures > 1 ? `${runs} подряд` : runs;
};

/** Days, but readable when it is less than one. */
const age = (days: number): string => {
  if (days < 1) {
    const hours = Math.max(1, Math.round(days * 24));
    // 23.7 hours rounds to 24, which should read as a day rather than as a
    // second way of writing one.
    if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
    return '1 день';
  }
  const whole = Math.floor(days);
  return `${whole} ${plural(whole, 'день', 'дня', 'дней')}`;
};
