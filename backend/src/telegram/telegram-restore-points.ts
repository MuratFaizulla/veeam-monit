import { escapeHtml } from './telegram.format';
import { dayOf, fitted, LiveClock, plural, stampOf } from './telegram-live.format';

/**
 * How much history each job actually has.
 *
 * 🛡 Protection answers "is there a recent restore point at all". This answers
 * the next question: how far back can you go. They fail differently — a job can
 * run perfectly every night and still keep exactly one recoverable state,
 * which is fine until the corruption you need to roll back past is older than
 * that one point.
 *
 * The number that matters is *runs*, not restore points. Veeam creates one
 * point per protected machine per run, so a job covering eight VMs reports
 * eight times the points while offering exactly the same set of moments to
 * restore to.
 */

const DAY = 86_400_000;

export interface JobDepth {
  name: string;
  /** Distinct runs retained — the moments this job can be restored to. */
  runs: number;
  /** Restore point objects, which is runs × machines. */
  points: number;
  /** Machines the job protects. */
  machines: number;
  /** Epoch ms of the oldest and newest point, for the span. */
  oldest?: number;
  newest?: number;
}

export interface RestorePointsSnapshot {
  jobs: JobDepth[];
  /** Jobs with no restore point at all; 🛡 Protection covers those. */
  without: number;
  thinRuns: number;
  /** Chains no live job owns — detailed in the 🧹 slot, summarised here. */
  orphanBackups: number;
  orphanPoints: number;
  /** The freshest restore point in the estate, whichever job made it. */
  newest?: { name: string; at: number };
  unavailable?: string;
}

/** At or below this many retained runs a job has no usable history. */
export const THIN_RUNS = 1;
/** At or below this, history is thin enough to be worth a second look. */
const SHALLOW_RUNS = 3;

export const renderRestorePoints = (
  snapshot: RestorePointsSnapshot,
  clock: LiveClock,
): string => {
  const footer = `<i>Обновлено ${stampOf(clock.now, clock)}</i>`;

  if (snapshot.unavailable) {
    return [
      '⚠️ <b>Точки восстановления не прочитаны</b>',
      '',
      escapeHtml(snapshot.unavailable),
      '',
      footer,
    ].join('\n');
  }

  if (snapshot.jobs.length === 0) {
    return ['🗂 <b>Точек восстановления нет ни у одного задания</b>', '', footer].join('\n');
  }

  // Thinnest history first: that is the end of the list somebody needs to act
  // on, and it is the end that survives when the message has to be trimmed.
  const sorted = [...snapshot.jobs].sort(byDepth);
  const totalPoints = sorted.reduce((sum, job) => sum + job.points, 0);

  const tail = [
    '',
    `<b>Заданий:</b> ${sorted.length}` +
      (snapshot.without ? ` (+${snapshot.without} без точек)` : ''),
    // Points belonging to backups no live job owns are not counted here;
    // saying "всего" would disagree with what Veeam reports.
    `<b>Точек у этих заданий:</b> ${totalPoints}`,
    snapshot.thinRuns
      ? `<b>Только одно состояние:</b> ${snapshot.thinRuns} ${plural(snapshot.thinRuns, 'задание', 'задания', 'заданий')}`
      : null,
    snapshot.orphanBackups
      ? `<b>Сверх того, без заданий:</b> ${snapshot.orphanPoints} ${plural(snapshot.orphanPoints, 'точка', 'точки', 'точек')} в ${snapshot.orphanBackups} ${plural(snapshot.orphanBackups, 'цепочке', 'цепочках', 'цепочках')} — см. 🧹`
      : null,
    snapshot.newest
      ? `<b>Последняя точка:</b> ${escapeHtml(snapshot.newest.name)}, ${dayOf(new Date(snapshot.newest.at).toISOString(), clock)}`
      : null,
    footer,
  ].filter((line): line is string => line !== null);

  return fitted(sorted.length, (shown) => {
    const lines = ['🗂 <b>Глубина истории по заданиям</b>', ...LEGEND, ''];
    for (const job of sorted.slice(0, shown)) lines.push(depthLine(job));
    const rest = sorted.length - shown;
    if (rest > 0) {
      lines.push(`…и ещё ${rest} ${plural(rest, 'задание', 'задания', 'заданий')} поглубже`);
    }
    lines.push(...tail);
    return lines.join('\n');
  });
};

/**
 * The suffix on each number is the whole explanation.
 *
 * A positional legend — "(прогонов · точек · задание · период)" — only works if
 * every row has every column, and these rows do not: a single-machine job has
 * as many points as runs, so the column is dropped. A reader then counts
 * columns against the legend and lands on the wrong one. Naming the unit on the
 * number itself makes the row readable wherever it is cut.
 */
const LEGEND = [
  '<i>п — прогонов: столько моментов для отката · д — дней истории',
  'т — точек Veeam: машин × прогонов; нет «т» — машина одна</i>',
];

/** Fewest runs first, then the shortest span. */
const byDepth = (a: JobDepth, b: JobDepth): number =>
  a.runs - b.runs || spanDays(a) - spanDays(b) || a.name.localeCompare(b.name);

const spanDays = (job: JobDepth): number =>
  job.oldest !== undefined && job.newest !== undefined ? (job.newest - job.oldest) / DAY : 0;

/**
 * One line per job: every number up front with its unit, then the name.
 *
 * Spelling the units out in words cost about 25 characters a row, which is 2500
 * across the estate — the difference between listing every job and listing two
 * thirds of them. A one-letter suffix costs one character and replaces a
 * separator, so the rows got shorter and readable at the same time.
 */
const depthLine = (job: JobDepth): string => {
  const icon = job.runs <= THIN_RUNS ? '🔴' : job.runs <= SHALLOW_RUNS ? '🟠' : '🟢';
  const span = spanDays(job);
  const points = job.points === job.runs ? '' : ` ${job.points}т`;
  const period = job.runs > 1 && span >= 1 ? ` ${Math.round(span)}д` : '';
  return `${icon} ${job.runs}п${points}${period} · ${escapeHtml(job.name)}`;
};
