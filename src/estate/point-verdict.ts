import { Clock, plural } from '../telegram/time';
import { ChainShape, RetainedRun, Retention, ScannedEvidence } from './evidence';
import { FullSchedule, missedFullDays } from './full-schedule';

/**
 * Where one job's restore points stand at a moment: behind its own rhythm, past
 * a scheduled Full it did not take, too new to judge, or fine.
 *
 * 🗂 lists the jobs by it and /points answers about one job by it. It used to
 * be the 🗂 renderer's own, and a second reader would have been a second copy
 * of the rule — and a job the topic called behind that /points called fine.
 */

const DAY = 86_400_000;

/** What the Evidence knows of one job's restore points, gathered. */
export interface JobPoints {
  /** Distinct runs retained — the moments each machine can be restored to. */
  runs: number;
  /** Restore point objects, which is runs × machines: Veeam's own count. */
  points: number;
  /** Machines the job protects. */
  machines: number;
  /** Epoch ms of the oldest and newest point. */
  oldest?: number;
  newest?: number;
  /**
   * The job's own interval in days, learned from its recent points. Null when
   * there is too little history to tell, and then nothing is claimed about
   * missed runs rather than a cadence being guessed.
   */
  intervalDays?: number | null;
  /** Absent when Veeam did not say which points are full. */
  chain?: ChainShape;
  /** What the job is configured to keep; absent when its configuration did not say. */
  retention?: Retention;
  /** The periodic Fulls it is set to take; absent when its configuration did not say. */
  fulls?: FullSchedule[];
  /** Its retained runs, oldest first; absent where nobody listed them. */
  retained?: RetainedRun[];
}

/**
 * Runs a job may be behind before it is called out.
 *
 * One is the honest threshold — a nightly job that skipped last night skipped a
 * backup — but a run still in progress, or one that started late, would read as
 * a miss. The count therefore only begins at the second interval.
 */
export const MISSED_ALERT = 1;

export type PointStanding = 'behind' | 'fullMissed' | 'unknown' | 'onTime';

/** Where one job stands now. */
export interface PointVerdict {
  /** Runs it is behind its own rhythm; null when the rhythm is unknown. */
  missed: number | null;
  /** The days its scheduled Full was owed and not taken, as `Date.UTC` midnights. */
  owed: number[];
  /**
   * Behind outranks a missed Full: a job that is not backing up at all has a
   * bigger problem than the shape of its chain.
   */
  standing: PointStanding;
}

/** How far behind its own schedule a job is, in runs. Null when unknowable. */
const missedRuns = (job: JobPoints, now: number): number | null => {
  if (!job.intervalDays || job.newest === undefined) return null;
  const ageDays = (now - job.newest) / DAY;
  return Math.max(0, Math.floor(ageDays / job.intervalDays) - 1);
};

/**
 * A Full is only owed where Veeam said which points are full and the job's
 * configuration said when it takes them.
 */
export const verdictOf = (job: JobPoints, clock: Clock): PointVerdict => {
  const now = clock.now.getTime();
  const missed = missedRuns(job, now);
  const since = job.chain ? job.chain.lastFull ?? job.oldest : undefined;
  const owed =
    job.fulls && job.fulls.length > 0 && since !== undefined
      ? missedFullDays(job.fulls, since, now, clock.timezone)
      : [];
  const standing: PointStanding =
    missed !== null && missed >= MISSED_ALERT
      ? 'behind'
      : owed.length > 0
        ? 'fullMissed'
        : missed === null
          ? 'unknown'
          : 'onTime';
  return { missed, owed, standing };
};

/** The mark a job carries wherever its points are shown. */
export const verdictIcon = ({ missed, standing }: PointVerdict): string =>
  standing === 'fullMissed'
    ? '🟡'
    : missed === null
      ? '⚪'
      : missed >= 2
        ? '🔴'
        : missed >= MISSED_ALERT
          ? '🟠'
          : '🟢';

/** Whether every retained run of the job wrote a Full, so it has no increments at all. */
export const everyRunFull = (job: JobPoints): boolean =>
  job.runs > 1 && job.chain !== undefined && job.chain.fulls === job.runs;

/**
 * "12.09", or "12.09.2025" in another year, from a `Date.UTC` midnight: the
 * calendar day itself, which a time zone would only move.
 */
export const owedDayLabel = (day: number, now: number): string => {
  const date = new Date(day);
  const label = `${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  return date.getUTCFullYear() === new Date(now).getUTCFullYear() ? label : `${label}.${date.getUTCFullYear()}`;
};

/** "12.09, 19.09, 26.09", the newest `shown` of them, and how many earlier ones were left out. */
export const owedDaysWords = (owed: number[], now: number, shown: number): string => {
  const days = owed.slice(-shown).map((day) => owedDayLabel(day, now)).join(', ');
  return owed.length > shown ? `${days} и ещё ${owed.length - shown} раньше` : days;
};

/** "пропущено 2 запуска". */
export const missedRunsWords = (missed: number): string =>
  `${plural(missed, 'пропущен', 'пропущено', 'пропущено')} ${missed} ${plural(missed, 'запуск', 'запуска', 'запусков')}`;

/** "7 дней", "14 точек": what a job is told to keep, as the job card and /points say it. */
export const retentionWords = ({ quantity, unit }: Retention): string =>
  unit === 'days'
    ? `${quantity} ${plural(quantity, 'день', 'дня', 'дней')}`
    : `${quantity} ${plural(quantity, 'точка', 'точки', 'точек')}`;

/**
 * One job's points as the Evidence holds them, gathered from its maps; absent
 * when the job has no point in the list the scan reads.
 */
export const jobPointsOf = (evidence: ScannedEvidence, jobId: string): JobPoints | undefined => {
  const depth = evidence.depthByJob.get(jobId);
  if (!depth) return undefined;
  return {
    ...depth,
    intervalDays: evidence.cadenceByJob.get(jobId) ?? null,
    retention: evidence.retentionByJob.get(jobId),
    fulls: evidence.fullsByJob.get(jobId),
  };
};
