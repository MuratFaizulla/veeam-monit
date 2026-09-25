import { NotificationSeverity } from '../telegram/types';
import { Job } from '../veeam/estate';
import { isBadResult, rememberedResult } from './job-state';

/**
 * Which job alerts a cycle owes, and what to remember afterwards.
 *
 * The monitor used to decide this inline, in private methods only a whole
 * cycle through a fake Veeam and a fake Telegram could reach — and the paths
 * nobody had driven that way, warnings among them, were simply untested. This
 * is the decision alone: the job list and what was remembered go in, one
 * transition per job comes out. Sending the alert and recording the result
 * once it is delivered stay with the monitor, because "a delivery that reached
 * nobody has not dealt with anything" is about the send, not the rule.
 */

/** What one job's new state means. */
export interface Transition {
  job: Job;
  /** Lower-cased result Veeam reports now; `none` while a run is going. */
  result: string;
  /** The result remembered from before, if any. */
  previous?: string;
  /** The alert this is worth, or null when it is not worth one. */
  severity: NotificationSeverity | null;
  /**
   * What to remember once any alert is delivered. Never `none` over something
   * known: that is what lost every recovery and re-announced every retry.
   */
  remember: string;
}

/**
 * One transition per job, in the order given.
 *
 * `seeding` is an installation that has never been observed: everything is
 * noted and nothing is announced, because announcing history as if it had just
 * happened is worse than a quiet first cycle.
 */
export const jobTransitions = (
  jobs: Job[],
  remembered: (jobId: string) => string | undefined,
  seeding: boolean,
): Transition[] =>
  jobs.map((job) => {
    const { result } = job;
    const previous = remembered(job.id);
    const severity = seeding || previous === result ? null : severityOf(result, previous);
    return { job, result, previous, severity, remember: rememberedResult(result, previous) };
  });

/** Null means the change is not worth a message (e.g. into "running"). */
const severityOf = (result: string, previous: string | undefined): NotificationSeverity | null => {
  if (result === 'failed') return 'critical';
  if (result === 'warning') return 'warning';
  // Success is only interesting as a recovery: reporting every scheduled
  // success would bury the failures it is supposed to make visible.
  if (result === 'success' && previous && isBadResult(previous)) return 'success';
  return null;
};
