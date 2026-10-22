import { Clock } from '../telegram/time';
import { Job } from '../veeam/estate';
import { Evidence } from './evidence';
import { assessProtection, ProtectionThresholds, Severity, standingsOf } from './job-standing';
import { isDisabled, isRunning } from './job-state';

/** How a job stands, by Veeam's own state: what its key in the job menu is marked with. */
export type JobMark = 'failed' | 'warning' | 'running' | 'success' | 'none' | 'disabled';

/** A job as the job menu offers it. */
export interface JobChoice {
  name: string;
  mark: JobMark;
}

/** What comes first. A job that never ran is among the fine ones, by name. */
const RANK: Record<JobMark, number> = { failed: 0, warning: 1, running: 2, success: 3, none: 3, disabled: 4 };

const markOf = (job: Job): JobMark => {
  if (isRunning(job)) return 'running';
  if (isDisabled(job)) return 'disabled';
  return job.result === 'failed' || job.result === 'warning' || job.result === 'success' ? job.result : 'none';
};

/**
 * Every job, as the job menu lists them: what is not in order first, failed
 * before warning, then what is running, then the rest by name, and the ones
 * switched off last.
 */
export const jobChoicesOf = (jobs: Job[]): JobChoice[] =>
  jobs
    .map((job) => ({ name: job.name, mark: markOf(job) }))
    .sort((a, b) => RANK[a.mark] - RANK[b.mark] || a.name.localeCompare(b.name, undefined, { numeric: true }));

/**
 * How a job stands by 🛡's verdict: what its key in the points menu is marked
 * with. `none` is a job nobody expects points from, or every job while there
 * is no Evidence to judge them by.
 */
export type PointsMark = Severity | 'fine' | 'none';

/** A job as the points menu offers it. */
export interface PointsChoice {
  name: string;
  mark: PointsMark;
}

/**
 * Every job, as the points menu lists them: the ones 🛡 lists first, in 🛡's
 * order — the worst first — then the fine ones by name, and last the ones
 * nobody expects points from. Judged by the one rule 🛡 and /points judge by;
 * while the Evidence is pending, every job by name.
 */
export const pointsChoicesOf = (jobs: Job[], evidence: Evidence, clock: Clock, thresholds: ProtectionThresholds): PointsChoice[] => {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true });
  if (evidence.status !== 'ready') return jobs.map((job) => ({ name: job.name, mark: 'none' as const })).sort(byName);
  const standings = standingsOf(jobs, evidence);
  const { risks } = assessProtection({ standings, now: clock.now.getTime(), timezone: clock.timezone, ...thresholds });
  const listed = new Set(risks.map((risk) => risk.id));
  const judged = new Set(standings.judged.map((standing) => standing.id));
  return [
    ...risks.map((risk): PointsChoice => ({ name: risk.name, mark: risk.severity })),
    ...jobs.filter((job) => judged.has(job.id) && !listed.has(job.id)).map((job): PointsChoice => ({ name: job.name, mark: 'fine' })).sort(byName),
    ...jobs.filter((job) => !judged.has(job.id)).map((job): PointsChoice => ({ name: job.name, mark: 'none' })).sort(byName),
  ];
};
