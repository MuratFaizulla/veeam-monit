import { Retention } from '../estate/evidence';
import { describeFulls, fullKindOf } from '../estate/full-schedule';
import {
  everyRunFull,
  JobPoints,
  missedRunsWords,
  owedDaysWords,
  PointStanding,
  PointVerdict,
  verdictIcon,
  verdictOf,
} from '../estate/point-verdict';
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

/** One job's restore points, by name. Where they stand is `verdictOf`'s to say. */
export interface JobDepth extends JobPoints {
  name: string;
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
 * Messages this topic may occupy.
 *
 * Only the jobs that need somebody are listed, and on an ordinary day they fit
 * in one message. On a bad one — a repository gone and every job behind — a
 * job takes two or three lines and one message holds about twenty-five, so the
 * list continues into further messages, each kept current exactly like the
 * first and numbered so their order shows.
 */
const MAX_PAGES = 5;

/**
 * The standings a job can have, in the order they are listed.
 *
 * Behind first: that end of the list is the one somebody has to act on, and it
 * is the end that survives the trim. Then the ones that back up on time but
 * whose scheduled Full did not happen, the most such days first: their chain
 * grows past what was planned, and every restore reads through all of it.
 * "We cannot tell" next, because it is not the same as "fine".
 *
 * The ones on time are not listed, only counted. All ninety used to be, and
 * the eight that needed somebody were three messages down among eighty-two
 * that did not; any one of those is a /points away.
 */
type Standing = PointStanding;
type Judged = PointVerdict;
type Listed = Exclude<Standing, 'onTime'>;
const STANDINGS: readonly Standing[] = ['behind', 'fullMissed', 'unknown', 'onTime'];
const HEADING: Record<Listed, string> = {
  behind: '<b>Отстают от своего расписания</b>',
  fullMissed: '<b>Пропущен Full по расписанию</b> · <i>больше пропусков — выше</i>',
  unknown: '<b>Ритм ещё не ясен</b>',
};

/** Dates shown in a row's missed-Full line before the rest are only counted. */
const OWED_SHOWN = 5;

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

  const judged = new Map(snapshot.jobs.map((job) => [job, verdictOf(job, clock)]));
  const judgedOf = (job: JobDepth): Judged => judged.get(job) as Judged;
  const standing = (job: JobDepth): Standing => judgedOf(job).standing;

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

  const sorted = [...snapshot.jobs].sort(byStanding(judgedOf));
  const listed = sorted.filter((job) => standing(job) !== 'onTime');
  const onTime = sorted.length - listed.length;
  const behind = sorted.filter((job) => standing(job) === 'behind').length;
  const fullMissed = sorted.filter((job) => judgedOf(job).owed.length > 0).length;
  const totalPoints = sorted.reduce((sum, job) => sum + job.points, 0);
  const thin = sorted.filter((job) => job.runs <= THIN_RUNS).length;
  // Named, because most of them are on time and so not in the list above.
  const fullsOnly = sorted.filter(everyRunFull).map((job) => job.name);

  const tail = [
    '',
    `<b>Заданий:</b> ${sorted.length}` +
      (snapshot.without ? ` (+${snapshot.without} без точек)` : ''),
    `<b>Отстают от расписания:</b> ${behind || 'нет'}`,
    `<b>Пропущен Full по расписанию:</b> ` +
      (fullMissed ? `${fullMissed} ${plural(fullMissed, 'задание', 'задания', 'заданий')}` : 'нет'),
    thin
      ? `<b>Только одна точка:</b> ${thin} ${plural(thin, 'задание', 'задания', 'заданий')}`
      : null,
    // The question the Active Full schedule raises, answered from what is on
    // disk: a job whose every run is a Full reads its machines whole each
    // time. TTC_Exchange ran on Fridays with its Active Full on Fridays, and
    // had no increment at all.
    fullsOnly.length
      ? `<b>Каждый запуск — Full, без инкрементов:</b> ${namesOf(fullsOnly)}`
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
      ' точки, поэтому точек бывает больше, чем дней хранения. Full пропущен, если после' +
      ' последнего Full прошёл день, на который настройка задания назначает Active или' +
      ' Synthetic Full, а полного бэкапа не было. Точка машины, упавшей' +
      ' в своём прогоне, не считается; точки остальных машин того же прогона считаются.' +
      ' Пропуски — по собственному ритму задания: сколько его обычных интервалов' +
      ' прошло с последней точки.</i>',
    footer,
  ].filter((line): line is string => line !== null);

  // Where the rest went, and how to ask about any one of them.
  const onTimeLines =
    listed.length === 0
      ? [
          `🟢 <b>Все ${onTime} ${plural(onTime, 'задание', 'задания', 'заданий')} — по расписанию</b>, Full проходят вовремя.`,
          'Точки любого задания: /points часть имени',
        ]
      : onTime > 0
        ? [
            `🟢 <b>Ещё ${onTime} ${plural(onTime, 'задание', 'задания', 'заданий')} — по расписанию</b>, в список не включены.`,
            'Точки любого из них: /points часть имени',
          ]
        : [];

  const pages = paged(listed.length, MAX_PAGES, (from, take, closing) => {
    const lines = [`🗂 <b>Точки восстановления</b>${PAGE_MARK}`];
    if (from === 0 && listed.length > 0) {
      lines.push(
        '<i>Только задания, которым нужно внимание.' +
          ' «3 точки» — на столько моментов можно откатить каждую ВМ задания.' +
          ' «Full 16.09 + 2 инкр.» — цепочка, которая пишется сейчас: полный бэкап' +
          ' и инкременты после него.</i>',
      );
    }

    let previous: Standing | undefined;
    for (const job of listed.slice(from, from + take)) {
      // Every page opens with its heading, so a page read on its own still
      // says which part of the list it holds.
      if (standing(job) !== previous) {
        previous = standing(job);
        lines.push('', HEADING[previous as Listed]);
      }
      lines.push(...rowOf(job, judgedOf(job), clock));
    }

    if (!closing) {
      // Every page carries the timestamp, so a page that stopped being
      // refreshed is visible on its own rather than only next to its first.
      lines.push('', footer);
      return lines.join('\n');
    }

    const rest = listed.length - (from + take);
    if (rest > 0) {
      lines.push('', `…и ещё ${rest} ${plural(rest, 'задание', 'задания', 'заданий')} — не поместились`);
    }
    if (onTimeLines.length > 0) lines.push('', ...onTimeLines);
    lines.push(...tail);
    return lines.join('\n');
  });

  return pages.map((page, index) =>
    page.replace(PAGE_MARK, pages.length > 1 ? ` · ${index + 1}/${pages.length}` : ''),
  );
};

/** Names shown in a summary line before the rest are only counted. */
const NAMES_SHOWN = 10;

/** "TTC_Exchange, TTC_WAP и ещё 3", escaped. */
const namesOf = (names: string[]): string => {
  const shown = names.slice(0, NAMES_SHOWN).map(escapeHtml).join(', ');
  return names.length > NAMES_SHOWN ? `${shown} и ещё ${names.length - NAMES_SHOWN}` : shown;
};

/**
 * Behind first, most runs behind first; then the ones whose scheduled Full did
 * not happen, most such days first; then the ones nobody can judge, stalest
 * first; then the rest, which are counted rather than listed. By name where
 * all that is the same.
 */
const byStanding =
  (judgedOf: (job: JobDepth) => Judged) =>
  (a: JobDepth, b: JobDepth): number => {
    const [ja, jb] = [judgedOf(a), judgedOf(b)];
    const order = STANDINGS.indexOf(ja.standing) - STANDINGS.indexOf(jb.standing);
    if (order !== 0) return order;
    switch (ja.standing) {
      case 'behind':
        return (jb.missed ?? 0) - (ja.missed ?? 0) || (a.newest ?? 0) - (b.newest ?? 0) || a.name.localeCompare(b.name);
      case 'fullMissed':
        return jb.owed.length - ja.owed.length || increments(b) - increments(a) || a.name.localeCompare(b.name);
      case 'unknown':
        return (a.newest ?? 0) - (b.newest ?? 0) || a.name.localeCompare(b.name);
      case 'onTime':
        return a.name.localeCompare(b.name);
    }
  };

/**
 * Increments written since the newest Full. A job whose server does not type
 * its points has no number to show, and goes after every one that has.
 */
const increments = (job: JobDepth): number => job.chain?.sinceFull ?? -1;

/**
 * Two lines: what the job is and when it last wrote, then how far back each of
 * its machines reaches, the chain it is adding to, when it is set to take a
 * Full and what it is told to keep. A third, when a scheduled Full did not
 * happen: the days it did not, to be looked up in Veeam.
 *
 * The newest point is a day and a minute rather than "5 дней назад" because
 * this is the line somebody reads before opening Veeam, and a relative age has
 * to be translated back into a moment before it can be checked against
 * anything. The rest are days: since when, and when the chain began.
 */
const rowOf = (job: JobDepth, verdict: Judged, clock: Clock): string[] => {
  const { missed, owed, standing } = verdict;
  let head = `${verdictIcon(verdict)} <b>${escapeHtml(job.name)}</b>`;
  if (job.machines > 0) head += ` · ${job.machines} ВМ`;
  if (job.newest !== undefined) head += ` — ${momentOf(job.newest, clock)}`;
  if (standing === 'behind' && missed !== null) head += `, ${missedRunsWords(missed)}`;

  let reach = `${job.runs} ${plural(job.runs, 'точка', 'точки', 'точек')}`;
  if (job.runs > 1 && job.oldest !== undefined) reach += ` с ${dateOf(job.oldest, clock)}`;
  const facts = [
    reach,
    job.chain ? chainWords(job.runs, job.chain, clock) : undefined,
    job.fulls ? describeFulls(job.fulls) : undefined,
    retentionOf(job.retention),
  ].filter((fact): fact is string => fact !== undefined);

  if (owed.length === 0) return [head, `└ ${facts.join(' · ')}`];

  const days = owedDaysWords(owed, clock.now.getTime(), OWED_SHOWN);
  return [head, `├ ${facts.join(' · ')}`, `└ ⚠️ Пропущен ${fullKindOf(job.fulls ?? [])}: ${days}`];
};

const retentionOf = (retention: Retention | undefined): string | undefined => {
  if (!retention) return undefined;
  const { quantity, unit } = retention;
  return unit === 'days'
    ? `хранение ${quantity} дн.`
    : `хранение ${quantity} ${plural(quantity, 'точка', 'точки', 'точек')}`;
};
