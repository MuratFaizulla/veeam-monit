import { FullSchedule, fullKindOf, fullsOwedOn } from './full-schedule';

/**
 * How long a job's run usually takes: what ▶️ says beside one that is going.
 *
 * The job's own past runs say it, but only the runs like this one: a job that
 * takes forty minutes on a Tuesday takes six hours on the Saturday its Full is
 * owed, and "обычно ~40 мин" beside that Full would call every weekend run
 * late — fifty of them, some weekends. So a run that began on a day a Full is
 * owed is measured against the runs that began on such days, and any other
 * against the rest. Which day is which comes from the job's settings, as 🗂
 * reads them for the Fulls that were missed.
 *
 * Only runs that went through at their first attempt are counted: one Veeam
 * had to retry says how long the failure took, and its retry did only the
 * machines that failed.
 */

/** One run that went through at its first attempt. */
export interface CleanRun {
  /** When it began, epoch ms. */
  startedAt: number;
  /** How long it took, ms. */
  took: number;
}

/** How long the runs like one going now took. */
export interface UsualRun {
  /** The median of them. */
  took: number;
  /** The longest of them. */
  longest: number;
  /** "Synthetic Full" when the run going now is owed one; absent on any other day. */
  full?: string;
}

/** The newest runs alike that are counted: the last ten nights, or the last ten Saturdays. */
const SAMPLES = 10;

/** Fewer than this say nothing about what is usual. */
const ENOUGH = 3;

/**
 * Longer than usual is longer than every one of the runs alike, and half as
 * long again as the usual one. Either alone is too little: a job whose runs
 * all take 29 to 31 minutes is not late at 32, and one run as long as the
 * longest of the last ten is not late either.
 */
const LONGER = 1.5;

/**
 * How long the runs like one that began at `startedAt` took, or nothing when
 * the job has too few of them to tell.
 *
 * `runs` are newest first. `fulls` are the Fulls the job is set to take, and
 * undefined when its settings did not say: then every run is alike.
 */
export const usualRunOf = (
  runs: readonly CleanRun[] | undefined,
  fulls: FullSchedule[] | undefined,
  startedAt: number,
  timezone: string,
): UsualRun | undefined => {
  const owedOn = (at: number): FullSchedule[] => (fulls ? fullsOwedOn(fulls, at, timezone) : []);
  const owed = owedOn(startedAt);
  const full = owed.length > 0;
  const alike: number[] = [];
  for (const run of runs ?? []) {
    if (owedOn(run.startedAt).length > 0 === full) alike.push(run.took);
    if (alike.length === SAMPLES) break;
  }
  if (alike.length < ENOUGH) return undefined;
  alike.sort((a, b) => a - b);
  return {
    took: alike[Math.floor(alike.length / 2)],
    longest: alike[alike.length - 1],
    ...(full ? { full: fullKindOf(owed) } : {}),
  };
};

/** Whether a run going `elapsed` ms is longer than the runs like it. */
export const longerThanUsual = (usual: UsualRun, elapsed: number): boolean =>
  elapsed > Math.max(usual.longest, usual.took * LONGER);
