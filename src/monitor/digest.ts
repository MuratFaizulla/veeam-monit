import { escapeHtml } from '../telegram/format';
import { fitted, LiveClock, plural, stampOf } from '../live/format';
import { VeeamJobState } from '../veeam/types';
import { iconOf, isRunning, resultOf } from './job-state';

/**
 * Where every job stands, counted once.
 *
 * The alerts topic reports *changes*: a job that failed on Tuesday and has
 * failed the same way every night since produces exactly one message, on
 * Tuesday. That is the right behaviour for an alert and the wrong answer to
 * "how are we doing" — which is what this counts, by asking every job for its
 * last result rather than by reading the history of what was announced.
 *
 * The daily message and the `/digest` command are the same counting seen twice:
 * one is pushed at a fixed hour and one is pulled when somebody asks. Deleting
 * this module would put the counting back in both.
 */

export interface FailingJob {
  name: string;
  /** Lower-cased Veeam result: `failed` or `warning`. */
  result: string;
}

export interface DigestSummary {
  total: number;
  success: number;
  warning: number;
  failed: number;
  /** Jobs Veeam reports no result for at all — typically never run. */
  none: number;
  running: number;
  /** The jobs behind `failed` and `warning`: errors first, then by name. */
  failing: FailingJob[];
}

export const summarise = (jobs: VeeamJobState[]): DigestSummary => {
  const summary: DigestSummary = {
    total: jobs.length,
    success: 0,
    warning: 0,
    failed: 0,
    none: 0,
    running: 0,
    failing: [],
  };

  for (const job of jobs) {
    const result = resultOf(job);
    if (result === 'success') summary.success += 1;
    else if (result === 'warning') summary.warning += 1;
    else if (result === 'failed') summary.failed += 1;
    else summary.none += 1;

    // Counted from the status, not from the result: a job that is transferring
    // right now still carries the result of its previous run.
    if (isRunning(job)) summary.running += 1;

    if (result === 'failed' || result === 'warning') {
      summary.failing.push({ name: job.name ?? job.id ?? 'без имени', result });
    }
  }

  summary.failing.sort((a, b) =>
    a.result === b.result ? a.name.localeCompare(b.name) : a.result === 'failed' ? -1 : 1,
  );
  return summary;
};

/** Label/value rows for the daily notification event. */
export const digestFields = (
  summary: DigestSummary,
): Array<[string, string | number]> => [
  ['Всего заданий', summary.total],
  ['Успешно', summary.success],
  ['С предупреждением', summary.warning],
  ['С ошибкой', summary.failed],
  ['Выполняются', summary.running],
];

/** Which jobs are behind those counts, for the event's trailing block. */
export const digestBody = (summary: DigestSummary): string | undefined =>
  summary.failing
    .map((job) => `${job.result.toUpperCase()} — ${job.name}`)
    .join('\n')
    .slice(0, 3000) || undefined;

/**
 * The same figures as an answer in the chat.
 *
 * Rendered rather than routed: this one was asked for, so it belongs where the
 * question was asked. The daily event keeps going through the router, which is
 * the difference between a report somebody is waiting for and a report nobody
 * asked for.
 */
export const renderDigest = (summary: DigestSummary, clock: LiveClock): string =>
  fitted(summary.failing.length, (shown) => {
    const lines = [
      '📊 <b>Сводка по заданиям</b>',
      '',
      `<b>Всего заданий:</b> ${summary.total}`,
      `🟢 <b>Успешно:</b> ${summary.success}`,
      `🟡 <b>С предупреждением:</b> ${summary.warning}`,
      `🔴 <b>С ошибкой:</b> ${summary.failed}`,
    ];
    if (summary.running > 0) lines.push(`▶️ <b>Выполняются сейчас:</b> ${summary.running}`);
    if (summary.none > 0) lines.push(`⚪ <b>Ни разу не запускались:</b> ${summary.none}`);

    if (summary.failing.length === 0) {
      lines.push('', '✅ Ни одно задание не сообщает об ошибке.');
    } else {
      const count = summary.failing.length;
      lines.push(
        '',
        `<b>Требуют внимания — ${count} ${plural(count, 'задание', 'задания', 'заданий')}:</b>`,
      );
      for (const job of summary.failing.slice(0, shown)) {
        lines.push(`${iconOf(job.result)} ${escapeHtml(job.name)}`);
      }
      if (shown < count) lines.push(`<i>…и ещё ${count - shown}</i>`);
    }

    // Said here rather than left to the reader: these are the figures of the
    // moment the question was asked, not of a nightly cut-off.
    lines.push('', `<i>Состояние на ${stampOf(clock.now, clock)}</i>`);
    return lines.join('\n');
  });
