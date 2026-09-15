import { escapeHtml } from './telegram.format';
import { fitted, LiveClock, plural, stampOf } from './telegram-live.format';

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

  const summary = [
    `<b>Заданий:</b> ${sorted.length}` +
      (snapshot.without ? ` (+${snapshot.without} без точек)` : ''),
    // Points belonging to backups no live job owns are not counted here;
    // saying "всего" would disagree with what Veeam reports.
    `<b>Точек у этих заданий:</b> ${totalPoints}`,
    snapshot.thinRuns
      ? `<b>Только одно состояние:</b> ${snapshot.thinRuns} ${plural(snapshot.thinRuns, 'задание', 'задания', 'заданий')}`
      : null,
  ].filter((line): line is string => line !== null);

  const tail = [
    '',
    ...summary,
    '<i>Число — сколько прогонов можно восстановить; точки на каждую ВМ сложены.</i>',
    footer,
  ];

  return fitted(sorted.length, (shown) => {
    const lines = ['🗂 <b>Глубина истории по заданиям</b>', ''];
    for (const job of sorted.slice(0, shown)) lines.push(depthLine(job));
    const rest = sorted.length - shown;
    if (rest > 0) {
      lines.push(`…и ещё ${rest} ${plural(rest, 'задание', 'задания', 'заданий')} поглубже`);
    }
    lines.push(...tail);
    return lines.join('\n');
  });
};

/** Fewest runs first, then the shortest span. */
const byDepth = (a: JobDepth, b: JobDepth): number =>
  a.runs - b.runs || spanDays(a) - spanDays(b) || a.name.localeCompare(b.name);

const spanDays = (job: JobDepth): number =>
  job.oldest !== undefined && job.newest !== undefined ? (job.newest - job.oldest) / DAY : 0;

const depthLine = (job: JobDepth): string => {
  const icon = job.runs <= THIN_RUNS ? '🔴' : job.runs <= SHALLOW_RUNS ? '🟠' : '🟢';
  const detail: string[] = [];

  const span = spanDays(job);
  if (job.runs > 1 && span >= 1) detail.push(`за ${Math.round(span)} ${plural(Math.round(span), 'день', 'дня', 'дней')}`);
  if (job.machines > 1) detail.push(`${job.machines} ${plural(job.machines, 'ВМ', 'ВМ', 'ВМ')}`);
  if (job.points !== job.runs) detail.push(`${job.points} ${plural(job.points, 'точка', 'точки', 'точек')}`);

  const depth = `<b>${job.runs}</b> ${plural(job.runs, 'прогон', 'прогона', 'прогонов')}`;
  const suffix = detail.length ? ` · ${detail.join(' · ')}` : '';
  return `${icon} ${depth} · ${escapeHtml(job.name)}${suffix}`;
};
