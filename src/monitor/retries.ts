import { VeeamSchedule } from '../veeam/types';
import { JobRun } from './job-card';
import { isBadResult } from './job-state';

/**
 * Telling one failing run from several.
 *
 * Veeam retries a failed job by starting another session, so a single bad night
 * looks like three or four separate failures to anything reading the session
 * list. The estate scan already had to collapse them to count a failure streak;
 * the alert had no idea and announced each attempt as its own incident, three
 * messages a night with identical text.
 *
 * Two sessions are the same run when the newer one started inside the retry
 * window of the older one finishing. The window comes from the job's own retry
 * policy, with an allowance for how long the failing attempt itself took.
 */

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

/**
 * Which attempt of the current run the newest session is.
 *
 * 1 when nothing older links to it. `runs` must be newest first, as the
 * sessions endpoint returns them.
 */
export const attemptOf = (runs: JobRun[], windowMs: number): number => {
  let attempt = 1;
  for (let i = 0; i + 1 < runs.length; i += 1) {
    const older = runs[i + 1];
    if (!isBadResult((older.result ?? '').toLowerCase())) break;
    const started = Date.parse(runs[i].startedAt ?? '');
    const ended = Date.parse(older.endedAt ?? older.startedAt ?? '');
    if (!Number.isFinite(started) || !Number.isFinite(ended)) break;
    if (started - ended > windowMs) break;
    attempt += 1;
  }
  return attempt;
};
