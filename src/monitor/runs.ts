import { VeeamSchedule } from '../veeam/types';
import { isBadResult } from './job-state';

/**
 * Runs: which sessions of a job are one run.
 *
 * Veeam retries a failed job by starting another session, so a single bad night
 * looks like three or four separate failures to anything reading the session
 * list. Three readers need the answer — the alert saying which attempt this is,
 * the failure streak in 🛡 Protection, and the run list on a job card — and each
 * used to fold sessions by a rule of its own. The streak linked attempts start
 * to start, so an attempt that ran longer than the allowance began a "new run":
 * one night the alert called "3 из 4" was, to 🛡, three failed runs in a row.
 * This module is the one rule they all read.
 *
 * Two sessions are the same run when the older one went wrong and the newer
 * one started inside the retry window of the older one *finishing*. The window
 * comes from the job's own retry policy, with an allowance for how long the
 * failing attempt itself took.
 */

/** One session of a job, as far as telling runs apart needs it. */
export interface Attempt {
  /** ISO instant the session started. */
  startedAt?: string;
  /** ISO instant it ended; absent while it is still going. */
  endedAt?: string;
  /** Veeam's result, in whatever case Veeam wrote it. */
  result?: string;
}

/** One execution of a job, including its automatic retries. */
export interface Run<T extends Attempt = Attempt> {
  /** Newest first, as the sessions endpoint returns them; never empty. */
  attempts: T[];
  /**
   * Lower-cased result of the newest attempt. A run succeeded if the attempt
   * that finished it succeeded, whatever the earlier attempts did.
   */
  result: string;
}

/** Veeam's default wait between retries, when the job does not state one. */
const DEFAULT_AWAIT_MINUTES = 10;

/** Allowance for the length of the failing attempt, on top of the wait. */
const RUN_ALLOWANCE_MINUTES = 20;

/** Longest gap that still counts as "Veeam retried", from the job's policy. */
export const retryWindowOf = (schedule: VeeamSchedule | undefined): number => {
  const retry = schedule?.retry;
  // Retries switched off means no gap is a retry; the allowance still applies,
  // because two runs of the same job can otherwise never be told apart at all.
  const wait = retry?.isEnabled === false ? 0 : retry?.awaitMinutes ?? DEFAULT_AWAIT_MINUTES;
  return (wait + RUN_ALLOWANCE_MINUTES) * 60_000;
};

/** How many attempts Veeam is allowed, or undefined when it will not retry. */
export const retriesAllowed = (schedule: VeeamSchedule | undefined): number | undefined => {
  const retry = schedule?.retry;
  if (!retry?.isEnabled || !retry.retryCount) return undefined;
  // retryCount is retries after the first attempt; an operator counts attempts.
  return retry.retryCount + 1;
};

const resultOf = (attempt: Attempt): string => (attempt.result ?? '').toLowerCase();

/** Whether `newer` is Veeam retrying the run `older` belongs to. */
const isRetryOf = (newer: Attempt, older: Attempt, windowMs: number): boolean => {
  // A good attempt ends its run: nothing retries a success.
  if (!isBadResult(resultOf(older))) return false;
  const started = Date.parse(newer.startedAt ?? '');
  const ended = Date.parse(older.endedAt ?? older.startedAt ?? '');
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return false;
  return started - ended <= windowMs;
};

/** Folds a job's sessions, newest first, into its runs, newest first. */
export const runsOf = <T extends Attempt>(newestFirst: T[], windowMs: number): Run<T>[] => {
  const runs: Run<T>[] = [];
  let attempts: T[] = [];
  newestFirst.forEach((attempt, index) => {
    attempts.push(attempt);
    const older = newestFirst[index + 1];
    if (older && isRetryOf(attempt, older, windowMs)) return;
    runs.push({ attempts, result: resultOf(attempts[0]) });
    attempts = [];
  });
  return runs;
};

/** Which attempt of its run the newest session is; 1 when nothing links to it. */
export const attemptOf = (newestFirst: Attempt[], windowMs: number): number =>
  runsOf(newestFirst, windowMs)[0]?.attempts.length ?? 1;

/**
 * Consecutive runs that did not succeed, counted back from the newest.
 *
 * Stops at the first run that succeeded, which is what makes "three in a row"
 * mean a job that is still broken rather than one that failed thrice at some
 * point. A run that ended in a warning did not succeed.
 */
export const failureStreakOf = (newestFirst: Attempt[], windowMs: number): number => {
  let streak = 0;
  for (const run of runsOf(newestFirst, windowMs)) {
    if (run.result === 'success') break;
    streak += 1;
  }
  return streak;
};
