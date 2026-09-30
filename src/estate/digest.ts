import { NotificationEvent } from '../telegram/types';
import { Job } from '../veeam/estate';
import { isDisabled, isRunningNow, WorkingJobs } from './job-state';

/**
 * Where every job stands, counted once.
 *
 * The alerts topic reports *changes*: a job that failed on Tuesday and has
 * failed the same way every night since produces exactly one message, on
 * Tuesday. That is the right behaviour for an alert and the wrong answer to
 * "how are we doing" — which is what this counts, by asking every job for its
 * last result rather than by reading the history of what was announced.
 *
 * One shape, two deliveries: the daily message pushes this event through the
 * router at `TELEGRAM_DIGEST_HOUR`, and `/digest` renders the same event
 * straight back to whoever asked. They were briefly two renderings of the same
 * figures and immediately began to differ; there is now nothing to differ.
 */

export interface FailingJob {
  id: string;
  name: string;
  /** Lower-cased Veeam result: `failed` or `warning`. */
  result: string;
}

export interface DigestSummary {
  total: number;
  success: number;
  warning: number;
  failed: number;
  /**
   * Jobs switched off in Veeam, counted apart from the three results above
   * and never listed among the failing. Their last result is history: the
   * summary once listed a job as FAILED that had failed before somebody
   * switched it off, and nobody was expecting it to run again.
   */
  disabled: number;
  running: number;
  /**
   * Why the Working sessions could not be read, when they could not. The
   * running figure is then counted from job status alone, which misses every
   * run started by hand on a job switched off — and says so rather than
   * passing the smaller number off as the whole truth.
   */
  runningUnread?: string;
  /** The jobs behind `failed` and `warning`: errors first, then by name. */
  failing: FailingJob[];
}

/** Jobs from a digest that can be opened by a Telegram button. */
export const addressable = (summary: DigestSummary): Array<{ id: string; name: string }> =>
  summary.failing.map(({ id, name }) => ({ id, name }));

/**
 * `working` says which job ids Veeam has a Working session for — the cycle's
 * `WorkingSessions.byJob`, the same read ▶️ counts from.
 *
 * Required rather than optional: counting from the job status alone undercounts
 * every run started by hand on a job that is switched off, because Veeam keeps
 * reporting those as `disabled` while they transfer. That is the same
 * undercount the ▶️ slot had, and passing the set is what stops the two from
 * being able to disagree about how many jobs are running.
 */
export const summarise = (
  jobs: Job[],
  working: WorkingJobs,
  workingUnread?: string,
): DigestSummary => {
  const summary: DigestSummary = {
    total: jobs.length,
    success: 0,
    warning: 0,
    failed: 0,
    disabled: 0,
    running: 0,
    runningUnread: workingUnread,
    failing: [],
  };

  for (const job of jobs) {
    // Counted from the status and the sessions, not from the result: a job
    // transferring right now still carries the result of its previous run.
    // A run somebody started by hand on a job that is off is still a run.
    if (isRunningNow(job, working)) summary.running += 1;

    if (isDisabled(job)) {
      summary.disabled += 1;
      continue;
    }

    const { result } = job;
    if (result === 'success') summary.success += 1;
    else if (result === 'warning') summary.warning += 1;
    else if (result === 'failed') summary.failed += 1;

    if (result === 'failed' || result === 'warning') {
      summary.failing.push({ id: job.id, name: job.name, result });
    }
  }

  summary.failing.sort((a, b) =>
    a.result === b.result ? a.name.localeCompare(b.name) : a.result === 'failed' ? -1 : 1,
  );
  return summary;
};

/**
 * Room for the list of jobs, inside Telegram's 4096 with the header allowed for.
 *
 * Cut on a line boundary and never by the generic truncation: the list is
 * rendered inside a `<pre>` block, and a cut that lands between `<pre>` and
 * `</pre>` produces markup Telegram rejects outright.
 */
const BODY_LIMIT = 3400;

const bodyOf = (summary: DigestSummary): string | undefined => {
  const lines = summary.failing.map((job) => `${job.result.toUpperCase()} — ${job.name}`);
  if (lines.length === 0) return undefined;

  const whole = lines.join('\n');
  if (whole.length <= BODY_LIMIT) return whole;

  let kept = 0;
  let size = 0;
  while (kept < lines.length && size + lines[kept].length + 1 <= BODY_LIMIT) {
    size += lines[kept].length + 1;
    kept += 1;
  }
  return [...lines.slice(0, kept), `…и ещё ${lines.length - kept}`].join('\n');
};

/**
 * The summary as an event.
 *
 * Not "за сутки": every figure is the standing of every job right now, which
 * is a different claim from what happened in the last day and was the wrong one
 * on any morning a job had not run since Friday.
 */
export const digestEvent = (summary: DigestSummary): NotificationEvent => ({
  kind: 'digest',
  severity: summary.failed ? 'critical' : summary.warning ? 'warning' : 'success',
  title: 'Veeam: сводка по заданиям',
  fields: [
    ['Всего заданий', summary.total],
    ['Успешно', summary.success],
    ['С предупреждением', summary.warning],
    ['С ошибкой', summary.failed],
    // Only when there are some: a line saying "0" on every morning is noise.
    ...(summary.disabled ? [['Выключены в Veeam', summary.disabled] as [string, number]] : []),
    [
      'Выполняются',
      summary.runningUnread === undefined
        ? summary.running
        : `${summary.running} (только по статусу заданий: сессии Veeam не прочитаны)`,
    ],
  ],
  body: bodyOf(summary),
});

/**
 * Whether the daily summary is due in this hour.
 *
 * The hour is the operator's, in TELEGRAM_TIMEZONE like every other time the
 * bot writes. It used to be the server process's own clock, which agreed only
 * where the container's TZ happened to be set to the same zone.
 */
export const digestDue = (now: Date, hour: number, timezone: string): boolean => {
  if (hour < 0) return false;
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || undefined,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  return Number(local) === hour;
};
