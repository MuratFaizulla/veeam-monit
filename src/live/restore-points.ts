import { ChainShape, Retention } from '../estate/evidence';
import { escapeHtml } from '../telegram/format';
import { chainWords } from '../telegram/words';
import { dateOf, dayOf, footerOf, Clock, momentOf, paged, plural } from './format';

/**
 * Where each job's restore points stand against its own rhythm.
 *
 * 🛡 Protection answers "is this job past its deadline" and lists only the ones
 * that are. This one lists everything that is supposed to be running, with the
 * questions an operator actually asks of a job: how far back can each of its
 * machines be restored, what chain is it adding to, when was the newest point
 * taken, and has it quietly skipped runs since.
 *
 * "Skipped" can only be measured against the job's own cadence, and the cadence
 * has to be inferred. A weekly job two days stale is fine; a nightly one two
 * days stale has missed two backups. The same number of days means opposite
 * things, so the ones behind are listed apart, ahead of everything else.
 *
 * A job's count is per machine. It used to be Veeam's own count, one point per
 * machine per run, and TTC_Billing_Prod read "69 точек" for three nights of
 * twenty-three machines — a number nobody can hold against a retention of
 * seven days, and which made a job twice the size look twice as protected.
 */

const DAY = 86_400_000;

export interface JobDepth {
  name: string;
  /** Distinct runs retained — the moments each machine can be restored to. */
  runs: number;
  /** Restore point objects, which is runs × machines: Veeam's own count. */
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
  /** Absent when Veeam did not say which points are full. */
  chain?: ChainShape;
  /** What the job is configured to keep; absent when its configuration did not say. */
  retention?: Retention;
}

export interface RestorePointsSnapshot {
  jobs: JobDepth[];
  /** Jobs that are supposed to run but have no restore point at all. */
  without: number;
  /**
   * Replicas and the like: their points are kept where this list is not read
   * from, and 🛡 judges them by their runs. Counted apart from `without`, which
   * would otherwise say every one of them has nothing.
   */
  elsewhere: number;
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
 * A job takes two lines — what it is and when it last wrote, then how far back
 * it reaches and what chain it is on — so one message holds about thirty, and
 * the estate has ninety. The list continues into further messages instead,
 * each kept current exactly like the first and numbered so their order shows.
 */
const MAX_PAGES = 4;

/**
 * The three standings a job can have, in the order they are listed.
 *
 * Behind first: that end of the list is the one somebody has to act on, and it
 * is the end that survives the trim. "We cannot tell" next, because it is not
 * the same as "fine". The ones on time last, by name, which is how somebody
 * looking for one job finds it.
 */
type Standing = 'behind' | 'unknown' | 'onTime';
const STANDINGS: readonly Standing[] = ['behind', 'unknown', 'onTime'];
const HEADING: Record<Standing, string> = {
  behind: '<b>Отстают от своего расписания</b>',
  unknown: '<b>Ритм ещё не ясен</b>',
  onTime: '<b>По расписанию</b>',
};

const standingOf = (missed: number | null): Standing =>
  missed === null ? 'unknown' : missed >= MISSED_ALERT ? 'behind' : 'onTime';

/**
 * Written into the title while the pages are fitted, then replaced by "1/3".
 * As long as what replaces it, so a page that fitted still fits.
 */
const PAGE_MARK = ' · 0/0';

export const renderRestorePoints = (
  snapshot: RestorePointsSnapshot,
  clock: Clock,
): string[] => {
  const footer = footerOf(clock);

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
  const standing = (job: JobDepth): Standing => standingOf(missed.get(job) ?? null);

  // Said out loud: a list that silently shrank would be worse than one that is
  // too long, because the operator would not know what is outside it.
  const skipped: string[] = [];
  if (snapshot.excludedUnscheduled) {
    skipped.push(`${snapshot.excludedUnscheduled} без расписания`);
  }
  if (snapshot.excludedDisabled) skipped.push(`${snapshot.excludedDisabled} выключено`);
  if (snapshot.elsewhere) {
    skipped.push(
      `${snapshot.elsewhere} ${plural(snapshot.elsewhere, 'задание', 'задания', 'заданий')} с точками вне этого списка (репликации и др.)`,
    );
  }
  const skippedLine = skipped.length ? `<b>Не учитываются:</b> ${skipped.join(', ')}` : null;

  if (snapshot.jobs.length === 0) {
    return [
      ['🗂 <b>Точек восстановления нет ни у одного задания</b>', '', skippedLine, footer]
        .filter((line): line is string => line !== null)
        .join('\n'),
    ];
  }

  const sorted = [...snapshot.jobs].sort(byStanding(missed, standing));
  const behind = sorted.filter((job) => standing(job) === 'behind').length;
  const totalPoints = sorted.reduce((sum, job) => sum + job.points, 0);
  const thin = sorted.filter((job) => job.runs <= THIN_RUNS).length;
  const fullsOnly = sorted.filter(everyRunFull).length;

  const tail = [
    '',
    `<b>Заданий:</b> ${sorted.length}` +
      (snapshot.without ? ` (+${snapshot.without} без точек)` : ''),
    `<b>Отстают от расписания:</b> ${behind || 'нет'}`,
    thin
      ? `<b>Только одна точка:</b> ${thin} ${plural(thin, 'задание', 'задания', 'заданий')}`
      : null,
    // The question the Active Full schedule raises, answered from what is on
    // disk: a job whose every run is a Full reads its machines whole each
    // time. TTC_Exchange ran on Fridays with its Active Full on Fridays, and
    // had no increment at all.
    fullsOnly
      ? `<b>Каждый запуск — Full, без инкрементов:</b> ${fullsOnly} ${plural(fullsOnly, 'задание', 'задания', 'заданий')}`
      : null,
    skippedLine,
    // Veeam's own count, one point per machine per run, so the two can be
    // held side by side. Points of backups no live job owns are not in it;
    // saying "всего" of them would disagree with what Veeam reports.
    `<b>Точек в Veeam у этих заданий:</b> ${totalPoints} (по точке на каждую ВМ в каждом запуске)`,
    // Named rather than quietly dropped: a point that exists in Veeam but not
    // here is exactly the kind of difference that makes a report distrusted.
    snapshot.failedPoints
      ? `<b>Не в счёт:</b> ${snapshot.failedPoints} ${plural(snapshot.failedPoints, 'точка', 'точки', 'точек')} машин, упавших в своём прогоне`
      : null,
    snapshot.crossLink && snapshot.orphanBackups
      ? `<b>Сверх того, без заданий:</b> ${snapshot.orphanPoints} ${plural(snapshot.orphanPoints, 'точка', 'точки', 'точек')} в ${snapshot.orphanBackups} ${plural(snapshot.orphanBackups, 'цепочке', 'цепочках', 'цепочках')} — см. 🧹`
      : null,
    snapshot.newest
      ? `<b>Последняя точка:</b> ${escapeHtml(snapshot.newest.name)}, ${dayOf(new Date(snapshot.newest.at).toISOString(), clock)}`
      : null,
    '<i>Прежняя цепочка удаляется целиком, когда срок хранения выйдет и у её последней' +
      ' точки, поэтому точек бывает больше, чем дней хранения. Точка машины, упавшей' +
      ' в своём прогоне, не считается; точки остальных машин того же прогона считаются.' +
      ' Пропуски — по собственному ритму задания: сколько его обычных интервалов' +
      ' прошло с последней точки.</i>',
    footer,
  ].filter((line): line is string => line !== null);

  const pages = paged(sorted.length, MAX_PAGES, (from, take, closing) => {
    const lines = [`🗂 <b>Точки восстановления</b>${PAGE_MARK}`];
    if (from === 0) {
      lines.push(
        '<i>«3 точки» — на столько моментов можно откатить каждую ВМ задания.' +
          ' «Full 16.09 + 2 инкр.» — цепочка, которая пишется сейчас: полный бэкап' +
          ' и инкременты после него.</i>',
      );
    }

    let previous: Standing | undefined;
    for (const job of sorted.slice(from, from + take)) {
      // Every page opens with its heading, so a page read on its own still
      // says which part of the list it holds.
      if (standing(job) !== previous) {
        previous = standing(job);
        lines.push('', HEADING[previous]);
      }
      lines.push(...rowOf(job, missed.get(job) ?? null, clock));
    }

    if (!closing) {
      // Every page carries the timestamp, so a page that stopped being
      // refreshed is visible on its own rather than only next to its first.
      lines.push('', footer);
      return lines.join('\n');
    }

    const rest = sorted.length - (from + take);
    if (rest > 0) {
      lines.push('', `…и ещё ${rest} ${plural(rest, 'задание', 'задания', 'заданий')} по графику`);
    }
    lines.push(...tail);
    return lines.join('\n');
  });

  return pages.map((page, index) =>
    page.replace(PAGE_MARK, pages.length > 1 ? ` · ${index + 1}/${pages.length}` : ''),
  );
};

/** Behind first, most runs behind first; then the ones nobody can judge, stalest first; then the rest by name. */
const byStanding =
  (missed: Map<JobDepth, number | null>, standing: (job: JobDepth) => Standing) =>
  (a: JobDepth, b: JobDepth): number => {
    const order = STANDINGS.indexOf(standing(a)) - STANDINGS.indexOf(standing(b));
    if (order !== 0) return order;
    if (standing(a) === 'onTime') return a.name.localeCompare(b.name);
    return (
      (missed.get(b) ?? 0) - (missed.get(a) ?? 0) ||
      (a.newest ?? 0) - (b.newest ?? 0) ||
      a.name.localeCompare(b.name)
    );
  };

/** Whether every retained run of the job wrote a Full, so it has no increments at all. */
const everyRunFull = (job: JobDepth): boolean =>
  job.runs > 1 && job.chain !== undefined && job.chain.fulls === job.runs;

/**
 * Two lines: what the job is and when it last wrote, then how far back each of
 * its machines reaches, the chain it is adding to and what it is told to keep.
 *
 * The newest point is a day and a minute rather than "5 дней назад" because
 * this is the line somebody reads before opening Veeam, and a relative age has
 * to be translated back into a moment before it can be checked against
 * anything. The rest are days: since when, and when the chain began.
 */
const rowOf = (job: JobDepth, missed: number | null, clock: Clock): [string, string] => {
  const icon =
    missed === null ? '⚪' : missed >= 2 ? '🔴' : missed >= MISSED_ALERT ? '🟠' : '🟢';

  let head = `${icon} <b>${escapeHtml(job.name)}</b>`;
  if (job.machines > 0) head += ` · ${job.machines} ВМ`;
  if (job.newest !== undefined) head += ` — ${momentOf(job.newest, clock)}`;
  if (missed !== null && missed >= MISSED_ALERT) {
    head += `, ${plural(missed, 'пропущен', 'пропущено', 'пропущено')} ${missed} ${plural(missed, 'запуск', 'запуска', 'запусков')}`;
  }

  let reach = `${job.runs} ${plural(job.runs, 'точка', 'точки', 'точек')}`;
  if (job.runs > 1 && job.oldest !== undefined) reach += ` с ${dateOf(job.oldest, clock)}`;
  const facts = [
    reach,
    job.chain ? chainWords(job.runs, job.chain, clock) : undefined,
    retentionOf(job.retention),
  ].filter((fact): fact is string => fact !== undefined);

  return [head, `└ ${facts.join(' · ')}`];
};

const retentionOf = (retention: Retention | undefined): string | undefined => {
  if (!retention) return undefined;
  const { quantity, unit } = retention;
  return unit === 'days'
    ? `хранение ${quantity} дн.`
    : `хранение ${quantity} ${plural(quantity, 'точка', 'точки', 'точек')}`;
};
