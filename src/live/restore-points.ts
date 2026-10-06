import {
  JobPoints,
  missedRunsWords,
  owedDaysWords,
  PointStanding,
  PointVerdict,
  verdictIcon,
  verdictOf,
} from '../estate/point-verdict';
import { escapeHtml } from '../telegram/format';
import { dateOf, footerOf, Clock, momentOf, paged, plural } from './format';

/**
 * Which jobs' restore points need somebody, a line each.
 *
 * 🛡 Protection answers "is this job past its deadline". This one answers it
 * by the job's own rhythm and its Full schedule: a weekly job two days stale is
 * fine, a nightly one two days stale has missed two backups, and a job that
 * backs up every night but skipped its Saturday Full is growing a chain nobody
 * planned for.
 *
 * It says that and nothing else. It used to give every listed job three lines
 * — points per machine, the chain, the Full schedule, retention — then ten
 * lines of totals and a paragraph of definitions, and an operator opening it
 * on 6 October could not tell what it wanted from them. Everything it dropped
 * is one /points away, per job, where there is room to explain it.
 */

/** One job's restore points, by name. Where they stand is `verdictOf`'s to say. */
export interface JobDepth extends JobPoints {
  name: string;
}

export interface RestorePointsSnapshot {
  jobs: JobDepth[];
  /** Jobs that are supposed to run but have no restore point at all, by name. */
  without: string[];
  /**
   * Replicas and the like: their points are kept where this list is not read
   * from, and 🛡 judges them by their runs. Counted apart from `without`, which
   * would otherwise say every one of them has nothing.
   */
  elsewhere: number;
  /** Left out on purpose — they are not supposed to be producing points. */
  excludedDisabled: number;
  excludedUnscheduled: number;
  unavailable?: string;
}

/**
 * Messages this topic may occupy.
 *
 * On an ordinary day the jobs that need somebody fit in one. On a bad one — a
 * repository gone and every job behind — the list continues into further
 * messages, each kept current exactly like the first and numbered so their
 * order shows.
 */
const MAX_PAGES = 5;

/**
 * What a listed job can be, in the order the list goes: no point at all, then
 * behind its rhythm, then a scheduled Full not taken, then too new to judge.
 * The ones on time are only counted; any of them is a /points away.
 */
type Section = 'without' | Exclude<PointStanding, 'onTime'>;
const SECTIONS: readonly Section[] = ['without', 'behind', 'fullMissed', 'unknown'];
const HEADING: Record<Section, string> = {
  without: 'Нет ни одной точки',
  behind: 'Пропускают бэкапы',
  fullMissed: 'Пропущен Full по расписанию',
  unknown: 'Мало точек, чтобы судить',
};

/** Missed Full days a row names before the earlier ones are only counted. */
const OWED_SHOWN = 3;

/** A row, with the section it belongs to and the order it goes in there. */
interface Row {
  section: Section;
  text: string;
  /** Compared element by element, smaller first. */
  rank: number[];
  name: string;
}

/**
 * Written into the title while the pages are fitted, then replaced by "1/3".
 * As long as what replaces it, so a page that fitted still fits.
 */
const PAGE_MARK = ' · 0/0';
const TITLE = `🗂 <b>Точки восстановления</b>${PAGE_MARK}`;

export const renderRestorePoints = (snapshot: RestorePointsSnapshot, clock: Clock): string[] => {
  const footer = footerOf(clock);

  if (snapshot.unavailable) {
    return [
      ['⚠️ <b>Точки восстановления не прочитаны</b>', '', escapeHtml(snapshot.unavailable), '', footer].join('\n'),
    ];
  }

  const rows = [
    ...snapshot.without.map((name): Row => ({ section: 'without', text: `🔴 <b>${escapeHtml(name)}</b>`, rank: [], name })),
    ...snapshot.jobs.flatMap((job) => {
      const row = rowOf(job, verdictOf(job, clock), clock);
      return row ? [row] : [];
    }),
  ].sort(
    (a, b) =>
      SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) ||
      byRank(a.rank, b.rank) ||
      a.name.localeCompare(b.name),
  );
  const inSection = new Map<Section, number>();
  for (const row of rows) inSection.set(row.section, (inSection.get(row.section) ?? 0) + 1);

  const total = snapshot.jobs.length + snapshot.without.length;
  const onTime = total - rows.length;
  const closingLines = [
    '',
    rows.length === 0
      ? total === 0
        ? 'Заданий, от которых ждут точек, нет.'
        : `🟢 <b>Все ${total} ${plural(total, 'задание', 'задания', 'заданий')} в порядке</b>`
      : onTime > 0
        ? `🟢 Остальные ${onTime} из ${total} — в порядке`
        : null,
    skippedLine(snapshot),
    total > 0 ? 'Подробнее о задании: /points имя' : null,
    '',
    footer,
  ].filter((line): line is string => line !== null);

  const pages = paged(rows.length, MAX_PAGES, (from, take, closing) => {
    const lines = [TITLE];
    let previous: Section | undefined;
    for (const row of rows.slice(from, from + take)) {
      // Every page opens with its heading, so a page read on its own still
      // says which part of the list it holds.
      if (row.section !== previous) {
        previous = row.section;
        lines.push('', `<b>${HEADING[previous]}</b> (${inSection.get(previous)})`);
      }
      lines.push(row.text);
    }
    if (!closing) return [...lines, '', footer].join('\n');

    const rest = rows.length - (from + take);
    if (rest > 0) lines.push('', `…и ещё ${rest} ${plural(rest, 'задание', 'задания', 'заданий')} — не поместились`);
    return [...lines, ...closingLines].join('\n');
  });

  return pages.map((page, index) =>
    page.replace(PAGE_MARK, pages.length > 1 ? ` · ${index + 1}/${pages.length}` : ''),
  );
};

/**
 * One line: what is wrong and the date to look up in Veeam.
 *
 * The newest point is a day and a minute rather than "5 дней назад": this is
 * the line somebody reads before opening Veeam, and a relative age has to be
 * turned back into a moment before it can be checked against anything.
 */
const rowOf = (job: JobDepth, verdict: PointVerdict, clock: Clock): Row | undefined => {
  const { missed, owed, standing } = verdict;
  if (standing === 'onTime') return undefined;
  const now = clock.now.getTime();
  const name = `${verdictIcon(verdict)} <b>${escapeHtml(job.name)}</b>`;
  const last = job.newest === undefined ? undefined : `последний бэкап ${momentOf(job.newest, clock)}`;
  const owedDays = owedDaysWords(owed, now, OWED_SHOWN);

  switch (standing) {
    case 'behind': {
      const facts = [
        missedRunsWords(missed ?? 0),
        last,
        // Behind outranks a missed Full, so it is said here or nowhere.
        owed.length > 0 ? `не сделан Full ${owedDays}` : undefined,
      ];
      // Most runs behind first, then the longest silent.
      return { section: standing, text: `${name} — ${joined(facts)}`, rank: [-(missed ?? 0), job.newest ?? 0], name: job.name };
    }
    case 'fullMissed': {
      const lastFull = job.chain?.lastFull;
      const facts = [
        `${plural(owed.length, 'пропущен', 'пропущены', 'пропущены')} ${owedDays}`,
        lastFull === undefined ? undefined : `последний Full ${dateOf(lastFull, clock)}`,
      ];
      // Most Fulls missed first: the chain the longest past its plan.
      return { section: standing, text: `${name} — ${joined(facts)}`, rank: [-owed.length], name: job.name };
    }
    case 'unknown': {
      const facts = [`${job.runs} ${plural(job.runs, 'точка', 'точки', 'точек')}`, last];
      // The longest silent first.
      return { section: standing, text: `${name} — ${joined(facts)}`, rank: [job.newest ?? 0], name: job.name };
    }
  }
};

const byRank = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

const joined = (facts: (string | undefined)[]): string =>
  facts.filter((fact): fact is string => fact !== undefined).join(' · ');

/**
 * Said out loud: a list that silently shrank would be worse than one that is
 * too long, because the reader would not know what is outside it.
 */
const skippedLine = (snapshot: RestorePointsSnapshot): string | null => {
  const skipped = [
    snapshot.excludedUnscheduled ? `${snapshot.excludedUnscheduled} без расписания` : undefined,
    snapshot.excludedDisabled ? `${snapshot.excludedDisabled} выключено` : undefined,
    snapshot.elsewhere ? `репликации и др. — ${snapshot.elsewhere}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return skipped.length > 0 ? `<i>Не проверяются: ${skipped.join(', ')}</i>` : null;
};
