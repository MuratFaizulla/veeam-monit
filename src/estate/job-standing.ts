import { Job } from '../veeam/estate';
import { RetainedHistory, Retention, ScannedEvidence } from './evidence';
import { FullSchedule } from './full-schedule';
import { isDisabled } from './job-state';

/**
 * What each job is owed, and what it has.
 *
 * "Is this job excused from having a restore point?" used to be answered twice,
 * in two places, from two copies of the same predicate — once on the way into
 * 🛡 Protection and once inside the builder for 🗂 Restore points. Each kept its
 * own count of what it had excluded, both counts were printed, and the rule
 * that they must agree lived in a comment asking the next reader to keep them
 * in the same order.
 *
 * This answers it once. Both slots read the result, so they cannot disagree
 * about which jobs are in scope or how many were left out.
 *
 * It deliberately does not decide whether a job is *late*. The two slots ask
 * different questions of the same standing — "how many runs has it skipped"
 * and "is this past the deadline worth reporting" — and collapsing those into
 * one rule would either drop the floor that stops an hourly job being reported
 * for a single miss, or move the alerting threshold. Both are decisions about
 * what to alarm on, not about what a job is owed.
 */

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
const excuseFor = (job: Job, evidence: ScannedEvidence): Excuse | null => {
  if (isDisabled(job)) return 'disabled';
  if (evidence.unscheduled.has(job.id)) return 'unscheduled';
  return null;
};

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
    judged.push({
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
  }

  return { judged, excludedDisabled, excludedUnscheduled };
};
