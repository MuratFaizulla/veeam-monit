import { Job } from '../veeam/estate';

/**
 * What Veeam's own words for a job mean.
 *
 * `status` and `lastResult` are free-form strings whose case differs between
 * builds. The result is lower-cased once, when the job is read (`Job.result`);
 * the status is read here. The rule for it had settled into a `Set` here, a
 * literal comparison there, and `(job.status ?? '').toLowerCase() ===
 * 'disabled'` written out in three modules. Each copy was right; there was simply nowhere to add the next status
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

export const statusOf = (job: Job): string => (job.status ?? '').toLowerCase();

export const isRunning = (job: Job): boolean => RUNNING.has(statusOf(job));

/** Which job ids Veeam has a Working session for: `WorkingSessions.byJob`, or any set of ids. */
export interface WorkingJobs {
  has(jobId: string): boolean;
}

/**
 * Whether the job is transferring right now, from both sources that know.
 *
 * Each one misses runs the other sees. A job's own status misses a run somebody
 * started by hand on a job that is switched off: Veeam keeps reporting that job
 * as `disabled` while it transfers. A Working session misses a run that is
 * queued rather than transferring — waiting on a repository slot, say — where
 * the status is the only evidence.
 *
 * `working` says which job ids have a Working session. The union never shows
 * fewer than either source alone, and having it written once is what stops the
 * ▶️ list and the summary from reporting different numbers of running jobs —
 * which they did, because each counted its own way.
 */
export const isRunningNow = (job: Job, working: WorkingJobs): boolean =>
  isRunning(job) || working.has(job.id);

/** Switched off in Veeam. Says nothing about whether it is transferring. */
export const isDisabled = (job: Job): boolean => statusOf(job) === 'disabled';

export const isBadResult = (result: string): boolean => BAD.has(result);

/**
 * The result worth remembering, given what was already known.
 *
 * `none` is not a result. Veeam reports it while a job is running and before a
 * job has ever run, and recording it over a real one erases the fact that the
 * job is failing. Two things depend on that fact, and both were broken by it:
 *
 *   - a recovery is defined as "the previous result was bad", so a job that
 *     failed, retried, and finally succeeded went `failed → none → success`
 *     and its recovery was never announced at all;
 *   - an unchanged failure is silent because the previous result equals the new
 *     one, so the same broken run going `failed → none → failed` through its
 *     retries was announced again on every attempt.
 *
 * Both are the same mistake, and this is the one place it was made.
 */
export const rememberedResult = (result: string, previous: string | undefined): string =>
  result === 'none' && previous !== undefined ? previous : result;

/** One glyph per result, so every list spells the same outcome the same way. */
export const iconOf = (result: string): string => {
  if (result === 'success') return '🟢';
  if (result === 'warning') return '🟡';
  if (result === 'failed') return '🔴';
  return '⚪';
};
