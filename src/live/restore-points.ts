import { escapeHtml } from '../telegram/format';
import { dayOf, LiveClock, longMoment, paged, plural, stampOf } from './format';

/**
 * Where each job's restore points stand against its own rhythm.
 *
 * 🛡 Protection answers "is this job past its deadline" and lists only the ones
 * that are. This one lists everything that is supposed to be running, with the
 * question an operator actually asks of a job: how many points are there, when
 * was the newest taken, and has it quietly skipped runs since.
 *
 * "Skipped" can only be measured against the job's own cadence, and the cadence
 * has to be inferred. A weekly job two days stale is fine; a nightly one two
 * days stale has missed two backups. The same number of days means opposite
 * things, so the list is ordered by missed runs, never by age.
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
  /** Epoch ms of the oldest and newest point. */
  oldest?: number;
  newest?: number;
  /**
   * The job's own interval in days, learned from its recent points. Null when
   * there is too little history to tell, and then nothing is claimed about
   * missed runs rather than a cadence being guessed.
   */
  intervalDays?: number | null;
}

export interface RestorePointsSnapshot {
  jobs: JobDepth[];
  /** Jobs that are supposed to run but have no restore point at all. */
  without: number;
  /** Left out on purpose — they are not supposed to be producing points. */
  excludedDisabled: number;
  excludedUnscheduled: number;
  /** Points left by runs that ended in an error; counted, then not counted. */
  failedPoints: number;
  /** Chains no live job owns — detailed in the 🧹 slot, summarised here. */
  orphanBackups: number;
  orphanPoints: number;
  /**
   * Whether the 🧹 slot is published, and so whether there is anywhere to send
   * a reader. Said outright rather than inferred from the counts being zero:
   * the counts used to be zeroed upstream to suppress this line, which meant
   * the decision lived in the caller and could only be tested by running a
   * whole cycle and grepping the message for an absent emoji.
   */
  crossLink: boolean;
  /** The freshest restore point in the estate, whichever job made it. */
  newest?: { name: string; at: number };
  unavailable?: string;
}

/** At or below this many retained runs a job has no usable history. */
export const THIN_RUNS = 1;

/**
 * Runs a job may be behind before it is called out.
 *
 * One is the honest threshold — a nightly job that skipped last night skipped a
 * backup — but a run still in progress, or one that started late, would read as
 * a miss. The count therefore only begins at the second interval.
 */
const MISSED_ALERT = 1;

/** How far behind its own schedule a job is, in runs. Null when unknowable. */
const missedRuns = (job: JobDepth, now: number): number | null => {
  if (!job.intervalDays || job.newest === undefined) return null;
  const ageDays = (now - job.newest) / DAY;
  return Math.max(0, Math.floor(ageDays / job.intervalDays) - 1);
};

/**
 * Messages this topic may occupy.
 *
 * One message holds about fifty of these rows and the estate has ninety, so a
 * single message would mean either dropping half the list or going back to
 * rows too terse to read. The list continues into a second message instead,
 * kept current exactly like the first.
 */
const MAX_PAGES = 2;

export const renderRestorePoints = (
  snapshot: RestorePointsSnapshot,
  clock: LiveClock,
): string[] => {
  const footer = `<i>Обновлено ${stampOf(clock.now, clock)}</i>`;

  if (snapshot.unavailable) {
    return [
      [
        '⚠️ <b>Точки восстановления не прочитаны</b>',
        '',
        escapeHtml(snapshot.unavailable),
        '',
        footer,
      ].join('\n'),
    ];
  }

  const now = clock.now.getTime();
  const missed = new Map(snapshot.jobs.map((job) => [job, missedRuns(job, now)]));

  // Said out loud: a list that silently shrank would be worse than one that is
  // too long, because the operator would not know what is outside it.
  const skipped: string[] = [];
  if (snapshot.excludedUnscheduled) {
    skipped.push(`${snapshot.excludedUnscheduled} без расписания`);
  }
  if (snapshot.excludedDisabled) skipped.push(`${snapshot.excludedDisabled} выключено`);
  const skippedLine = skipped.length ? `<b>Не учитываются:</b> ${skipped.join(', ')}` : null;

  if (snapshot.jobs.length === 0) {
    return [
      ['🗂 <b>Точек восстановления нет ни у одного задания</b>', '', skippedLine, footer]
        .filter((line): line is string => line !== null)
        .join('\n'),
    ];
  }

  // Furthest behind its own schedule first. That end of the list is the one
  // somebody has to act on, and it is the end that survives the trim.
  const sorted = [...snapshot.jobs].sort(byUrgency(missed));
  const behind = sorted.filter((job) => (missed.get(job) ?? 0) >= MISSED_ALERT).length;
  const totalPoints = sorted.reduce((sum, job) => sum + job.points, 0);
  const thin = sorted.filter((job) => job.runs <= THIN_RUNS).length;

  const tail = [
    '',
    `<b>Заданий:</b> ${sorted.length}` +
      (snapshot.without ? ` (+${snapshot.without} без точек)` : ''),
    `<b>Отстают от расписания:</b> ${behind || 'нет'}`,
    thin
      ? `<b>Только одна точка:</b> ${thin} ${plural(thin, 'задание', 'задания', 'заданий')}`
      : null,
    skippedLine,
    // Points belonging to backups no live job owns are not counted here;
    // saying "всего" would disagree with what Veeam reports.
    `<b>Точек у этих заданий:</b> ${totalPoints}`,
    // Named rather than quietly dropped: a point that exists in Veeam but not
    // here is exactly the kind of difference that makes a report distrusted.
    snapshot.failedPoints
      ? `<b>Не в счёт:</b> ${snapshot.failedPoints} ${plural(snapshot.failedPoints, 'точка', 'точки', 'точек')} от прогонов с ошибкой`
      : null,
    snapshot.crossLink && snapshot.orphanBackups
      ? `<b>Сверх того, без заданий:</b> ${snapshot.orphanPoints} ${plural(snapshot.orphanPoints, 'точка', 'точки', 'точек')} в ${snapshot.orphanBackups} ${plural(snapshot.orphanBackups, 'цепочке', 'цепочках', 'цепочках')} — см. 🧹`
      : null,
    snapshot.newest
      ? `<b>Последняя точка:</b> ${escapeHtml(snapshot.newest.name)}, ${dayOf(new Date(snapshot.newest.at).toISOString(), clock)}`
      : null,
    '<i>Считаются только точки успешных прогонов. Пропуски — по собственному' +
      ' ритму задания: сколько его обычных интервалов прошло с последней точки.</i>',
    footer,
  ].filter((line): line is string => line !== null);

  return paged(sorted.length, MAX_PAGES, (from, take, closing) => {
    const lines =
      from === 0
        ? [
            '🗂 <b>Точки восстановления</b>',
            '<i>Сначала те, кто отстал от своего расписания.</i>',
            '',
          ]
        : ['🗂 <b>Точки восстановления — продолжение</b>', ''];

    for (const job of sorted.slice(from, from + take)) {
      lines.push(depthLine(job, missed.get(job) ?? null, clock));
    }

    if (!closing) {
      // Every page carries the timestamp, so a page that stopped being
      // refreshed is visible on its own rather than only next to its first.
      lines.push('', footer);
      return lines.join('\n');
    }

    const rest = sorted.length - (from + take);
    if (rest > 0) {
      lines.push(`…и ещё ${rest} ${plural(rest, 'задание', 'задания', 'заданий')} по графику`);
    }
    lines.push(...tail);
    return lines.join('\n');
  });
};

/**
 * Most runs behind first; within the same standing, the stalest point first.
 *
 * A job whose cadence could not be learned sorts among the on-time ones, but
 * its age still floats it upwards there, because "we cannot tell" is not the
 * same as "fine".
 */
const byUrgency =
  (missed: Map<JobDepth, number | null>) =>
  (a: JobDepth, b: JobDepth): number =>
    (missed.get(b) ?? 0) - (missed.get(a) ?? 0) ||
    (a.newest ?? 0) - (b.newest ?? 0) ||
    a.name.localeCompare(b.name);

/**
 * One line, spelled out: name, how many points, how far behind, and exactly
 * when the newest point was taken.
 *
 * The date is written in full rather than as "5 дней назад" because this is the
 * line somebody reads before opening Veeam, and a relative age has to be
 * translated back into a moment before it can be checked against anything.
 */
const depthLine = (job: JobDepth, missed: number | null, clock: LiveClock): string => {
  const icon =
    missed === null ? '⚪' : missed >= 2 ? '🔴' : missed >= MISSED_ALERT ? '🟠' : '🟢';

  const facts = [`${job.points} ${plural(job.points, 'точка', 'точки', 'точек')}`];
  if (missed !== null && missed >= MISSED_ALERT) {
    facts.push(
      `${plural(missed, 'пропущен', 'пропущено', 'пропущено')} ${missed} ${plural(missed, 'запуск', 'запуска', 'запусков')}`,
    );
  }
  if (job.newest !== undefined) facts.push(longMoment(job.newest, clock));

  return `${icon} ${escapeHtml(job.name)} — ${facts.join(' · ')}`;
};
