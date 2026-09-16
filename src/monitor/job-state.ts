import { VeeamJobState } from '../veeam/types';

/**
 * What Veeam's own words for a job mean.
 *
 * `status` and `lastResult` are free-form strings whose case differs between
 * builds, so every reader has to lower-case before comparing. That rule had
 * settled into a `Set` here, a literal comparison there, and
 * `(job.status ?? '').toLowerCase() === 'disabled'` written out in three
 * modules. Each copy was right; there was simply nowhere to add the next status
 * without finding all of them first — and the one time that mattered, a job
 * reported as `disabled` while it was transferring went missing from the list
 * of running jobs and the count said so confidently.
 */

/**
 * Statuses that mean "running right now", lower-cased.
 *
 * `Idle` is deliberately absent: a continuously running job sits in it between
 * transfers, and listing those as active would make the live message
 * permanently wrong.
 */
const RUNNING = new Set([
  'working',
  'running',
  'starting',
  'stopping',
  'pausing',
  'resuming',
  'postprocessing',
]);

/** Results that mean "this run went wrong", lower-cased. */
const BAD = new Set(['failed', 'warning']);

/** The last result, lower-cased; `none` where Veeam reports nothing at all. */
export const resultOf = (job: VeeamJobState): string =>
  (job.lastResult ?? '').toLowerCase() || 'none';

export const statusOf = (job: VeeamJobState): string => (job.status ?? '').toLowerCase();

export const isRunning = (job: VeeamJobState): boolean => RUNNING.has(statusOf(job));

/** Switched off in Veeam. Says nothing about whether it is transferring. */
export const isDisabled = (job: VeeamJobState): boolean => statusOf(job) === 'disabled';

export const isBadResult = (result: string): boolean => BAD.has(result);

/** One glyph per result, so every list spells the same outcome the same way. */
export const iconOf = (result: string): string => {
  if (result === 'success') return '🟢';
  if (result === 'warning') return '🟡';
  if (result === 'failed') return '🔴';
  return '⚪';
};
