import { escapeHtml } from '../telegram/format';
import { JobStanding, Standings } from '../estate/job-standing';
import { missedRunsWords, owedDaysWords, verdictOf } from '../estate/point-verdict';
import { dateOf, dayOf, everyLabel, footerOf, Clock, momentOf, paged, plural } from './format';

/**
 * "Is everything protected?" — the 🛡 slot.
 *
 * Every other alert in this service fires on a *transition*: a job that was
 * fine and now is not. That leaves the most dangerous case invisible — a job
 * sitting at `lastResult: Success` whose newest restore point is from June,
 * because the job simply stopped running. Nothing transitions, so nothing is
 * reported, and the gap is only found when somebody needs the restore. So this
 * slot asks of the restore points themselves.
 *
 * It used to be two topics. 🛡 said a job was past its deadline, 🗂 Restore
 * points that it had skipped runs or a scheduled Full, and the two said it of
 * the same job in different words: "3 дня без точки" in one, "пропущено 2
 * запуска" in the other. Now one list answers, a job once, with what is wrong
 * first and the facts to check it by under it.
 */

const DAY = 86_400_000;

/**
 * Messages this topic may occupy. On an ordinary day what needs somebody fits
 * in one; on a bad one — a repository gone and every job behind — the list
 * continues into further messages, each kept current like the first.
 */
const MAX_PAGES = 5;

/** Missed Full days a line names before the earlier ones are only counted. */
const OWED_SHOWN = 3;

export interface ProtectionThresholds {
  /** Floor, in days. Nothing fresher than this is ever reported as late. */
  staleDays: number;
  /**
   * How many of a job's own intervals it may miss before it counts as overdue.
   * A weekly job is not late after three days; a hourly one is.
   */
  overdueFactor: number;
  /**
   * Consecutive failed runs that make a job worth reporting on their own.
   * Runs, not sessions: a job with retries enabled produces several failed
   * sessions per failed run.
   */
  minStreak: number;
}

export interface ProtectionInput extends ProtectionThresholds {
  /** Which jobs are owed a restore point, and what each of them has. */
  standings: Standings;
  now: number;
  /** IANA zone the days a Full is owed on are counted in; empty for the server's own. */
  timezone?: string;
}

/**
 * What is wrong with a job, the worst first: no point at all, none for longer
 * than it may go, runs failing one after another while its point is still
 * fresh, a scheduled Full not taken while its backups go on.
 */
export type Trouble = 'none' | 'stale' | 'failing' | 'fullMissed';

export interface ProtectionRisk {
  name: string;
  type?: string;
  trouble: Trouble;
  /** 🔴 somebody should look today, 🟠 this week, 🟡 the chain is not as planned. */
  severity: 'critical' | 'warning' | 'notice';
  /** Judged by its good runs, its restore points being kept elsewhere. */
  byRuns?: boolean;
  /** Epoch ms of the newest restore point, when there is one. */
  lastPoint?: number;
  /** Days since the newest restore point; null when the job has none at all. */
  ageDays: number | null;
  /** The job's own typical interval in days, when it has enough history. */
  intervalDays: number | null;
  failures: number;
  lastRun?: string;
  /** Runs it is behind its own rhythm; absent when its rhythm or points are unknown. */
  missed?: number;
  /** The days a scheduled Full was owed and not taken, as `Date.UTC` midnights. */
  owed: number[];
  /** Epoch ms of the newest Full, where Veeam said which points are full. */
  lastFull?: number;
}

export interface ProtectionSnapshot extends ProtectionThresholds {
  risks: ProtectionRisk[];
  /** Jobs actually judged — excludes the ones below. */
  totalJobs: number;
  /** Jobs with a restore point inside their own expected interval. */
  protectedJobs: number;
  excludedDisabled: number;
  excludedUnscheduled: number;
  unavailable?: string;
}

/**
 * Decides which jobs need somebody, and why. Pure: the whole judgement can be
 * tested without a Veeam, a Telegram or a clock.
 */
export const assessProtection = (input: ProtectionInput): ProtectionSnapshot => {
  const { standings, now, staleDays, overdueFactor, minStreak } = input;
  const clock = { now: new Date(now), timezone: input.timezone ?? '' };
  const risks: ProtectionRisk[] = [];
  let protectedJobs = 0;

  for (const job of standings.judged) {
    const { runs: points, failures, cadenceDays: intervalDays } = job;
    const ageDays = points.length ? (now - points[0]) / DAY : null;

    // The deadline is the job's own schedule where it is known, but never
    // tighter than the configured floor: a job that runs hourly should not be
    // reported the moment it misses one run.
    const deadline = Math.max(staleDays, (intervalDays ?? staleDays) * overdueFactor);
    const overdue = ageDays === null || ageDays > deadline;
    // A failed attempt does not erase a usable restore point. The job is still
    // listed, but counted as protected while its point is fresh enough.
    if (!overdue) protectedJobs += 1;

    const verdict = pointsOf(job, clock);
    const owed = verdict?.owed ?? [];
    const trouble: Trouble | undefined =
      ageDays === null ? 'none'
      : overdue ? 'stale'
      : failures >= minStreak ? 'failing'
      : owed.length > 0 ? 'fullMissed'
      : undefined;
    if (!trouble) continue;

    risks.push({
      name: job.name,
      type: job.type,
      trouble,
      // "No restore point at all" and "twice past the deadline" are the two
      // cases where somebody should be looking today rather than this week.
      severity:
        trouble === 'fullMissed' ? 'notice'
        : ageDays === null || (overdue && ageDays > deadline * 2) ? 'critical'
        : 'warning',
      byRuns: job.byRuns,
      lastPoint: points.length ? points[0] : undefined,
      ageDays,
      intervalDays,
      failures,
      lastRun: job.lastRun,
      ...(verdict?.missed ? { missed: verdict.missed } : {}),
      owed,
      lastFull: job.depth?.chain?.lastFull,
    });
  }

  risks.sort(compareRisk);

  return {
    risks,
    totalJobs: standings.judged.length,
    protectedJobs,
    excludedDisabled: standings.excludedDisabled,
    excludedUnscheduled: standings.excludedUnscheduled,
    staleDays,
    overdueFactor,
    minStreak,
  };
};

/** Where the job's restore points stand by its rhythm and its Fulls; nothing for one judged by its runs. */
const pointsOf = (job: JobStanding, clock: Clock): ReturnType<typeof verdictOf> | undefined =>
  job.depth && !job.byRuns
    ? verdictOf({ ...job.depth, intervalDays: job.cadenceDays, retention: job.retention, fulls: job.fulls }, clock)
    : undefined;

const RANK: Record<ProtectionRisk['severity'], number> = { critical: 0, warning: 1, notice: 2 };

/** The worst first, then the longest without a backup, then by name. */
const compareRisk = (a: ProtectionRisk, b: ProtectionRisk): number => {
  const age = (risk: ProtectionRisk): number =>
    risk.ageDays === null ? Number.POSITIVE_INFINITY : risk.ageDays;
  return RANK[a.severity] - RANK[b.severity] || age(b) - age(a) || b.owed.length - a.owed.length || a.name.localeCompare(b.name);
};

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const ICON: Record<ProtectionRisk['severity'], string> = { critical: '🔴', warning: '🟠', notice: '🟡' };

/**
 * Written into the first line while the pages are fitted, then replaced by
 * "1/3". As long as what replaces it, so a page that fitted still fits.
 */
const PAGE_MARK = ' · 0/0';

export const renderProtection = (snapshot: ProtectionSnapshot, clock: Clock): string[] => {
  const footer = footerOf(clock);

  if (snapshot.unavailable) {
    return [['⚠️ <b>Защищённость не проверена</b>', '', escapeHtml(snapshot.unavailable), '', footer].join('\n')];
  }

  const { risks, totalJobs } = snapshot;
  const fine = totalJobs - risks.length;
  const closing = [
    '',
    risks.length === 0
      ? totalJobs === 0
        ? 'Заданий, от которых ждут точек, нет.'
        : `🟢 <b>${totalJobs === 1 ? 'Задание защищено' : `Все ${totalJobs} ${plural(totalJobs, 'задание', 'задания', 'заданий')} защищены`}</b>`
      : fine > 0
        ? `🟢 Остальные ${fine} — в порядке`
        : null,
    skippedLine(snapshot),
    totalJobs > 0 ? 'Подробнее о задании: /points имя' : null,
    '',
    footer,
  ].filter((line): line is string => line !== null);

  if (risks.length === 0) return [closing.slice(1).join('\n')];

  const worst = ICON[risks[0].severity];
  const title =
    `${worst} <b>${risks.length} ${plural(risks.length, 'задание', 'задания', 'заданий')} из ${totalJobs}` +
    ` ${plural(risks.length, 'требует', 'требуют', 'требуют')} внимания</b>${PAGE_MARK}`;

  const pages = paged(risks.length, MAX_PAGES, (from, take, last) => {
    const lines = [title];
    // A blank line around each job: two lines a job, run together, could not
    // be told apart.
    for (const risk of risks.slice(from, from + take)) lines.push('', ...riskLines(risk, clock));
    if (!last) return [...lines, '', footer].join('\n');
    const rest = risks.length - (from + take);
    if (rest > 0) lines.push('', `…и ещё ${rest} ${plural(rest, 'задание', 'задания', 'заданий')} — не поместились`);
    return [...lines, ...closing].join('\n');
  });

  return pages.map((page, index) =>
    page.replace(PAGE_MARK, pages.length > 1 ? ` · ${index + 1}/${pages.length}` : ''),
  );
};

/**
 * Two lines: what is wrong, and the facts to check it by — the newest point as
 * a day and a minute, the moment to look up in Veeam, rather than "5 дней
 * назад", which has to be turned back into a moment before it can be checked.
 */
const riskLines = (risk: ProtectionRisk, clock: Clock): string[] => {
  const now = clock.now.getTime();
  const name = `${ICON[risk.severity]} <b>${escapeHtml(risk.name)}</b>`;
  const streak = risk.failures > 0 ? streakWords(risk.failures) : undefined;
  const usually = risk.intervalDays !== null ? `обычно ${everyLabel(risk.intervalDays)}` : undefined;
  const last = risk.lastPoint === undefined ? undefined : momentOf(risk.lastPoint, clock);
  const owed = owedDaysWords(risk.owed, now, OWED_SHOWN);

  const [problem, facts] = ((): [string, (string | undefined)[]] => {
    switch (risk.trouble) {
      case 'none':
        // A replica's points are not in the list read, so "no points" would be
        // said of every replica whatever it did; what it lacks is a run that worked.
        return [
          risk.byRuns ? 'нет успешных запусков' : 'нет ни одной точки',
          [risk.lastRun ? `последний запуск ${dayOf(risk.lastRun, clock)}` : undefined, streak],
        ];
      case 'stale':
        return [
          `нет ${risk.byRuns ? 'успешного запуска' : 'бэкапа'} ${age(risk.ageDays ?? 0)}`,
          [
            last ? `последний ${last}` : undefined,
            usually,
            risk.missed ? missedRunsWords(risk.missed) : undefined,
            risk.owed.length > 0 ? `не сделан Full ${owed}` : undefined,
            streak,
          ],
        ];
      case 'failing':
        return [streak ?? '', [last ? `последний бэкап ${last}` : undefined, usually]];
      case 'fullMissed':
        return [
          `${plural(risk.owed.length, 'пропущен', 'пропущены', 'пропущены')} Full ${owed}`,
          ['бэкапы идут', risk.lastFull === undefined ? undefined : `последний Full ${dateOf(risk.lastFull, clock)}`],
        ];
    }
  })();

  const said = facts.filter((fact): fact is string => fact !== undefined);
  return said.length > 0 ? [`${name} — ${problem}`, `<i>${said.join(' · ')}</i>`] : [`${name} — ${problem}`];
};

/** "5 неудачных запусков подряд", or "1 неудачный запуск": one failure is not a streak. */
const streakWords = (failures: number): string => {
  const runs = `${failures} ${plural(failures, 'неудачный запуск', 'неудачных запуска', 'неудачных запусков')}`;
  return failures > 1 ? `${runs} подряд` : runs;
};

/**
 * Said out loud: a list that silently shrank would be worse than one that is
 * too long, because the reader would not know what is outside it.
 */
const skippedLine = (snapshot: ProtectionSnapshot): string | null => {
  const skipped = [
    snapshot.excludedUnscheduled ? `${snapshot.excludedUnscheduled} без расписания` : undefined,
    snapshot.excludedDisabled ? `${snapshot.excludedDisabled} выключено` : undefined,
  ].filter((part): part is string => part !== undefined);
  return skipped.length > 0 ? `<i>Не проверяются: ${skipped.join(', ')}</i>` : null;
};

/** Days, but readable when it is less than one. */
const age = (days: number): string => {
  if (days < 1) {
    const hours = Math.max(1, Math.round(days * 24));
    // 23.7 hours rounds to 24, which should read as a day rather than as a
    // second way of writing one.
    if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
    return '1 день';
  }
  const whole = Math.floor(days);
  return `${whole} ${plural(whole, 'день', 'дня', 'дней')}`;
};
