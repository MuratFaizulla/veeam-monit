import { plural } from '../telegram/time';
import { ChainShape, RetainedRun, Retention } from './evidence';
import { FullSchedule } from './full-schedule';
import type { JobStanding } from './job-standing';

/**
 * What the Evidence knows of one job's restore points, and the words they are
 * said in: how far back each machine reaches, the chain being written, what
 * the job is told to keep, the runs and Fulls it went without.
 *
 * Facts, not a verdict. Whether a job needs somebody is `verdictOf` in
 * `job-standing.ts`, which 🛡 lists by and /points opens with. This module used
 * to hold a verdict of its own, 🗂's — behind as soon as one run was skipped —
 * and /points went on judging by it after 🗂 became part of 🛡: a nightly job
 * two days without a point was fine in the topic and "behind" in the answer.
 */

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

/** One job's points, from its Standing; absent when it has no point in the list the scan reads. */
export const pointsOf = (job: JobStanding): JobPoints | undefined =>
  job.depth
    ? { ...job.depth, intervalDays: job.cadenceDays, retention: job.retention, fulls: job.fulls }
    : undefined;

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
