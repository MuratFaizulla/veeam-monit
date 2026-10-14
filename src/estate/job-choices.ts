import { Job } from '../veeam/estate';
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
